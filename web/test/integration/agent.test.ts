import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/leads/route";
import { POST as MOVE } from "@/app/api/leads/[id]/move/route";
import { decideAction, savePlan } from "@/lib/agent";
import { AGENT_TOOLS, type PreparedPlan } from "@/lib/agentTools";
import { pool } from "@/lib/db";
import type { Lead } from "@/lib/types";
import { closeDb, ctx, events, leadInput, req, resetDb } from "./helpers";

const USER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

beforeEach(async () => {
  await resetDb();
  for (const [id, sub] of [[USER, "agent-test-1"], [OTHER, "agent-test-2"]]) {
    await pool.query(
      `INSERT INTO users (id, google_sub, email, name) VALUES ($1, $2, $3, $2) ON CONFLICT (id) DO NOTHING`,
      [id, sub, `${sub}@test.com`]
    );
  }
});
afterAll(closeDb);

const create = async (over = {}) => (await (await POST(req("POST", leadInput(over)))).json()) as Lead;
const lead = async (id: string) => (await pool.query<{ stage: string; value: string; priority: string; notes: string }>(
  "SELECT stage, value::text, priority, notes FROM leads WHERE id=$1", [id]
)).rows[0];

/** 변경 도구 prepare → 계획 저장 (모델이 도구를 호출한 것과 같은 결과) */
async function plan(tool: string, args: Record<string, unknown>, userId = USER) {
  const t = AGENT_TOOLS[tool];
  if (t.kind !== "write") throw new Error("write tool only");
  const p = await t.prepare(args);
  if ("error" in p) throw new Error(p.error);
  return savePlan(userId, tool, p as PreparedPlan);
}

describe("Sales Agent 실행 계획", () => {
  it("단계 이동: 승인하면 리드가 옮겨지고 moved 이력에 via: agent", async () => {
    const l = await create({ stage: "qualified" });
    const p = await plan("move_lead_stage", { leadId: l.id, stage: "negotiation" });
    expect(p).toMatchObject({ status: "pending", title: "리드 단계 이동", changes: [{ field: "단계", before: "니즈 확인", after: "협상" }] });
    expect((await lead(l.id)).stage).toBe("qualified"); // 계획만으로는 실행되지 않는다

    const r = await decideAction(p.id, USER, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "done", message: "협상 단계로 옮겼습니다", target: { kind: "lead", id: l.id } } });
    expect((await lead(l.id)).stage).toBe("negotiation");
    const ev = await events(l.id);
    expect(ev.at(-1)).toMatchObject({ type: "moved", changes: { stage: { from: "qualified", to: "negotiation" }, via: "agent" } });
  });

  it("두 번 승인하면 409, 다른 사용자는 404 (실행 안 됨)", async () => {
    const l = await create({ stage: "new" });
    const p = await plan("move_lead_stage", { leadId: l.id, stage: "contacted" });

    expect(await decideAction(p.id, OTHER, "approve")).toMatchObject({ ok: false, status: 404 });
    expect((await lead(l.id)).stage).toBe("new");

    expect(await decideAction(p.id, USER, "approve")).toMatchObject({ ok: true });
    expect(await decideAction(p.id, USER, "approve")).toMatchObject({ ok: false, status: 409 });
    expect((await events(l.id)).filter((e) => e.type === "moved")).toHaveLength(1);
  });

  it("계획 후 리드가 바뀌었으면 실행하지 않고 failed", async () => {
    const l = await create({ stage: "qualified" });
    const p = await plan("move_lead_stage", { leadId: l.id, stage: "negotiation" });
    await MOVE(req("POST", { stage: "proposal", beforeId: null }), ctx(l.id)); // 다른 사람이 보드에서 이동

    const r = await decideAction(p.id, USER, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "failed", message: expect.stringContaining("리드가 바뀌었습니다") } });
    expect((await lead(l.id)).stage).toBe("proposal");
  });

  it("1시간이 지난 계획은 만료(failed)", async () => {
    const l = await create({ stage: "new" });
    const p = await plan("move_lead_stage", { leadId: l.id, stage: "won" });
    await pool.query("UPDATE agent_actions SET created_at = now() - interval '2 hours' WHERE id=$1", [p.id]);

    expect(await decideAction(p.id, USER, "approve")).toMatchObject({ ok: true, plan: { status: "failed", message: expect.stringContaining("만료") } });
    expect((await lead(l.id)).stage).toBe("new");
  });

  it("취소하면 canceled, 이후 승인은 409", async () => {
    const l = await create();
    const p = await plan("delete_lead", { leadId: l.id });
    expect(await decideAction(p.id, USER, "cancel")).toMatchObject({ ok: true, plan: { status: "canceled" } });
    expect(await decideAction(p.id, USER, "approve")).toMatchObject({ ok: false, status: 409 });
    expect(await lead(l.id)).toBeDefined();
  });

  it("부분 수정: 바꾼 항목만 바뀌고 나머지는 그대로, updated 이력에 via: agent", async () => {
    const l = await create({ value: 1_000_000, priority: "low", notes: "기존 메모" });
    const p = await plan("update_lead", { leadId: l.id, value: 5_000_000 });
    expect(p.changes).toEqual([{ field: "금액", before: "₩1,000,000", after: "₩5,000,000" }]);

    expect(await decideAction(p.id, USER, "approve")).toMatchObject({ ok: true, plan: { status: "done" } });
    expect(await lead(l.id)).toMatchObject({ value: "5000000", priority: "low", notes: "기존 메모" });
    const ev = await events(l.id);
    expect(ev.at(-1)).toMatchObject({ type: "updated", changes: { value: { from: 1_000_000, to: 5_000_000 }, via: "agent" } });
  });

  it("삭제: 승인하면 리드 삭제 + deleted 이력, 대상 링크는 없어진다", async () => {
    const l = await create();
    const p = await plan("delete_lead", { leadId: l.id });
    expect(p.danger).toBe(true);

    const r = await decideAction(p.id, USER, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "done" } });
    if (r.ok) expect(r.plan.target).toBeUndefined();
    expect(await lead(l.id)).toBeUndefined();
    expect((await events(l.id)).at(-1)).toMatchObject({ type: "deleted", changes: { via: "agent" } });
  });

  it("생성: 새 회사면 카드에 표시, 승인하면 리드 생성 + 대상 링크", async () => {
    const p = await plan("create_lead", { company: "에이전트상사", contact: "김민수", value: 3_000_000, stage: "contacted" });
    expect(p.changes[0]).toEqual({ field: "회사", after: "에이전트상사 (새 회사로 등록)" });

    const r = await decideAction(p.id, USER, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "done", target: { kind: "lead", label: "에이전트상사 · 김민수" } } });
    if (!r.ok || !r.plan.target) throw new Error("no target");
    expect(await lead(r.plan.target.id)).toMatchObject({ stage: "contacted", value: "3000000" });
    expect((await events(r.plan.target.id))[0]).toMatchObject({ type: "created", changes: { via: "agent" } });
  });

  it("잘못된 계획은 만들지 않는다 (같은 단계, 바뀌는 값 없음, 잘못된 id·단계)", async () => {
    const l = await create({ stage: "new", value: 1_000_000 });
    const move = AGENT_TOOLS.move_lead_stage;
    const update = AGENT_TOOLS.update_lead;
    if (move.kind !== "write" || update.kind !== "write") throw new Error("write tool only");
    expect(await move.prepare({ leadId: l.id, stage: "new" })).toEqual({ error: "이미 신규 리드 단계입니다" });
    expect(await move.prepare({ leadId: l.id, stage: "done" })).toEqual({ error: "단계가 올바르지 않습니다" });
    expect(await move.prepare({ leadId: "x", stage: "won" })).toEqual({ error: "리드 id가 올바르지 않습니다" });
    expect(await update.prepare({ leadId: l.id, value: 1_000_000 })).toMatchObject({ error: expect.stringContaining("바뀌는 항목이 없습니다") });
    expect(await update.prepare({ leadId: l.id })).toMatchObject({ error: expect.stringContaining("바꿀 항목이 없습니다") });
  });
});
