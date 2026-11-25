import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as CREATE_COMPANY } from "@/app/api/companies/route";
import { PATCH as PATCH_COMPANY } from "@/app/api/companies/[id]/route";
import { POST as CREATE_CONTACT } from "@/app/api/contacts/route";
import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { decideAction, savePlan } from "@/lib/agent";
import type { PreparedPlan } from "@/lib/agentToolKit";
import { AGENT_TOOLS } from "@/lib/agentTools";
import { pool } from "@/lib/db";
import type { Company, Contact, Lead } from "@/lib/types";
import { closeDb, ctx, events, leadInput, req, resetDb } from "./helpers";

const USER = "00000000-0000-4000-8000-0000000000b1";

beforeEach(async () => {
  await resetDb();
  await pool.query(
    `INSERT INTO users (id, google_sub, email, name) VALUES ($1, 'agent-crm-test', 'agent-crm@test.com', '에이전트') ON CONFLICT (id) DO NOTHING`,
    [USER]
  );
});
afterAll(closeDb);

const company = async (body: Record<string, unknown>) => (await (await CREATE_COMPANY(req("POST", body))).json()) as Company;
const contact = async (body: Record<string, unknown>) => (await (await CREATE_CONTACT(req("POST", body))).json()) as Contact;
const lead = async (over = {}) => (await (await CREATE_LEAD(req("POST", leadInput(over)))).json()) as Lead;

async function prepare(tool: string, args: Record<string, unknown>) {
  const t = AGENT_TOOLS[tool];
  if (t.kind !== "write") throw new Error("write tool only");
  return t.prepare(args, USER);
}

async function plan(tool: string, args: Record<string, unknown>) {
  const p = await prepare(tool, args);
  if ("error" in p) throw new Error(p.error);
  return savePlan(USER, tool, p as PreparedPlan);
}

const approve = (id: string) => decideAction(id, USER, "approve");

describe("Sales Agent 회사 도구", () => {
  it("회사명 변경: 연결 리드 회사명 사본 + 리드마다 updated {company, via: agent}, 개인정보 항목은 그대로", async () => {
    const c = await company({ name: "에이스상사", phone: "02-123-4567", address: "서울", industry: "제조" });
    const l = await lead({ companyId: c.id, company: "" });
    const p = await plan("update_company", { companyId: c.id, name: "에이스테크", industry: "IT" });
    expect(p.changes).toEqual([
      { field: "회사명", before: "에이스상사", after: "에이스테크" },
      { field: "업종", before: "제조", after: "IT" },
    ]);
    expect(p.notice).toEqual({ tone: "info", text: "연결된 리드 1건의 회사명도 함께 바뀝니다" });

    expect(await approve(p.id)).toMatchObject({ ok: true, plan: { status: "done", target: { kind: "company", id: c.id } } });
    const row = (await pool.query("SELECT name, industry, phone, address FROM companies WHERE id=$1", [c.id])).rows[0];
    expect(row).toEqual({ name: "에이스테크", industry: "IT", phone: "02-123-4567", address: "서울" });
    expect((await pool.query("SELECT company FROM leads WHERE id=$1", [l.id])).rows[0].company).toBe("에이스테크");
    expect((await events(l.id)).at(-1)).toMatchObject({
      type: "updated", changes: { company: { from: "에이스상사", to: "에이스테크" }, via: "agent" },
    });
  });

  it("중복 회사는 계획을 만들지 않고 기존 회사를 알려준다 (이름·도메인)", async () => {
    const c = await company({ name: "(주)오션핀테크", emailDomain: "ocean.co.kr" });
    expect(await prepare("create_company", { name: "오션핀테크" })).toMatchObject({ error: expect.stringContaining(`id ${c.id}`) });
    expect(await prepare("create_company", { name: "다른회사", emailDomain: "ocean.co.kr" })).toMatchObject({
      error: expect.stringContaining("같은 이메일 도메인"),
    });
  });

  it("계획 후 다른 사람이 먼저 같은 이름으로 등록하면 승인 시 failed (409 메시지)", async () => {
    const p = await plan("create_company", { name: "블루웨이브", tier: "A" });
    await company({ name: "블루웨이브" });
    expect(await approve(p.id)).toMatchObject({ ok: true, plan: { status: "failed", message: expect.stringContaining("이미 등록된 회사") } });
  });

  it("계획 후 회사가 바뀌었으면 failed, 태그는 내용으로 비교", async () => {
    const c = await company({ name: "태그상사", tags: ["제조", "VIP"] });
    const p = await plan("update_company", { companyId: c.id, tags: ["제조"] });
    expect(await prepare("update_company", { companyId: c.id, tags: ["제조", "VIP"] })).toEqual({ error: "바뀌는 항목이 없습니다" });
    await PATCH_COMPANY(req("PATCH", { name: "태그상사", tags: ["신규"] }), ctx(c.id));
    expect(await approve(p.id)).toMatchObject({ ok: true, plan: { status: "failed", message: expect.stringContaining("회사 정보가 바뀌었습니다") } });
  });
});

describe("Sales Agent 항목 비우기", () => {
  it("회사 등급·연락처 소속 회사를 비우면 승인 후 DB에서 NULL (계획에 저장된 null도 적용)", async () => {
    const co = await company({ name: "비우기상사", tier: "A", size: "11-50" });
    const p1 = await plan("update_company", { companyId: co.id, tier: "" });
    expect(p1.changes).toEqual([{ field: "등급", before: "A", after: undefined }]);
    expect(await approve(p1.id)).toMatchObject({ ok: true, plan: { status: "done" } });
    expect((await pool.query("SELECT tier, size FROM companies WHERE id=$1", [co.id])).rows[0]).toEqual({ tier: null, size: "11-50" });

    const c = await contact({ name: "정우성", companyId: co.id, role: "decision_maker" });
    const p2 = await plan("update_contact", { contactId: c.id, companyId: "", role: null });
    expect(await approve(p2.id)).toMatchObject({ ok: true, plan: { status: "done" } });
    expect((await pool.query("SELECT company_id, role FROM contacts WHERE id=$1", [c.id])).rows[0]).toEqual({ company_id: null, role: null });
  });
});

describe("Sales Agent 연락처 도구", () => {
  it("연락처 수정: 담당 리드 사본 전파 + updated {via: contact, by: agent}, 이메일·전화는 그대로", async () => {
    const c = await contact({ name: "김민수", title: "팀장", email: "kim@ace.co.kr", mobile: "010-1111-2222" });
    const l = await lead({ contactId: c.id });
    const p = await plan("update_contact", { contactId: c.id, title: "부장" });
    expect(p.notice?.text).toBe("담당 리드 1건의 담당자 정보도 함께 바뀝니다");

    expect(await approve(p.id)).toMatchObject({ ok: true, plan: { status: "done" } });
    const row = (await pool.query("SELECT title, email, mobile FROM contacts WHERE id=$1", [c.id])).rows[0];
    expect(row).toEqual({ title: "부장", email: "kim@ace.co.kr", mobile: "010-1111-2222" });
    expect((await pool.query("SELECT title FROM leads WHERE id=$1", [l.id])).rows[0].title).toBe("부장");
    expect((await events(l.id)).at(-1)).toMatchObject({ type: "updated", changes: { title: { from: "팀장", to: "부장" }, via: "contact", by: "agent" } });
  });

  it("같은 회사 같은 이름은 기존 연락처 제안, allowSameName이면 계획 생성", async () => {
    const co = await company({ name: "동명상사" });
    const c = await contact({ name: "이영희", companyId: co.id });
    expect(await prepare("create_contact", { name: "이 영희", companyId: co.id })).toMatchObject({ error: expect.stringContaining(`id ${c.id}`) });
    const p = await plan("create_contact", { name: "이영희", companyId: co.id, allowSameName: true, title: "대리" });
    expect(p.changes).toContainEqual({ field: "회사", before: undefined, after: "동명상사" });
    expect(await approve(p.id)).toMatchObject({ ok: true, plan: { status: "done", target: { kind: "contact" } } });
  });

  it("개인정보 항목은 인자로 받지 않는다 (email·mobile은 무시)", async () => {
    const p = await plan("create_contact", { name: "박지훈", email: "park@x.com", mobile: "010-9999-8888" });
    expect(await approve(p.id)).toMatchObject({ ok: true });
    const row = (await pool.query("SELECT email, mobile FROM contacts WHERE name='박지훈'")).rows[0];
    expect(row).toEqual({ email: "", mobile: "" });
  });

  it("담당자 연결: 리드 사본이 연락처 값으로 바뀌고 contactLink 이력, 다른 회사면 경고", async () => {
    const a = await company({ name: "에이사" });
    const b = await company({ name: "비사" });
    const c = await contact({ name: "최수진", title: "이사", companyId: b.id, email: "choi@b.com" });
    const l = await lead({ companyId: a.id, company: "", contact: "", title: "" });

    const p = await plan("link_contact_to_lead", { leadId: l.id, contactId: c.id });
    expect(p.notice).toEqual({ tone: "warning", text: "리드 회사(에이사)가 아닌 비사 소속 연락처입니다" });
    expect(await approve(p.id)).toMatchObject({ ok: true, plan: { status: "done", target: { kind: "lead", id: l.id } } });

    const row = (await pool.query("SELECT contact_id, contact, title, email FROM leads WHERE id=$1", [l.id])).rows[0];
    expect(row).toEqual({ contact_id: c.id, contact: "최수진", title: "이사", email: "choi@b.com" });
    expect((await events(l.id)).at(-1)).toMatchObject({
      type: "updated", changes: { contactLink: { from: null, to: "최수진" }, via: "agent" },
    });
    expect(await prepare("link_contact_to_lead", { leadId: l.id, contactId: c.id })).toEqual({ error: "이미 최수진 님이 담당자로 연결되어 있습니다" });
  });
});
