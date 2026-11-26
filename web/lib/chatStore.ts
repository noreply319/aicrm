import "server-only";
import { loadPlans } from "./agent";
import type { AgentSource } from "./agentToolKit";
import { pool } from "./db";
import { withTransaction } from "./events";
import type { AgentMessage, AgentPlan, AgentStep, ChatMessage, ConversationDetail, ConversationSummary } from "./types";
import { UUID_RE } from "./validate";

/**
 * AI Assistant 대화 기록 (chat_conversations·chat_messages). 사용자 본인 것만 읽고 쓴다.
 * source는 대화를 만든 화면(통합 전 Sales Agent 대화는 agent) — 목록·이어 쓰기는 source와 관계없이 하나로 본다.
 * 답변이 끝나면 서버가 질문·답변을 한 번에 저장한다 (화면을 닫거나 멈춰도 답변은 저장된다).
 * 계획 카드는 승인 상태가 바뀌므로 id만 저장하고 불러올 때 agent_actions에서 지금 상태로 읽는다.
 * 저장하지 않는 계획(메일 초안 카드)은 카드 내용을 그대로 저장한다.
 */

const LIST_LIMIT = 50;
const TITLE_MAX = 40;

/** 저장할 계획: 승인 계획은 id만, 초안은 카드 그대로 */
type StoredPlanRef = { id: string } | AgentPlan;

interface ConversationRow {
  id: string;
  title: string;
  updatedAt: Date;
}

const toSummary = (r: ConversationRow): ConversationSummary => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() });

/** 첫 질문으로 대화 제목 (한 줄, 최대 40자) */
export function conversationTitle(question: string): string {
  const line = question.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line || "새 대화";
}

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const { rows } = await pool.query<ConversationRow>(
    `SELECT id, title, updated_at AS "updatedAt" FROM chat_conversations
     WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${LIST_LIMIT}`,
    [userId]
  );
  return rows.map(toSummary);
}

/** 본인 대화인지 확인 */
export async function findConversation(userId: string, id: string): Promise<ConversationSummary | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query<ConversationRow>(
    `SELECT id, title, updated_at AS "updatedAt" FROM chat_conversations WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] ? toSummary(rows[0]) : null;
}

export async function createConversation(userId: string, source: AgentSource, title: string): Promise<ConversationSummary> {
  const { rows } = await pool.query<ConversationRow>(
    `INSERT INTO chat_conversations (user_id, source, title) VALUES ($1, $2, $3) RETURNING id, title, updated_at AS "updatedAt"`,
    [userId, source, title]
  );
  return toSummary(rows[0]);
}

/** 대화 + 메시지. 계획 카드는 지금 승인 상태로 (다른 기기에서 승인했으면 완료로 보인다) */
export async function getConversation(userId: string, id: string): Promise<ConversationDetail | null> {
  const conv = await findConversation(userId, id);
  if (!conv) return null;
  const { rows } = await pool.query<{ id: string; role: "user" | "assistant"; content: string; steps: AgentStep[]; plans: StoredPlanRef[]; error: string | null }>(
    "SELECT m.id::text AS id, m.role, m.content, m.steps, m.plans, m.error FROM chat_messages m WHERE m.conversation_id = $1 ORDER BY m.id",
    [id]
  );
  const ids = rows.flatMap((r) => r.plans.filter((p) => !("status" in p)).map((p) => p.id));
  const current = await loadPlans(userId, ids);
  const messages: AgentMessage[] = rows.map((r) => {
    const plans = r.plans.flatMap((p) => ("status" in p ? [p] : current.has(p.id) ? [current.get(p.id)!] : []));
    return {
      id: `s${r.id}`,
      role: r.role,
      content: r.content,
      ...(r.steps.length ? { steps: r.steps } : {}),
      ...(plans.length ? { plans } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  });
  return { ...conv, messages };
}

/** AI에 보낼 대화 기록 원본: 저장된 질문·답변 (내용이 있는 것만, 오래된 순) */
export async function loadHistory(conversationId: string): Promise<ChatMessage[]> {
  const { rows } = await pool.query<ChatMessage>(
    "SELECT role, content FROM chat_messages WHERE conversation_id = $1 AND content <> '' ORDER BY id",
    [conversationId]
  );
  return rows;
}

/** 질문 + 답변(답변 내용·진행 단계·계획 카드·오류)을 한 번에 저장하고 대화를 맨 위로 */
export async function saveTurn(
  conversationId: string,
  question: string,
  answer: { content: string; steps: AgentStep[]; plans: AgentPlan[]; error?: string }
): Promise<void> {
  // 진행 중으로 끝난 단계는 저장하지 않는다 (불러왔을 때 계속 진행 중으로 보이지 않게)
  const steps = answer.steps.filter((s) => s.status !== "running");
  const plans: StoredPlanRef[] = answer.plans.map((p) => (p.status === "draft" ? p : { id: p.id }));
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
      [conversationId, question]
    );
    await client.query(
      `INSERT INTO chat_messages (conversation_id, role, content, steps, plans, error) VALUES ($1, 'assistant', $2, $3, $4, $5)`,
      [conversationId, answer.content, JSON.stringify(steps), JSON.stringify(plans), answer.error ?? null]
    );
    await client.query("UPDATE chat_conversations SET updated_at = now() WHERE id = $1", [conversationId]);
  });
}

/** 승인 뒤 이어서 제안한 계획(예: 견적서 발송 → 단계 이동)을 원래 계획이 있는 메시지에 붙인다 */
export async function attachFollowUps(userId: string, parentPlanId: string, followUpIds: string[]): Promise<void> {
  if (followUpIds.length === 0 || !UUID_RE.test(parentPlanId)) return;
  await pool.query(
    `UPDATE chat_messages m SET plans = m.plans || $3::jsonb
     FROM chat_conversations c
     WHERE m.conversation_id = c.id AND c.user_id = $1 AND m.plans @> jsonb_build_array(jsonb_build_object('id', $2::text))`,
    [userId, parentPlanId, JSON.stringify(followUpIds.map((id) => ({ id })))]
  );
}

export async function deleteConversation(userId: string, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const { rowCount } = await pool.query("DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2", [id, userId]);
  return Boolean(rowCount);
}
