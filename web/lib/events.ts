import "server-only";
import type { PoolClient } from "pg";
import { pool } from "./db";
import type { Lead, LeadInput } from "./types";

export type LeadEventType = "created" | "updated" | "moved" | "deleted";

export type FieldChange = { from: unknown; to: unknown };

/** AI Assistant 컨텍스트로 쓰는 이력 행 */
export interface LeadEvent {
  leadId: string;
  company: string;
  type: LeadEventType;
  changes: Record<string, unknown>;
  createdAt: string; // ISO
}

// 변경 이력으로 비교할 필드 (position 등 내부 값은 제외)
const TRACKED_FIELDS = [
  "company", "contact", "title", "email", "phone", "value",
  "closeDate", "stage", "priority", "notes",
] as const satisfies readonly (keyof LeadInput)[];

/** 수정 전/후 리드를 비교해 바뀐 필드만 { field: { from, to } }로 반환 */
export function diffLead(before: Lead, after: LeadInput): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  for (const f of TRACKED_FIELDS) {
    if (before[f] !== after[f]) changes[f] = { from: before[f], to: after[f] };
  }
  return changes;
}

/** 리드의 주요 값 스냅샷 (생성/삭제 이벤트용) */
export function snapshot(l: LeadInput): Record<string, unknown> {
  return {
    contact: l.contact, title: l.title, value: l.value, closeDate: l.closeDate,
    stage: l.stage, priority: l.priority,
  };
}

/** 이벤트 기록. 리드 변경과 같은 트랜잭션의 client로 호출한다. */
export async function recordEvent(
  client: PoolClient,
  leadId: string,
  company: string,
  type: LeadEventType,
  changes: Record<string, unknown>
) {
  await client.query(
    "INSERT INTO lead_events (lead_id, company, type, changes) VALUES ($1, $2, $3, $4)",
    [leadId, company, type, JSON.stringify(changes)]
  );
}

/** 트랜잭션 헬퍼: 성공 시 COMMIT, 예외 시 ROLLBACK */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
