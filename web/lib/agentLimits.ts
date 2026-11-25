import "server-only";
import type { PoolClient } from "pg";
import { pool } from "./db";

/**
 * Sales Agent 사용량 제한 (DB 기준 — 서버리스에서 인스턴스마다 메모리가 따로라 메모리 카운터는 쓰지 않는다).
 * 숫자를 바꾸면 docs/agent/security.md도 함께 고친다.
 */
export const AGENT_LIMITS = {
  /** 사용자별 /api/agent·/api/assistant 요청 합계 (1분) */
  requestsPerMinute: 20,
  /** 요청 한 번에 만들 수 있는 실행 계획 */
  plansPerRequest: 5,
  /** 사용자별 승인 대기 계획 */
  pendingPlans: 20,
  /** 사용자별 메일·문서 발송 시도 (1시간, 실행된 것 기준 — 실패 포함) */
  sendsPerHour: 30,
  /** 이 기간이 지난 계획은 args·카드 내용을 지운다 (받는 사람 주소·메일 본문 등) */
  retentionDays: 90,
} as const;

/** 요청 1건 기록(1시간 지난 기록은 지움) → 최근 1분 요청 수가 한도를 넘었으면 안내 문구, 아니면 null */
export async function requestLimitError(userId: string): Promise<string | null> {
  // 같은 문장 안의 CTE 변경은 SELECT에 보이지 않으므로 방금 넣은 1건을 더한다
  const { rows } = await pool.query<{ n: number }>(
    `WITH del AS (DELETE FROM agent_requests WHERE user_id = $1 AND created_at < now() - interval '1 hour'),
          ins AS (INSERT INTO agent_requests (user_id) VALUES ($1))
     SELECT count(*)::int + 1 AS n FROM agent_requests WHERE user_id = $1 AND created_at > now() - interval '1 minute'`,
    [userId]
  );
  return rows[0].n > AGENT_LIMITS.requestsPerMinute
    ? `요청이 너무 많습니다. 1분에 ${AGENT_LIMITS.requestsPerMinute}번까지 요청할 수 있어요. 잠시 후 다시 시도하세요`
    : null;
}

/** 새 계획을 만들 수 없는 이유 (이번 요청에서 만든 수·승인 대기 수 확인). 만들 수 있으면 null */
export async function planQuotaError(userId: string, plannedThisRequest: number): Promise<string | null> {
  if (plannedThisRequest >= AGENT_LIMITS.plansPerRequest) {
    return `한 번에 만들 수 있는 실행 계획은 ${AGENT_LIMITS.plansPerRequest}개까지입니다. 먼저 승인하거나 나눠서 요청하세요`;
  }
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_actions
     WHERE user_id = $1 AND status = 'pending' AND created_at > now() - interval '1 hour'`,
    [userId]
  );
  return rows[0].n >= AGENT_LIMITS.pendingPlans
    ? `승인 대기 중인 계획이 ${AGENT_LIMITS.pendingPlans}개입니다. 먼저 승인하거나 취소하세요`
    : null;
}

/**
 * 최근 1시간 발송 시도(실행된 발송 도구, 실패 포함 — 발송 뒤 기록만 실패한 경우도 세도록) 수가
 * 한도에 닿았으면 안내 문구, 아니면 null
 */
export async function sendLimitError(client: PoolClient, userId: string, sendTools: string[]): Promise<string | null> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_actions
     WHERE user_id = $1 AND tool = ANY($2) AND executed_at > now() - interval '1 hour'`,
    [userId, sendTools]
  );
  return rows[0].n >= AGENT_LIMITS.sendsPerHour
    ? `메일·문서 발송은 1시간에 ${AGENT_LIMITS.sendsPerHour}건까지입니다. 잠시 후 다시 승인하세요`
    : null;
}

/**
 * 보관 기간이 지난 계획의 args·카드 내용 지우기 (도구·상태·사용자·시각·제목·결과 메시지·대상은 남긴다).
 * 계획을 저장할 때마다 부른다 — 지울 행이 없으면 부분 인덱스(agent_actions_created_idx)로 바로 끝난다
 */
export async function redactOldActions(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE agent_actions
     SET args = '{}'::jsonb,
         plan = jsonb_build_object('title', plan->'title', 'changes', '[]'::jsonb) || CASE WHEN plan ? 'target' THEN jsonb_build_object('target', plan->'target') ELSE '{}'::jsonb END,
         redacted_at = now()
     WHERE redacted_at IS NULL AND created_at < now() - make_interval(days => $1)`,
    [AGENT_LIMITS.retentionDays]
  );
  return rowCount ?? 0;
}
