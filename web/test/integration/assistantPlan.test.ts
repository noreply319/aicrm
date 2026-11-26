import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { decideAction, runAgent } from "@/lib/agent";
import { AGENT_TOOLS } from "@/lib/agentTools";
import { findUserById } from "@/lib/auth";
import { pool } from "@/lib/db";
import type { AgentEvent, AgentPlan, Lead } from "@/lib/types";
import { closeDb, events, leadInput, req, resetDb } from "./helpers";

/** AI Assistant(/api/assistant): 같은 실행 엔진을 리드 도구만으로 — 계획 출처 assistant, 이력 via: assistant (AIC-12) */

const ME = "00000000-0000-4000-8000-0000000000e3";

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
    `INSERT INTO users (id, google_sub, email, name) VALUES ($1, 'assistant-me', 'assistant-plan@test.local', '김영업') ON CONFLICT (id) DO NOTHING`,
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
  await runAgent([{ role: "user", content: text }], user, (e) => out.push(e), "assistant");
  return out;
}
const plans = (out: AgentEvent[]): AgentPlan[] => out.flatMap((e) => (e.type === "plan" ? [e.plan] : []));
const toolNames = (body: Record<string, unknown>) =>
  ((body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);

describe("AI Assistant 리드 변경 계획", () => {
  it("모델에는 모든 도구(미팅 노트·일정·메일·문서 포함)를 보내고, AI Assistant 프롬프트를 쓴다", async () => {
    const bodies = fakeOpenAi([{ content: "파이프라인 합계는 ₩0입니다" }]);
    await run("파이프라인 합계는?");
    expect(toolNames(bodies[0]).sort()).toEqual(expect.arrayContaining(Object.keys(AGENT_TOOLS)));
    const system = (bodies[0].messages as { role: string; content: string }[])[0].content;
    expect(system).toContain("AI Assistant");
    expect(system).not.toContain("조회만 할 수 있습니다");
  });

  it("생성: 승인 전에는 리드 없음 → 승인하면 리드 생성 + created 이력 via: assistant", async () => {
    fakeOpenAi([
      calls([{ name: "create_lead", args: { company: "에이스테크", value: 30000000, priority: "high" } }]),
      { content: "아래 계획을 확인하고 승인하면 반영됩니다." },
    ]);
    const [p] = plans(await run("에이스테크 리드 3천만 원, 우선순위 높음으로 추가해줘"));
    expect(p).toMatchObject({ status: "pending", title: "리드 생성" });
    expect((await pool.query("SELECT count(*)::int AS n FROM leads")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT source FROM agent_actions WHERE id=$1", [p.id])).rows[0].source).toBe("assistant");

    const r = await decideAction(p.id, ME, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "done", target: { kind: "lead" } } });
    const id = r.ok ? r.plan.target!.id : "";
    expect((await events(id)).at(-1)).toMatchObject({ type: "created", changes: { via: "assistant" } });
  });

  it("수정 + 단계 이동: 한 요청에 계획 2개, 승인하면 updated·moved 이력 via: assistant", async () => {
    const l = await lead({ company: "오션핀테크", stage: "proposal", value: 10000000 });
    fakeOpenAi([
      calls([
        { name: "update_lead", args: { leadId: l.id, value: 50000000 } },
        { name: "move_lead_stage", args: { leadId: l.id, stage: "negotiation" } },
      ]),
      { content: "두 계획을 확인하고 승인하세요." },
    ]);
    const ps = plans(await run("오션핀테크 금액 5천만 원으로 바꾸고 협상으로 옮겨줘"));
    expect(ps.map((p) => p.title)).toEqual(["리드 수정", "리드 단계 이동"]);
    for (const p of ps) expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done" } });

    const ev = await events(l.id);
    expect(ev.find((e) => e.type === "updated")).toMatchObject({ changes: { via: "assistant" } });
    expect(ev.find((e) => e.type === "moved")).toMatchObject({ changes: { stage: { from: "proposal", to: "negotiation" }, via: "assistant" } });
  });

  it("삭제: 되돌릴 수 없는 계획(danger)으로, 승인하면 deleted 이력 via: assistant", async () => {
    const l = await lead({ company: "삭제상사" });
    fakeOpenAi([calls([{ name: "delete_lead", args: { leadId: l.id } }]), { content: "삭제 계획입니다." }]);
    const [p] = plans(await run("삭제상사 리드 삭제해줘"));
    expect(p).toMatchObject({ title: "리드 삭제", danger: true });
    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done" } });
    expect((await events(l.id)).at(-1)).toMatchObject({ type: "deleted", changes: { via: "assistant" } });
  });

  it("미팅 노트 작성(통합 전 Sales Agent 도구)도 실행 계획으로 만든다 (출처 assistant)", async () => {
    fakeOpenAi([calls([{ name: "create_meeting_note", args: { title: "킥오프", date: "2026-11-20", body: "킥오프 미팅" } }]), { content: "승인하면 작성됩니다." }]);
    const [p] = plans(await run("킥오프 미팅 노트 써줘"));
    expect(p).toMatchObject({ status: "pending" });
    expect((await pool.query("SELECT source FROM agent_actions WHERE id=$1", [p.id])).rows[0].source).toBe("assistant");
    expect((await pool.query("SELECT count(*)::int AS n FROM meeting_notes")).rows[0].n).toBe(0);
  });
});
