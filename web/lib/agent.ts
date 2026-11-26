import "server-only";
import { randomUUID } from "node:crypto";
import type { AgentSource, PreparedPlan } from "./agentToolKit";
import { planQuotaError, redactOldActions, sendLimitError } from "./agentLimits";
import { AGENT_TOOLS } from "./agentTools";
import { ASSISTANT_TOOL_LABELS, prepareAssistant, toolDetail } from "./assistant";
import type { SessionUser } from "./auth";
import { pool } from "./db";
import { withTransaction } from "./events";
import { chatWithTools } from "./openai";
import type { AgentEvent, AgentPlan, AgentPlanStatus, AgentStep, ChatMessage } from "./types";
import { UUID_RE } from "./validate";

/**
 * AI Assistant 실행 엔진 (예전 Sales Agent와 통합 — 모든 도구를 쓴다).
 * 1) runAgent: 조회 도구는 바로 실행, 변경 도구는 agent_actions에 계획(pending)으로 저장하고 plan 이벤트를 보낸다.
 *    모델에는 "승인 대기"를 돌려줘 다음 라운드에서 안내 문장을 쓰게 한다.
 * 2) decideAction: 요청한 본인만 승인/취소. 행을 잠그고 상태·만료·변경 충돌을 확인한 뒤 같은 트랜잭션에서 실행한다.
 */

/** 발송 도구 이름 (시간당 발송 수 제한) */
const SEND_TOOLS = Object.values(AGENT_TOOLS).filter((t) => t.kind === "write" && t.sends).map((t) => t.def.name);

/** 계획을 승인할 수 있는 시간 (시간 단위) */
const PLAN_TTL_HOURS = 1;
// 조회 후 계획까지 여러 번 도구를 쓸 수 있게 Assistant(3)보다 넉넉히
const MAX_ROUNDS = 5;

type StoredPlan = Pick<AgentPlan, "title" | "changes" | "target" | "danger" | "approveLabel" | "notice">;

interface ActionRow {
  id: string;
  tool: string;
  source: AgentSource;
  args: Record<string, unknown>;
  plan: StoredPlan;
  status: Exclude<AgentPlanStatus, "running">;
  message: string;
  expired: boolean;
}

const ACTION_COLUMNS = `id, tool, source, args, plan, status, message, created_at < now() - interval '${PLAN_TTL_HOURS} hours' AS expired`;

const toPlan = (r: Pick<ActionRow, "id" | "plan" | "status" | "message">): AgentPlan => ({
  id: r.id,
  ...r.plan,
  status: r.status,
  ...(r.message ? { message: r.message } : {}),
});

const storedPlan = (p: PreparedPlan): StoredPlan => ({
  title: p.title, changes: p.changes, target: p.target, danger: p.danger, approveLabel: p.approveLabel, notice: p.notice,
});

/**
 * 저장된 대화의 계획 카드를 지금 상태로 다시 읽는다 (본인 계획만).
 * 승인 대기인데 승인 기한이 지났으면 실패로 보여준다 (승인해도 만료로 끝나므로).
 */
export async function loadPlans(userId: string, ids: string[]): Promise<Map<string, AgentPlan>> {
  const valid = ids.filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return new Map();
  const { rows } = await pool.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM agent_actions WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, valid]);
  return new Map(
    rows.map((r) => [
      r.id,
      r.status === "pending" && r.expired
        ? toPlan({ ...r, status: "failed", message: `계획이 만료되었습니다 (${PLAN_TTL_HOURS}시간). 다시 요청하세요` })
        : toPlan(r),
    ])
  );
}

/** 계획 저장 (pending) → 화면에 보낼 AgentPlan */
export async function savePlan(userId: string, tool: string, p: PreparedPlan, source: AgentSource = "assistant"): Promise<AgentPlan> {
  await redactOldActions().catch((e: unknown) => console.error("[agent] redact", e));
  const plan = storedPlan(p);
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO agent_actions (user_id, tool, args, plan, source) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [userId, tool, JSON.stringify(p.args), JSON.stringify(plan), source]
  );
  return toPlan({ id: rows[0].id, plan, status: "pending", message: "" });
}

const PENDING_NOTE = "사용자 승인 대기 중입니다. 아직 실행되지 않았습니다. 계획 카드를 확인하고 승인하도록 안내하세요.";

/**
 * 대화 → 진행 단계·답변·실행 계획 이벤트.
 * source: 계획·이력에 남길 출처 (지금은 assistant만. agent는 통합 전 Sales Agent 기록)
 */
export async function runAgent(
  messages: ChatMessage[], user: SessionUser, emit: (e: AgentEvent) => void, source: AgentSource = "assistant"
): Promise<void> {
  const context: AgentStep = { id: "context", label: "CRM 데이터 확인", status: "running" };
  emit({ type: "step", step: context });
  const session = await prepareAssistant(messages, user).catch((e: unknown) => {
    emit({ type: "step", step: { ...context, status: "failed" } });
    throw e;
  });
  emit({ type: "step", step: { ...context, status: "done" } });

  // 한 번의 요청에서 같은 계획을 두 번 만들지 않는다
  const planned = new Map<string, string>();

  const runTool = async (name: string, args: unknown): Promise<unknown> => {
    const tool = AGENT_TOOLS[name];
    if (!tool) return session.runTool(name, args);
    const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    if (tool.kind === "read") return tool.run(a, user.id);

    const prepared = await tool.prepare(a, user.id);
    if ("error" in prepared) return { error: prepared.error };
    if (prepared.draft) {
      // 초안은 저장하지 않고 카드로만 보여준다
      emit({ type: "plan", plan: { id: randomUUID(), ...storedPlan(prepared), status: "draft" } });
      return { status: "draft_shown", note: "초안을 카드로 보여줬습니다. 보내려면 사용자의 확인을 받은 뒤 같은 내용으로 발송 도구를 호출하세요." };
    }
    const key = `${name}:${JSON.stringify(prepared.args)}`;
    const existing = planned.get(key);
    if (existing) return { status: "pending_approval", planId: existing, note: "이미 같은 계획을 만들었습니다. " + PENDING_NOTE };
    const quota = await planQuotaError(user.id, planned.size);
    if (quota) return { error: quota };
    const plan = await savePlan(user.id, name, prepared, source);
    planned.set(key, plan.id);
    emit({ type: "plan", plan });
    return { status: "pending_approval", planId: plan.id, note: PENDING_NOTE };
  };

  // 도구 호출마다 진행 단계 표시
  let stepNo = 0;
  const label = (name: string) => {
    const t = AGENT_TOOLS[name];
    return t ? (t.kind === "write" ? `실행 계획 작성: ${t.label}` : t.label) : (ASSISTANT_TOOL_LABELS[name] ?? name);
  };
  const tracked = async (name: string, args: unknown) => {
    const step: AgentStep = { id: `tool-${++stepNo}`, label: label(name), status: "running" };
    emit({ type: "step", step });
    try {
      const result = await runTool(name, args);
      emit({ type: "step", step: { ...step, status: "done", detail: toolDetail(result) } });
      return result;
    } catch (e) {
      emit({ type: "step", step: { ...step, status: "failed" } });
      throw e;
    }
  };

  const tools = [...session.tools, ...Object.values(AGENT_TOOLS).map((t) => t.def)];
  const reply = await chatWithTools(session.chat, tools, tracked, { maxTokens: 1500, maxRounds: MAX_ROUNDS, timeoutMs: 30_000 });
  emit({ type: "reply", content: reply });
}

export type DecideResult = { ok: true; plan: AgentPlan; followUps?: AgentPlan[] } | { ok: false; status: number; error: string };

/** 실행 계획 승인/취소 (요청한 본인만, 한 번만). 커밋 후 후속 작업(after)이 있으면 실행하고 결과를 메시지에 덧붙인다 */
export async function decideAction(id: string, userId: string, action: "approve" | "cancel"): Promise<DecideResult> {
  if (!UUID_RE.test(id)) return { ok: false, status: 404, error: "실행 계획을 찾을 수 없습니다" };

  let after: (() => Promise<string | undefined>) | undefined;
  let next: { tool: string; args: Record<string, unknown> }[] = [];
  let source: AgentSource = "assistant";
  const result = await withTransaction(async (client): Promise<DecideResult> => {
    // 동시에 두 번 승인해도 한 번만 실행되도록 행을 잠근다
    const row = (
      await client.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM agent_actions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId])
    ).rows[0];
    // 다른 사람의 계획은 있는지조차 알리지 않는다
    if (!row) return { ok: false, status: 404, error: "실행 계획을 찾을 수 없습니다" };
    if (row.status !== "pending") return { ok: false, status: 409, error: "이미 처리된 계획입니다" };

    /** 결과 저장. executed: 도구를 실행했으면 실행 시각·결과(대상)도 남긴다 (감사 기록) */
    const finish = async (status: ActionRow["status"], message: string, plan: StoredPlan = row.plan, executed = false): Promise<DecideResult> => {
      await client.query(
        `UPDATE agent_actions SET status=$2, message=$3, plan=$4, decided_at=now(),
                executed_at = CASE WHEN $5 THEN now() ELSE executed_at END,
                result = CASE WHEN $5 THEN $6::jsonb ELSE result END
         WHERE id=$1`,
        [id, status, message, JSON.stringify(plan), executed, JSON.stringify({ ok: status === "done", ...(plan.target ? { target: plan.target } : {}) })]
      );
      return { ok: true, plan: toPlan({ id, plan, status, message }) };
    };

    if (action === "cancel") return finish("canceled", "취소했습니다");
    if (row.expired) return finish("failed", `계획이 만료되었습니다 (${PLAN_TTL_HOURS}시간). 다시 요청하세요`);

    const tool = AGENT_TOOLS[row.tool];
    if (!tool || tool.kind !== "write" || !tool.execute) return finish("failed", "지원하지 않는 작업입니다");
    // 발송 한도: 넘으면 실행하지 않고 승인 대기로 둔다 (나중에 다시 승인)
    const sendLimit = tool.sends ? await sendLimitError(client, userId, SEND_TOOLS) : null;
    if (sendLimit) return { ok: false, status: 429, error: sendLimit };
    const r = await tool.execute(client, userId, row.args, { meta: { via: row.source } });
    if (!r.ok) return finish("failed", r.message, row.plan, true);
    after = r.after;
    source = row.source;
    next = r.next ?? [];
    // 실행에 성공하면 대상 링크를 결과로 바꾼다 (삭제는 링크 없음)
    return finish("done", r.message, { ...row.plan, target: r.target }, true);
  });

  if (!result.ok) return result;
  let plan = result.plan;
  if (after) {
    // 후속 작업은 실패해도 실행 결과(done)는 그대로 두고 안내만 덧붙인다
    const extra = await after().catch((e: unknown) => {
      console.error("[agent] after", e);
      return "후속 작업은 실패했습니다";
    });
    if (extra) {
      plan = { ...plan, message: `${plan.message ?? ""} · ${extra}` };
      await pool.query("UPDATE agent_actions SET message=$2 WHERE id=$1", [id, plan.message]);
    }
  }
  // 이어서 제안할 계획: 지금 값으로 다시 prepare (해당 없으면 만들지 않음)
  const followUps: AgentPlan[] = [];
  for (const n of next) {
    const t = AGENT_TOOLS[n.tool];
    if (t?.kind !== "write") continue;
    // 후속 계획은 제안일 뿐이라 만들지 못해도 실행 결과(done)는 그대로 돌려준다
    try {
      const p = await t.prepare(n.args, userId);
      if (!("error" in p)) followUps.push(await savePlan(userId, n.tool, p, source));
    } catch (e) {
      console.error("[agent] follow-up", e);
    }
  }
  if (followUps.length) {
    await pool.query("UPDATE agent_actions SET result = coalesce(result, '{}'::jsonb) || $2::jsonb WHERE id=$1", [
      id, JSON.stringify({ followUpIds: followUps.map((f) => f.id) }),
    ]);
  }
  return { ok: true, plan, ...(followUps.length ? { followUps } : {}) };
}
