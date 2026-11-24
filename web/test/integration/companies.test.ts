import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as LIST, POST as CREATE } from "@/app/api/companies/route";
import { DELETE as REMOVE, GET as GET_ONE, PATCH as UPDATE } from "@/app/api/companies/[id]/route";
import { GET as LEADS, POST as CREATE_LEAD } from "@/app/api/leads/route";
import { DELETE as DELETE_LEAD, PATCH as PATCH_LEAD } from "@/app/api/leads/[id]/route";
import { pool } from "@/lib/db";
import { companyKey } from "@/lib/company";
import type { Company, Lead } from "@/lib/types";
import { closeDb, ctx, events, leadInput, req, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(closeDb);

const createCompany = async (body: Record<string, unknown>) => {
  const res = await CREATE(req("POST", body));
  return { status: res.status, body: (await res.json()) as Company & { error?: string; company?: Company } };
};
const createLead = async (over: Record<string, unknown>) => (await (await CREATE_LEAD(req("POST", leadInput(over)))).json()) as Lead;
const companyCount = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM companies")).rows[0].n;

describe("회사 API", () => {
  it("이름만으로 생성하고 목록·상세로 조회한다", async () => {
    const { status, body } = await createCompany({ name: "에이스상사" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "에이스상사", tags: [], tier: null, emailDomain: null });
    expect(((await (await LIST()).json()) as Company[]).map((c) => c.name)).toEqual(["에이스상사"]);
    expect((await GET_ONE(req("GET"), ctx(body.id))).status).toBe(200);
    expect((await GET_ONE(req("GET"), ctx("not-a-uuid"))).status).toBe(404);
  });

  it("정규화 이름이 같으면 409 + 기존 회사", async () => {
    const first = (await createCompany({ name: "(주)에이스상사" })).body;
    const dup = await createCompany({ name: "에이스 상사" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("이미 등록된 회사");
    expect(dup.body.company?.id).toBe(first.id);
    expect(await companyCount()).toBe(1);
  });

  it("이메일 도메인 중복도 409", async () => {
    await createCompany({ name: "A", emailDomain: "acme.co.kr" });
    const dup = await createCompany({ name: "B", emailDomain: "ACME.co.kr" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("acme.co.kr");
  });

  it("없는 담당 영업은 400", async () => {
    const { status } = await createCompany({ name: "A", ownerId: "00000000-0000-4000-8000-000000000000" });
    expect(status).toBe(400);
  });

  it("SQL crm_company_key와 화면 companyKey가 같은 규칙", async () => {
    const names = ["(주) 에이스 상사", "주식회사 블루웨이브", "ACME  Corp", "㈜", "한빛(유)"];
    const { rows } = await pool.query<{ k: string }>("SELECT crm_company_key(n) AS k FROM unnest($1::text[]) n", [names]);
    expect(rows.map((r) => r.k)).toEqual(names.map(companyKey));
  });
});

describe("리드 ↔ 회사", () => {
  it("companyId로 리드를 만들면 회사명 사본은 회사 이름으로 저장된다", async () => {
    const company = (await createCompany({ name: "에이스상사" })).body;
    const lead = await createLead({ companyId: company.id, company: "무시되는 이름" });
    expect(lead).toMatchObject({ companyId: company.id, company: "에이스상사" });
  });

  it("companyId 없이 회사명만 오면 같은 이름의 회사를 찾거나 만든다", async () => {
    const a = await createLead({ company: "블루웨이브" });
    const b = await createLead({ company: "블루 웨이브" });
    expect(a.companyId).toBeTruthy();
    expect(b.companyId).toBe(a.companyId);
    expect(b.company).toBe("블루웨이브");
    expect(await companyCount()).toBe(1);
  });

  it("없는 회사 id는 400, 아무것도 남기지 않는다", async () => {
    const res = await CREATE_LEAD(req("POST", leadInput({ companyId: "00000000-0000-4000-8000-000000000000" } as never)));
    expect(res.status).toBe(400);
    expect(await (await LEADS()).json()).toEqual([]);
  });

  it("리드의 회사를 바꾸면 updated 이력에 회사명 변경이 남는다", async () => {
    const a = (await createCompany({ name: "A사" })).body;
    const b = (await createCompany({ name: "B사" })).body;
    const lead = await createLead({ companyId: a.id });
    const res = await PATCH_LEAD(req("PATCH", leadInput({ companyId: b.id } as never)), ctx(lead.id));
    expect(await res.json()).toMatchObject({ companyId: b.id, company: "B사" });
    expect((await events(lead.id)).at(-1)).toEqual({ type: "updated", changes: { company: { from: "A사", to: "B사" } } });
  });

  it("회사명을 바꾸면 연결 리드의 회사명과 이력이 함께 바뀐다", async () => {
    const company = (await createCompany({ name: "에이스상사" })).body;
    const l1 = await createLead({ companyId: company.id });
    const l2 = await createLead({ companyId: company.id });
    const res = await UPDATE(req("PATCH", { ...company, name: "에이스홀딩스", industry: "제조" }), ctx(company.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "에이스홀딩스", industry: "제조" });

    const leads = (await (await LEADS()).json()) as Lead[];
    expect(leads.map((l) => l.company)).toEqual(["에이스홀딩스", "에이스홀딩스"]);
    for (const l of [l1, l2]) {
      expect((await events(l.id)).at(-1)).toEqual({ type: "updated", changes: { company: { from: "에이스상사", to: "에이스홀딩스" } } });
    }
  });

  it("이름을 다른 회사와 겹치게 바꾸면 409, 아무것도 바뀌지 않는다", async () => {
    await createCompany({ name: "A사" });
    const b = (await createCompany({ name: "B사" })).body;
    const lead = await createLead({ companyId: b.id });
    const res = await UPDATE(req("PATCH", { ...b, name: "a사" }), ctx(b.id));
    expect(res.status).toBe(409);
    expect(((await (await LEADS()).json()) as Lead[])[0].company).toBe("B사");
    expect((await events(lead.id)).map((e) => e.type)).toEqual(["created"]);
  });

  it("연결된 리드가 있으면 삭제할 수 없고, 리드를 지우면 삭제된다", async () => {
    const company = (await createCompany({ name: "에이스상사" })).body;
    const lead = await createLead({ companyId: company.id });
    const blocked = await REMOVE(req("DELETE"), ctx(company.id));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toContain("연결된 리드 1건");

    await DELETE_LEAD(req("DELETE"), ctx(lead.id));
    expect((await REMOVE(req("DELETE"), ctx(company.id))).status).toBe(204);
    expect(await companyCount()).toBe(0);
  });
});

describe("기존 리드 마이그레이션 (crm_link_lead_companies)", () => {
  it("회사가 없는 리드를 정규화 이름으로 묶어 회사를 만들고 연결한다. 재실행 안전", async () => {
    // 회사 기능 도입 전 리드: company 텍스트만 있음
    await pool.query(
      `INSERT INTO leads (company, position, created_at) VALUES
         ('(주)에이스상사', 1, now() - interval '2 day'), ('에이스 상사', 2, now()), ('블루웨이브', 3, now())`
    );
    await pool.query("SELECT crm_link_lead_companies()");
    await pool.query("SELECT crm_link_lead_companies()");

    const companies = (await pool.query<{ name: string }>("SELECT name FROM companies ORDER BY name")).rows.map((r) => r.name);
    expect(companies).toEqual(["(주)에이스상사", "블루웨이브"]);
    const leads = (await pool.query<{ company: string; linked: boolean }>(
      "SELECT company, company_id IS NOT NULL AS linked FROM leads ORDER BY position"
    )).rows;
    expect(leads).toEqual([
      { company: "(주)에이스상사", linked: true },
      { company: "(주)에이스상사", linked: true },
      { company: "블루웨이브", linked: true },
    ]);
  });

  it("이미 있는 회사가 있으면 새로 만들지 않고 그 회사에 연결한다", async () => {
    const company = (await createCompany({ name: "에이스상사" })).body;
    await pool.query("INSERT INTO leads (company, position) VALUES ('에이스 상사', 1)");
    await pool.query("SELECT crm_link_lead_companies()");
    const { rows } = await pool.query<{ company_id: string; company: string }>("SELECT company_id, company FROM leads");
    expect(rows[0]).toEqual({ company_id: company.id, company: "에이스상사" });
    expect(await companyCount()).toBe(1);
  });
});
