import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as LIST, POST as CREATE } from "@/app/api/contacts/route";
import { DELETE as REMOVE, GET as GET_ONE, PATCH as UPDATE } from "@/app/api/contacts/[id]/route";
import { POST as CREATE_COMPANY } from "@/app/api/companies/route";
import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { PATCH as PATCH_LEAD } from "@/app/api/leads/[id]/route";
import { pool } from "@/lib/db";
import { personKey } from "@/lib/contact";
import type { Company, Contact, Lead } from "@/lib/types";
import { closeDb, ctx, events, leadInput, req, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(closeDb);

const createContact = async (body: Record<string, unknown>) => {
  const res = await CREATE(req("POST", body));
  return { status: res.status, body: (await res.json()) as Contact & { error?: string; contact?: Contact } };
};
const createLead = async (over: Record<string, unknown>) => {
  const res = await CREATE_LEAD(req("POST", leadInput(over)));
  return { status: res.status, body: (await res.json()) as Lead & { error?: string } };
};
const contactInput = (c: Contact, over: Partial<Contact> = {}) => {
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = c;
  return { ...rest, ...over };
};
const leadRow = async (id: string) =>
  (await pool.query<{ contact_id: string | null; contact: string; title: string; email: string; phone: string }>(
    "SELECT contact_id, contact, title, email, phone FROM leads WHERE id = $1", [id])).rows[0];

describe("연락처 API", () => {
  it("이름만으로 생성하고 목록·상세로 조회한다", async () => {
    const { status, body } = await createContact({ name: "김민수" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "김민수", companyId: null, email: "", role: null, tags: [] });
    expect(((await (await LIST()).json()) as Contact[]).map((c) => c.name)).toEqual(["김민수"]);
    expect((await GET_ONE(req("GET"), ctx(body.id))).status).toBe(200);
    expect((await GET_ONE(req("GET"), ctx("not-a-uuid"))).status).toBe(404);
  });

  it("입력을 정리해 저장한다: 이메일 소문자, LinkedIn https://", async () => {
    const { body } = await createContact({
      name: " 이준호 ", email: "JH@BlueWave.io", linkedinUrl: "linkedin.com/in/jh", role: "influencer", tags: ["기술", "기술"],
    });
    expect(body).toMatchObject({ name: "이준호", email: "jh@bluewave.io", linkedinUrl: "https://linkedin.com/in/jh", role: "influencer", tags: ["기술"] });
  });

  it("잘못된 입력은 400", async () => {
    for (const bad of [{}, { name: "a", email: "nope" }, { name: "a", role: "boss" }, { name: "a", mobile: "010-abc" },
      { name: "a", companyId: "00000000-0000-4000-8000-000000000000" }]) {
      expect((await createContact(bad)).status).toBe(400);
    }
  });

  it("같은 이메일은 409 + 기존 연락처", async () => {
    const first = (await createContact({ name: "김민수", email: "minsu@acme.co.kr" })).body;
    const dup = await createContact({ name: "다른 사람", email: "Minsu@acme.co.kr" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("이미 등록된 이메일");
    expect(dup.body.contact?.id).toBe(first.id);
    // 이메일이 없으면 여러 명이어도 된다
    expect((await createContact({ name: "A" })).status).toBe(201);
    expect((await createContact({ name: "B" })).status).toBe(201);
  });
});

describe("리드 ↔ 연락처", () => {
  it("contactId로 리드를 만들면 담당자 사본은 연락처 값(휴대폰 우선)으로 저장된다", async () => {
    const c = (await createContact({ name: "김민수", title: "팀장", email: "m@acme.co.kr", mobile: "010-1111-2222", officePhone: "02-123" })).body;
    const { body: lead } = await createLead({ contactId: c.id, contact: "무시", email: "x@x.com" });
    expect(lead).toMatchObject({ contactId: c.id, contact: "김민수", title: "팀장", email: "m@acme.co.kr", phone: "010-1111-2222" });
  });

  it("없는 연락처 id는 400", async () => {
    const { status } = await createLead({ contactId: "00000000-0000-4000-8000-000000000000" });
    expect(status).toBe(400);
  });

  it("담당자를 바꾸면 사본이 바뀌고 이력이 남는다, 비우면 보낸 텍스트 그대로", async () => {
    const a = (await createContact({ name: "김민수" })).body;
    const b = (await createContact({ name: "박서연", title: "과장" })).body;
    const { body: lead } = await createLead({ contactId: a.id });
    const patched = (await (await PATCH_LEAD(req("PATCH", leadInput({ ...lead, contactId: b.id })), ctx(lead.id))).json()) as Lead;
    expect(patched).toMatchObject({ contactId: b.id, contact: "박서연", title: "과장" });
    const ev = (await events(lead.id)).at(-1);
    expect(ev?.changes).toMatchObject({ contact: { from: "김민수", to: "박서연" } });

    const cleared = (await (await PATCH_LEAD(req("PATCH", leadInput({ ...lead, contactId: null, contact: "", title: "", email: "", phone: "" })), ctx(lead.id))).json()) as Lead;
    expect(cleared).toMatchObject({ contactId: null, contact: "" });
  });

  it("연락처를 수정하면 연결된 모든 리드(수주 포함)의 사본이 바뀌고 리드마다 이력", async () => {
    const c = (await createContact({ name: "김민수", title: "팀장", email: "m@acme.co.kr" })).body;
    const open = (await createLead({ contactId: c.id })).body;
    const won = (await createLead({ contactId: c.id, stage: "won" })).body;
    const res = await UPDATE(req("PATCH", contactInput(c, { title: "본부장", email: "minsu@acme.co.kr", department: "구매" })), ctx(c.id));
    expect(res.status).toBe(200);
    for (const id of [open.id, won.id]) {
      expect(await leadRow(id)).toMatchObject({ title: "본부장", email: "minsu@acme.co.kr" });
      expect((await events(id)).at(-1)).toMatchObject({
        type: "updated",
        changes: { title: { from: "팀장", to: "본부장" }, email: { from: "m@acme.co.kr", to: "minsu@acme.co.kr" }, via: "contact" },
      });
    }
    // 사본에 없는 항목(부서)만 바꾸면 이력이 늘지 않는다
    const before = (await events(open.id)).length;
    await UPDATE(req("PATCH", contactInput(c, { title: "본부장", email: "minsu@acme.co.kr", department: "전략구매" })), ctx(c.id));
    expect((await events(open.id)).length).toBe(before);
  });

  it("다른 연락처의 이메일로 바꾸면 409, 리드는 그대로", async () => {
    await createContact({ name: "A", email: "a@x.com" });
    const b = (await createContact({ name: "B", email: "b@x.com" })).body;
    const lead = (await createLead({ contactId: b.id })).body;
    const res = await UPDATE(req("PATCH", contactInput(b, { email: "a@x.com" })), ctx(b.id));
    expect(res.status).toBe(409);
    expect((await leadRow(lead.id)).email).toBe("b@x.com");
  });

  it("연락처를 삭제하면 리드는 연결만 끊기고 사본·이력은 남는다", async () => {
    const c = (await createContact({ name: "김민수", email: "m@acme.co.kr" })).body;
    const lead = (await createLead({ contactId: c.id })).body;
    expect((await REMOVE(req("DELETE"), ctx(c.id))).status).toBe(204);
    expect(await leadRow(lead.id)).toMatchObject({ contact_id: null, contact: "김민수", email: "m@acme.co.kr" });
    expect((await events(lead.id)).at(-1)).toMatchObject({ type: "updated", changes: { via: "contact_deleted" } });
    expect((await REMOVE(req("DELETE"), ctx(c.id))).status).toBe(404);
  });

  it("회사를 삭제하면 소속 연락처는 회사 없음이 된다", async () => {
    const company = (await (await CREATE_COMPANY(req("POST", { name: "에이스상사" }))).json()) as Company;
    const c = (await createContact({ name: "김민수", companyId: company.id })).body;
    await pool.query("DELETE FROM companies WHERE id = $1", [company.id]);
    expect(((await (await GET_ONE(req("GET"), ctx(c.id))).json()) as Contact).companyId).toBeNull();
  });
});

describe("기존 리드 담당자 → 연락처 마이그레이션 (crm_link_lead_contacts)", () => {
  it("이메일이 같으면 한 사람, 이메일이 없으면 회사+이름 기준. 재실행해도 늘지 않는다", async () => {
    const insert = (company: string, contact: string, email: string, phone: string) =>
      pool.query(
        "INSERT INTO leads (company, contact, title, email, phone, position) VALUES ($1, $2, '팀장', $3, $4, 1)",
        [company, contact, email, phone]
      );
    await insert("에이스상사", "김민수", "Minsu@acme.co.kr", "010-1111-2222");
    await insert("에이스상사", "김민수 ", "minsu@acme.co.kr", "");
    await insert("에이스상사", "박서연", "", "02-123-4567");
    await insert("에이스 상사", "박 서연", "", "");
    await insert("블루웨이브", "박서연", "", "");
    await insert("블루웨이브", "", "", "");
    await pool.query("SELECT crm_link_lead_companies()");

    const linked = (await pool.query<{ n: number }>("SELECT crm_link_lead_contacts() AS n")).rows[0].n;
    expect(linked).toBe(5);
    const { rows } = await pool.query<{ name: string; email: string; mobile: string; office_phone: string; company: string | null }>(
      `SELECT c.name, c.email, c.mobile, c.office_phone, co.name AS company FROM contacts c
       LEFT JOIN companies co ON co.id = c.company_id ORDER BY co.name, c.name`
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.email === "minsu@acme.co.kr")).toBeTruthy();
    // 이메일 없는 '박서연'·'박 서연'(같은 회사로 정규화)은 한 사람. 값은 가장 최근에 수정한 리드 기준
    expect(rows.filter((r) => r.company === "에이스상사" && personKey(r.name) === "박서연")).toHaveLength(1);
    expect(rows.filter((r) => r.company === "블루웨이브")).toHaveLength(1);

    expect((await pool.query<{ n: number }>("SELECT crm_link_lead_contacts() AS n")).rows[0].n).toBe(0);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts")).rows[0].n).toBe(3);
    // 담당자가 빈 리드는 연결하지 않는다
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM leads WHERE contact_id IS NULL")).rows[0].n).toBe(1);
  });

  it("SQL crm_person_key와 화면 personKey가 같은 규칙", async () => {
    const names = ["김 민수", "  Kim  MinSu ", "박서연"];
    const { rows } = await pool.query<{ k: string }>("SELECT crm_person_key(n) AS k FROM unnest($1::text[]) n", [names]);
    expect(rows.map((r) => r.k)).toEqual(names.map(personKey));
  });
});
