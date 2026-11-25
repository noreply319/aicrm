import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { runAgent } from "@/lib/agent";
import { AGENT_LIMITS } from "@/lib/agentLimits";
import { findUserById } from "@/lib/auth";
import { pool } from "@/lib/db";
import type { AgentEvent, Lead } from "@/lib/types";
import { closeDb, events, leadInput, req, resetDb } from "./helpers";

const ME = "00000000-0000-4000-8000-0000000000f1";

/** OpenAI 응답을 차례로 흉내 (마지막 응답은 계속 반복) */
function fakeOpenAi(replies: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const message = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }));
  return bodies;
}
const calls = (list: { name: string; args: unknown }[]) => ({
  content: null,
  tool_calls: list.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
});

beforeEach(async () => {
  await resetDb();
  process.env.OPENAI_API_KEY = "test-key";
  await pool.query(
    `INSERT INTO users (id, google_sub, email, name) VALUES ($1, 'run-me', 'agent-run@test.local', '홍길동') ON CONFLICT (id) DO NOTHING`,
    [ME]
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

const lead = async (over = {}) => (await (await CREATE_LEAD(req("POST", leadInput(over)))).json()) as Lead;

async function run(text: string) {
  const user = await findUserById(ME);
  if (!user) throw new Error("no user");
  const out: AgentEvent[] = [];
  await runAgent([{ role: "user", content: text }], user, (e) => out.push(e));
  return out;
}

describe("runAgent (Sales Agent 대화)", () => {
  it("변경 도구 호출은 실행하지 않고 pending 계획 + plan 이벤트만, 모델에는 승인 대기 응답", async () => {
    const l = await lead({ company: "에이스상사", stage: "qualified" });
    const bodies = fakeOpenAi([
      calls([{ name: "move_lead_stage", args: { leadId: l.id, stage: "negotiation" } }]),
      { content: "아래 계획을 확인하고 승인하면 반영됩니다." },
    ]);
    const out = await run("에이스상사 리드를 협상으로 옮겨줘");

    expect(out.filter((e) => e.type === "plan")).toHaveLength(1);
    expect(out).toContainEqual({ type: "reply", content: "아래 계획을 확인하고 승인하면 반영됩니다." });
    expect(out.filter((e) => e.type === "step").map((e) => e.type === "step" && e.step.label)).toContain("실행 계획 작성: 리드 단계 이동");
    // 리드는 그대로, 이력도 없음 (승인 전)
    expect((await pool.query("SELECT stage FROM leads WHERE id=$1", [l.id])).rows[0].stage).toBe("qualified");
    expect((await events(l.id)).filter((e) => e.type === "moved")).toHaveLength(0);
    expect((await pool.query("SELECT status, user_id FROM agent_actions")).rows).toEqual([{ status: "pending", user_id: ME }]);
    // 모델에 돌려준 도구 결과: 승인 대기 (계획 카드·인자는 보내지 않음)
    const tool = (bodies[1].messages as { role: string; content: string }[]).find((m) => m.role === "tool");
    expect(JSON.parse(tool!.content)).toMatchObject({ data: { status: "pending_approval" } });
    // 시스템 프롬프트: 데이터는 <crm_data>로 감싸고 보안 규칙 포함
    const system = (bodies[0].messages as { role: string; content: string }[])[0].content;
    expect(system).toContain("<crm_data>");
    expect(system).toContain("보안 규칙");
  });

  it("같은 요청의 같은 계획은 한 번만, 요청당 계획 수는 한도까지만", async () => {
    const leads = await Promise.all(Array.from({ length: AGENT_LIMITS.plansPerRequest + 1 }, (_, i) => lead({ company: `회사${i}`, stage: "new" })));
    fakeOpenAi([
      calls([
        { name: "move_lead_stage", args: { leadId: leads[0].id, stage: "contacted" } },
        { name: "move_lead_stage", args: { leadId: leads[0].id, stage: "contacted" } }, // 중복
        ...leads.slice(1).map((l) => ({ name: "move_lead_stage", args: { leadId: l.id, stage: "contacted" } })),
      ]),
      { content: "계획을 만들었습니다" },
    ]);
    const out = await run("모두 첫 컨택으로");
    expect(out.filter((e) => e.type === "plan")).toHaveLength(AGENT_LIMITS.plansPerRequest);
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_actions")).rows[0].n).toBe(AGENT_LIMITS.plansPerRequest);
  });

  it("조회 도구는 바로 실행되고 계획은 만들지 않는다", async () => {
    await lead({ company: "조회상사" });
    fakeOpenAi([calls([{ name: "search_leads", args: { query: "조회" } }]), { content: "조회상사 1건" }]);
    const out = await run("조회상사 찾아줘");
    expect(out.filter((e) => e.type === "plan")).toHaveLength(0);
    expect(out.some((e) => e.type === "step" && e.step.detail === "리드 1건")).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_actions")).rows[0].n).toBe(0);
  });
});
