import "server-only";
import { AGENT_TOOLS, type PreparedPlan } from "./agentTools";
import { ASSISTANT_TOOL_LABELS, prepareAssistant, toolDetail } from "./assistant";
import type { SessionUser } from "./auth";
import { pool } from "./db";
import { withTransaction } from "./events";
import { chatWithTools } from "./openai";
import type { AgentEvent, AgentPlan, AgentPlanStatus, AgentStep, ChatMessage } from "./types";
import { UUID_RE } from "./validate";

/**
 * Sales Agent 실행 엔진.
 * 1) runAgent: 조회 도구는 바로 실행, 변경 도구는 agent_actions에 계획(pending)으로 저장하고 plan 이벤트를 보낸다.
 *    모델에는 "승인 대기"를 돌려줘 다음 라운드에서 안내 문장을 쓰게 한다.
 * 2) decideAction: 요청한 본인만 승인/취소. 행을 잠그고 상태·만료·변경 충돌을 확인한 뒤 같은 트랜잭션에서 실행한다.
 */

/** 계획을 승인할 수 있는 시간 (시간 단위) */
const PLAN_TTL_HOURS = 1;
// 조회 후 계획까지 여러 번 도구를 쓸 수 있게 Assistant(3)보다 넉넉히
const MAX_ROUNDS = 5;

type StoredPlan = Pick<AgentPlan, "title" | "changes" | "target" | "danger" | "affectsLeads">;

interface ActionRow {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  plan: StoredPlan;
  status: Exclude<AgentPlanStatus, "running">;
  message: string;
  expired: boolean;
}

const ACTION_COLUMNS = `id, tool, args, plan, status, message, created_at < now() - interval '${PLAN_TTL_HOURS} hours' AS expired`;

const toPlan = (r: Pick<ActionRow, "id" | "plan" | "status" | "message">): AgentPlan => ({
  id: r.id,
  ...r.plan,
  status: r.status,
  ...(r.message ? { message: r.message } : {}),
});

/** 계획 저장 (pending) → 화면에 보낼 AgentPlan */
export async function savePlan(userId: string, tool: string, p: PreparedPlan): Promise<AgentPlan> {
  const plan: StoredPlan = { title: p.title, changes: p.changes, target: p.target, danger: p.danger, affectsLeads: p.affectsLeads };
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO agent_actions (user_id, tool, args, plan) VALUES ($1, $2, $3, $4) RETURNING id",
    [userId, tool, JSON.stringify(p.args), JSON.stringify(plan)]
  );
  return toPlan({ id: rows[0].id, plan, status: "pending", message: "" });
}

const PENDING_NOTE = "사용자 승인 대기 중입니다. 아직 실행되지 않았습니다. 계획 카드를 확인하고 승인하도록 안내하세요.";

/** 대화 → 진행 단계·답변·실행 계획 이벤트 */
export async function runAgent(messages: ChatMessage[], user: SessionUser, emit: (e: AgentEvent) => void): Promise<void> {
  const context: AgentStep = { id: "context", label: "CRM 데이터 확인", status: "running" };
  emit({ type: "step", step: context });
  const session = await prepareAssistant(messages, user, "agent").catch((e: unknown) => {
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
    if (tool.kind === "read") return tool.run(a);

    const prepared = await tool.prepare(a);
    if ("error" in prepared) return { error: prepared.error };
    const key = `${name}:${JSON.stringify(prepared.args)}`;
    const existing = planned.get(key);
    if (existing) return { status: "pending_approval", planId: existing, note: "이미 같은 계획을 만들었습니다. " + PENDING_NOTE };
    const plan = await savePlan(user.id, name, prepared);
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

export type DecideResult = { ok: true; plan: AgentPlan } | { ok: false; status: number; error: string };

/** 실행 계획 승인/취소 (요청한 본인만, 한 번만) */
export async function decideAction(id: string, userId: string, action: "approve" | "cancel"): Promise<DecideResult> {
  if (!UUID_RE.test(id)) return { ok: false, status: 404, error: "실행 계획을 찾을 수 없습니다" };

  return withTransaction(async (client): Promise<DecideResult> => {
    // 동시에 두 번 승인해도 한 번만 실행되도록 행을 잠근다
    const row = (
      await client.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM agent_actions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId])
    ).rows[0];
    // 다른 사람의 계획은 있는지조차 알리지 않는다
    if (!row) return { ok: false, status: 404, error: "실행 계획을 찾을 수 없습니다" };
    if (row.status !== "pending") return { ok: false, status: 409, error: "이미 처리된 계획입니다" };

    const finish = async (status: ActionRow["status"], message: string, plan: StoredPlan = row.plan): Promise<DecideResult> => {
      await client.query("UPDATE agent_actions SET status=$2, message=$3, plan=$4, decided_at=now() WHERE id=$1", [
        id, status, message, JSON.stringify(plan),
      ]);
      return { ok: true, plan: toPlan({ id, plan, status, message }) };
    };

    if (action === "cancel") return finish("canceled", "취소했습니다");
    if (row.expired) return finish("failed", `계획이 만료되었습니다 (${PLAN_TTL_HOURS}시간). 다시 요청하세요`);

    const tool = AGENT_TOOLS[row.tool];
    if (!tool || tool.kind !== "write") return finish("failed", "지원하지 않는 작업입니다");
    const result = await tool.execute(client, userId, row.args);
    // 실행에 성공하면 대상 링크를 결과로 바꾼다 (삭제는 링크 없음). 실패면 계획 카드 그대로
    return result.ok
      ? finish("done", result.message, { ...row.plan, target: result.target })
      : finish("failed", result.message);
  });
}
