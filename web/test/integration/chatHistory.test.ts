import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 로그인 사용자는 가짜로 (세션·프록시 헤더 대신)
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", async (orig) => {
  const actual = await orig<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getSessionUser: async () => (auth.userId ? actual.findUserById(auth.userId) : null),
    requestUserId: async () => auth.userId,
  };
});

import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { POST as ASSISTANT } from "@/app/api/assistant/route";
import { POST as APPROVE } from "@/app/api/agent/actions/[id]/approve/route";
import { GET as LIST } from "@/app/api/conversations/route";
import { DELETE as DELETE_CONV, GET as GET_CONV } from "@/app/api/conversations/[id]/route";
import { savePlan } from "@/lib/agent";
import { AGENT_TOOLS } from "@/lib/agentTools";
import { attachFollowUps, createConversation, saveTurn } from "@/lib/chatStore";
import { pool } from "@/lib/db";
import type { AgentEvent, ConversationDetail, ConversationSummary, Lead } from "@/lib/types";
import { closeDb, ctx, leadInput, req, resetDb } from "./helpers";

/** AI Assistant·Sales Agent 대화 기록: 저장 → 다른 기기(같은 사용자)에서 목록·대화 불러오기, 본인 것만 */

const ME = "00000000-0000-4000-8000-0000000000c7";
const OTHER = "00000000-0000-4000-8000-0000000000c8";

beforeEach(async () => {
  await resetDb();
  process.env.OPENAI_API_KEY = "test-key";
  for (const [id, sub] of [[ME, "chat-me"], [OTHER, "chat-other"]]) {
    await pool.query(
      `INSERT INTO users (id, google_sub, email, name) VALUES ($1, $2, $3, $2) ON CONFLICT (id) DO NOTHING`,
      [id, sub, `${sub}@test.local`]
    );
  }
  auth.userId = ME;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

const lead = async (over = {}) => (await (await CREATE_LEAD(req("POST", leadInput(over)))).json()) as Lead;

/** OpenAI 응답 흉내 (마지막 응답은 계속 반복) */
function fakeOpenAi(replies: unknown[]) {
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const message = replies[Math.min(n++, replies.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }));
}
const toolCall = (name: string, args: unknown) => ({
  content: null,
  tool_calls: [{ id: "c0", type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

/** 스트림을 끝까지 읽어 이벤트 목록으로 */
async function ask(body: unknown): Promise<{ status: number; events: AgentEvent[] }> {
  const res = await ASSISTANT(req("POST", body));
  if (!res.ok) return { status: res.status, events: [] };
  const text = await res.text();
  return { status: res.status, events: text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as AgentEvent) };
}
const conversationOf = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "conversation" ? [e.conversation] : []))[0];
const getConv = async (id: string) => GET_CONV(req("GET"), ctx(id));

describe("대화 기록", () => {
  it("질문하면 새 대화를 만들어 질문·답변을 저장하고, 같은 대화로 이어 쓴다", async () => {
    fakeOpenAi([{ content: "파이프라인은 ₩0입니다" }]);
    const first = await ask({ messages: [{ role: "user", content: "파이프라인 합계는?" }] });
    const conv = conversationOf(first.events);
    expect(conv).toMatchObject({ title: "파이프라인 합계는?" });

    fakeOpenAi([{ content: "이번 주 리드는 없습니다" }]);
    await ask({
      conversationId: conv.id,
      messages: [
        { role: "user", content: "파이프라인 합계는?" },
        { role: "assistant", content: "파이프라인은 ₩0입니다" },
        { role: "user", content: "이번 주 리드는?" },
      ],
    });

    // 다른 기기: 목록 → 대화 열기
    const list = (await (await LIST(req("GET", undefined, "http://test.local/api?source=assistant"))).json()) as ConversationSummary[];
    expect(list.map((c) => c.id)).toEqual([conv.id]);
    const detail = (await (await getConv(conv.id)).json()) as ConversationDetail;
    expect(detail.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "파이프라인 합계는?"],
      ["assistant", "파이프라인은 ₩0입니다"],
      ["user", "이번 주 리드는?"],
      ["assistant", "이번 주 리드는 없습니다"],
    ]);
    // Sales Agent 목록에는 없다 (화면별로 따로)
    expect(await (await LIST(req("GET", undefined, "http://test.local/api?source=agent"))).json()).toEqual([]);
  });

  it("계획 카드는 id로 저장하고, 불러올 때 지금 승인 상태로 (다른 기기에서 승인한 결과)", async () => {
    const l = await lead({ company: "에이스상사", stage: "qualified" });
    fakeOpenAi([toolCall("move_lead_stage", { leadId: l.id, stage: "negotiation" }), { content: "승인하면 반영됩니다." }]);
    const { events } = await ask({ messages: [{ role: "user", content: "에이스상사 협상으로" }] });
    const conv = conversationOf(events);
    const plan = events.flatMap((e) => (e.type === "plan" ? [e.plan] : []))[0];

    let detail = (await (await getConv(conv.id)).json()) as ConversationDetail;
    expect(detail.messages[1].plans).toMatchObject([{ id: plan.id, status: "pending", title: "리드 단계 이동" }]);
    expect(detail.messages[1].steps?.every((s) => s.status !== "running")).toBe(true);

    await APPROVE(req("POST"), ctx(plan.id));
    detail = (await (await getConv(conv.id)).json()) as ConversationDetail;
    expect(detail.messages[1].plans).toMatchObject([{ id: plan.id, status: "done", message: "협상 단계로 옮겼습니다" }]);
  });

  it("승인 기한이 지난 계획은 실패(만료)로 보여준다", async () => {
    const l = await lead({ stage: "new" });
    const t = AGENT_TOOLS.move_lead_stage;
    if (t.kind !== "write") throw new Error("write tool");
    const prepared = await t.prepare({ leadId: l.id, stage: "contacted" }, ME);
    if ("error" in prepared) throw new Error(prepared.error);
    const plan = await savePlan(ME, "move_lead_stage", prepared, "assistant");
    const conv = await createConversation(ME, "assistant", "만료 테스트");
    await saveTurn(conv.id, "옮겨줘", { content: "계획입니다", steps: [], plans: [plan] });
    await pool.query("UPDATE agent_actions SET created_at = now() - interval '2 hours' WHERE id = $1", [plan.id]);

    const detail = (await (await getConv(conv.id)).json()) as ConversationDetail;
    expect(detail.messages[1].plans).toMatchObject([{ id: plan.id, status: "failed", message: expect.stringContaining("만료") }]);
  });

  it("초안 카드는 그대로 저장, 이어서 제안한 계획은 원래 메시지에 붙는다", async () => {
    const l = await lead({ stage: "new" });
    const t = AGENT_TOOLS.move_lead_stage;
    if (t.kind !== "write") throw new Error("write tool");
    const prepared = await t.prepare({ leadId: l.id, stage: "contacted" }, ME);
    if ("error" in prepared) throw new Error(prepared.error);
    const parent = await savePlan(ME, "move_lead_stage", prepared, "agent");
    const draft = { id: "draft-1", title: "메일 초안", changes: [{ field: "제목", after: "안녕하세요" }], status: "draft" as const };
    const conv = await createConversation(ME, "agent", "후속 테스트");
    await saveTurn(conv.id, "메일 써줘", { content: "", steps: [], plans: [draft, parent] });

    const prepared2 = await t.prepare({ leadId: l.id, stage: "qualified" }, ME);
    if ("error" in prepared2) throw new Error(prepared2.error);
    const follow = await savePlan(ME, "move_lead_stage", prepared2, "agent");
    await attachFollowUps(ME, parent.id, [follow.id]);
    await attachFollowUps(OTHER, parent.id, [parent.id]); // 다른 사용자는 붙이지 못한다

    const detail = (await (await getConv(conv.id)).json()) as ConversationDetail;
    expect(detail.messages[1].plans?.map((p) => p.id)).toEqual(["draft-1", parent.id, follow.id]);
    expect(detail.messages[1].plans?.[0]).toMatchObject({ status: "draft", title: "메일 초안" });
  });

  it("다른 사용자의 대화는 목록·열기·이어 쓰기·삭제 모두 안 된다", async () => {
    const conv = await createConversation(ME, "assistant", "내 대화");
    auth.userId = OTHER;
    expect(await (await LIST(req("GET", undefined, "http://test.local/api?source=assistant"))).json()).toEqual([]);
    expect((await getConv(conv.id)).status).toBe(404);
    expect((await DELETE_CONV(req("DELETE"), ctx(conv.id))).status).toBe(404);
    fakeOpenAi([{ content: "x" }]);
    expect((await ask({ conversationId: conv.id, messages: [{ role: "user", content: "끼어들기" }] })).status).toBe(404);
    expect((await pool.query("SELECT count(*)::int AS n FROM chat_messages")).rows[0].n).toBe(0);

    // 본인은 삭제 가능 (메시지도 함께)
    auth.userId = ME;
    expect((await DELETE_CONV(req("DELETE"), ctx(conv.id))).status).toBe(204);
    expect((await getConv(conv.id)).status).toBe(404);
  });

  it("Sales Agent 대화를 AI Assistant 요청으로 이어 쓸 수 없다", async () => {
    const conv = await createConversation(ME, "agent", "에이전트 대화");
    fakeOpenAi([{ content: "x" }]);
    expect((await ask({ conversationId: conv.id, messages: [{ role: "user", content: "질문" }] })).status).toBe(404);
  });
});
