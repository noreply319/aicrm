import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as CREATE_CONTACT } from "@/app/api/contacts/route";
import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { decideAction, savePlan } from "@/lib/agent";
import { AGENT_TOOLS } from "@/lib/agentTools";
import { pool } from "@/lib/db";
import type { Contact, Lead } from "@/lib/types";
import { closeDb, events, leadInput, req, resetDb } from "./helpers";

/** AI Assistant 회사·연락처 변경 계획 (AIC-13): 출처 assistant로 저장 → 승인 → 이력 via·전파 */

const ME = "00000000-0000-4000-8000-0000000000e2";

beforeEach(async () => {
  await resetDb();
  await pool.query(
    `INSERT INTO users (id, google_sub, email, name) VALUES ($1, 'assistant-crm', 'assistant-crm@test.local', '김영업') ON CONFLICT (id) DO NOTHING`,
    [ME]
  );
});
afterAll(closeDb);

const lead = async (over: Partial<Lead> = {}) => (await (await CREATE_LEAD(req("POST", leadInput(over)))).json()) as Lead;
const contact = async (body: Record<string, unknown>) => (await (await CREATE_CONTACT(req("POST", body))).json()) as Contact;

/** prepare → Assistant 출처로 계획 저장 (모델이 도구를 호출한 것과 같은 결과) */
async function prepare(tool: string, args: Record<string, unknown>) {
  const t = AGENT_TOOLS[tool];
  if (t.kind !== "write") throw new Error("write tool only");
  return t.prepare(args, ME);
}
async function plan(tool: string, args: Record<string, unknown>) {
  const p = await prepare(tool, args);
  if ("error" in p) throw new Error(p.error);
  return savePlan(ME, tool, p, "assistant");
}
const approve = async (tool: string, args: Record<string, unknown>) => decideAction((await plan(tool, args)).id, ME, "approve");

describe("AI Assistant 회사·연락처 변경 계획", () => {
  it("회사명 변경: 카드에 연결 리드 건수, 승인하면 리드 회사명 사본 + updated 이력 via: assistant", async () => {
    const l = await lead({ company: "에이스테크" });
    const p = await plan("update_company", { companyId: l.companyId, name: "에이스테크놀로지" });
    expect(p.notice?.text).toContain("연결된 리드 1건");

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done" } });
    expect((await pool.query("SELECT company FROM leads WHERE id=$1", [l.id])).rows[0].company).toBe("에이스테크놀로지");
    expect((await events(l.id)).at(-1)).toMatchObject({
      type: "updated", changes: { company: { from: "에이스테크", to: "에이스테크놀로지" }, via: "assistant" },
    });
  });

  it("이미 있는 회사(정규화 이름)는 새로 등록하지 않는다", async () => {
    await lead({ company: "에이스테크" });
    expect(await prepare("create_company", { name: "(주)에이스테크" })).toMatchObject({ error: expect.stringContaining("이미") });
  });

  it("없는 회사의 연락처: 카드 하나로 회사+연락처를 함께 등록", async () => {
    const p = await plan("create_contact", { name: "김민수", newCompany: "베타랩스", title: "팀장", role: "decision_maker" });
    expect(p.title).toBe("회사·연락처 등록");
    expect(p.changes).toContainEqual({ field: "회사", after: "베타랩스 (새 회사로 등록)" });

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done", target: { kind: "contact" } } });
    const { rows } = await pool.query<{ company: string }>(
      "SELECT co.name AS company FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.name = '김민수'"
    );
    expect(rows).toEqual([{ company: "베타랩스" }]);
  });

  it("newCompany가 이미 있는 회사면 companyId로 다시 요청하게 한다", async () => {
    await lead({ company: "에이스테크" });
    expect(await prepare("create_contact", { name: "김민수", newCompany: "에이스테크" })).toMatchObject({
      error: expect.stringContaining("이미 등록된 회사"),
    });
  });

  it("연락처 직함 변경: 담당 리드 사본 + updated 이력 via: contact, by: assistant", async () => {
    const l0 = await lead({ company: "에이스테크" });
    const c = await contact({ name: "김민수", companyId: l0.companyId, title: "팀장" });
    const l = await lead({ company: "에이스테크", companyId: l0.companyId, contactId: c.id });

    expect(await approve("update_contact", { contactId: c.id, title: "이사" })).toMatchObject({ ok: true, plan: { status: "done" } });
    expect((await pool.query("SELECT title FROM leads WHERE id=$1", [l.id])).rows[0].title).toBe("이사");
    expect((await events(l.id)).at(-1)).toMatchObject({ type: "updated", changes: { via: "contact", by: "assistant" } });
  });

  it("담당 연락처 지정: 리드 담당자 사본 + 이력 via: assistant", async () => {
    const l = await lead({ company: "에이스테크", contact: "", title: "" });
    const c = await contact({ name: "이영희", companyId: l.companyId, title: "과장" });

    expect(await approve("link_contact_to_lead", { leadId: l.id, contactId: c.id })).toMatchObject({ ok: true, plan: { status: "done" } });
    expect((await pool.query("SELECT contact_id, contact FROM leads WHERE id=$1", [l.id])).rows[0]).toEqual({ contact_id: c.id, contact: "이영희" });
    expect((await events(l.id)).at(-1)).toMatchObject({ changes: { via: "assistant" } });
  });

  it("회사 삭제: 연결 리드가 있으면 계획을 만들지 않고, 없으면 삭제 + 소속 연락처는 소속 없음", async () => {
    const l = await lead({ company: "리드있는회사" });
    expect(await prepare("delete_company", { companyId: l.companyId })).toMatchObject({ error: expect.stringContaining("연결된 리드 1건") });

    // 리드 없는 회사: 연락처만 등록 (newCompany)
    await approve("create_contact", { name: "박철수", newCompany: "빈회사" });
    const companyId = (await pool.query<{ id: string }>("SELECT id FROM companies WHERE name = '빈회사'")).rows[0].id;
    const p = await plan("delete_company", { companyId });
    expect(p).toMatchObject({ title: "회사 삭제", danger: true, notice: { text: expect.stringContaining("소속 연락처 1명") } });

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done", message: "회사를 삭제했습니다" } });
    expect((await pool.query("SELECT count(*)::int AS n FROM companies WHERE id=$1", [companyId])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT company_id FROM contacts WHERE name = '박철수'")).rows[0].company_id).toBeNull();
  });

  it("회사 삭제: 계획 후 리드가 연결되면 승인해도 삭제하지 않는다", async () => {
    await approve("create_contact", { name: "최지훈", newCompany: "나중연결" });
    const companyId = (await pool.query<{ id: string }>("SELECT id FROM companies WHERE name = '나중연결'")).rows[0].id;
    const p = await plan("delete_company", { companyId });
    await lead({ company: "나중연결", companyId });

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "failed", message: expect.stringContaining("연결된 리드") } });
    expect((await pool.query("SELECT count(*)::int AS n FROM companies WHERE id=$1", [companyId])).rows[0].n).toBe(1);
  });

  it("연락처 삭제: 담당 리드는 연결만 끊고 사본 유지, 이력 via: contact_deleted, by: assistant", async () => {
    const l0 = await lead({ company: "에이스테크" });
    const c = await contact({ name: "김민수", companyId: l0.companyId, title: "팀장" });
    const l = await lead({ company: "에이스테크", companyId: l0.companyId, contactId: c.id });
    const p = await plan("delete_contact", { contactId: c.id });
    expect(p).toMatchObject({ danger: true, notice: { text: expect.stringContaining("담당 리드 1건") } });

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done" } });
    expect((await pool.query("SELECT contact_id, contact FROM leads WHERE id=$1", [l.id])).rows[0]).toEqual({ contact_id: null, contact: "김민수" });
    expect((await events(l.id)).at(-1)).toMatchObject({ changes: { via: "contact_deleted", by: "assistant" } });
  });
});
