import "server-only";
import {
  diffFields, idArg, leadTarget, parseFields, pick, stale, str, text, unchanged,
  type AgentTool, type Args, type ReadTool, type WriteTool,
} from "./agentToolKit";
import { COMPANY_SIZES, COMPANY_TIERS, CONTACT_ROLE_LABEL, CONTACT_ROLES, STAGES } from "./constants";
import { resolveLeadCompany } from "./companies";
import { companyInputOf, companyLeadCount, createCompany, deleteCompany, findCompany, leadsBlockMessage, updateCompany } from "./companyOps";
import { contactInputOf, createContact, deleteContact, findContact, updateContact } from "./contactOps";
import { pool } from "./db";
import { findLead, linkContact } from "./leadOps";
import { maskPii } from "./openai";
import type { AgentChange, AgentTarget, Company, CompanyInput, Contact, ContactInput, ContactRole } from "./types";
import { parseCompanyInput, parseContactInput } from "./validate";

/**
 * 회사·연락처 도구.
 * 개인정보(회사 전화·주소·사업자번호·대표자명, 연락처 이메일·전화·LinkedIn)는 모델에 보내지 않고 인자로도 받지 않는다.
 * 수정은 지금 값에 바꿀 항목만 덮어써(개인정보 항목은 그대로) 리드 API와 같은 검증(parseCompanyInput·parseContactInput)을 거친다.
 */

const MAX_SEARCH = 30;

/* ───────── 표시·대상 ───────── */

const COMPANY_LABEL: Record<string, string> = {
  name: "회사명", industry: "업종", size: "규모(직원 수)", tier: "등급", tags: "태그", notes: "메모",
  website: "웹사이트", emailDomain: "이메일 도메인",
};
const CONTACT_LABEL: Record<string, string> = {
  name: "이름", companyId: "회사", department: "부서", title: "직함", role: "역할", tags: "태그", notes: "메모",
};

const companyTarget = (c: Pick<Company, "id" | "name">): AgentTarget => ({ kind: "company", id: c.id, label: c.name });
const contactTarget = (c: Pick<Contact, "id" | "name">): AgentTarget => ({ kind: "contact", id: c.id, label: c.name });

const roleName = (r: unknown) => (r ? (CONTACT_ROLE_LABEL[r as ContactRole] ?? String(r)) : undefined);

async function companyName(id: string | null): Promise<string | undefined> {
  if (!id) return undefined;
  return (await pool.query<{ name: string }>("SELECT name FROM companies WHERE id = $1", [id])).rows[0]?.name;
}

const countRows = async (sql: string, id: string) => (await pool.query<{ n: number }>(sql, [id])).rows[0].n;
const contactLeadCount = (id: string) => countRows("SELECT count(*)::int AS n FROM leads WHERE contact_id = $1", id);
const companyContactCount = (id: string) => countRows("SELECT count(*)::int AS n FROM contacts WHERE company_id = $1", id);

/* ───────── 모델에 보내는 값 (개인정보 제외) ───────── */

const companyForModel = (c: Company) => ({
  id: c.id,
  name: c.name,
  industry: c.industry || undefined,
  size: c.size ?? undefined,
  tier: c.tier ?? undefined,
  tags: c.tags.length ? c.tags : undefined,
  website: c.website || undefined,
  emailDomain: c.emailDomain ?? undefined,
});

const contactForModel = (c: Contact, company?: string) => ({
  id: c.id,
  name: c.name,
  companyId: c.companyId ?? undefined,
  company,
  department: c.department || undefined,
  title: c.title || undefined,
  role: roleName(c.role),
  tags: c.tags.length ? c.tags : undefined,
});

/* ───────── 조회 도구 ───────── */

const searchCompanies: ReadTool = {
  kind: "read",
  label: "회사 검색",
  def: {
    name: "search_companies",
    description: "회사를 이름·업종·태그 일부, 등급으로 검색합니다. 연결된 리드 수가 함께 나옵니다.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "회사명·업종·태그에 포함된 글자" },
        tier: { type: "string", enum: COMPANY_TIERS },
      },
    },
  },
  async run(a) {
    const q = str(a.query, 100).toLowerCase();
    const { rows } = await pool.query<{ id: string; name: string; industry: string; size: string | null; tier: string | null; tags: string[]; leads: number }>(
      `SELECT c.id, c.name, c.industry, c.size, c.tier, c.tags, count(l.id)::int AS leads
       FROM companies c LEFT JOIN leads l ON l.company_id = c.id
       GROUP BY c.id ORDER BY c.name`
    );
    const found = rows
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.industry.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)))
      .filter((c) => !COMPANY_TIERS.includes(a.tier as never) || c.tier === a.tier);
    return {
      count: found.length,
      companies: found.slice(0, MAX_SEARCH).map((c) => ({
        id: c.id, name: c.name, industry: c.industry || undefined, size: c.size ?? undefined, tier: c.tier ?? undefined,
        tags: c.tags.length ? c.tags : undefined, leadCount: c.leads,
      })),
    };
  },
};

const getCompany: ReadTool = {
  kind: "read",
  label: "회사 상세 조회",
  def: {
    name: "get_company",
    description: "회사 한 곳의 최신 정보, 메모, 연결된 리드·소속 연락처를 조회합니다. 회사 정보를 바꾸기 전에 현재 값을 확인할 때 쓰세요.",
    parameters: { type: "object", properties: { companyId: { type: "string" } }, required: ["companyId"] },
  },
  async run(a) {
    const id = idArg(a, "companyId");
    if (!id) return { error: "회사 id가 올바르지 않습니다" };
    const c = await findCompany(pool, id);
    if (!c) return { error: "회사를 찾을 수 없습니다" };
    const [leads, contacts] = await Promise.all([
      pool.query<{ id: string; contact: string; stage: string; value: number }>(
        "SELECT id, contact, stage, value::float8 AS value FROM leads WHERE company_id = $1 ORDER BY position", [id]
      ),
      pool.query<{ id: string; name: string; title: string; department: string; role: ContactRole | null }>(
        "SELECT id, name, title, department, role FROM contacts WHERE company_id = $1 ORDER BY name", [id]
      ),
    ]);
    return {
      company: { ...companyForModel(c), notes: maskPii(c.notes) || undefined },
      leads: leads.rows.map((l) => ({ ...l, contact: l.contact || undefined, stageName: STAGES.find((s) => s.id === l.stage)?.name })),
      contacts: contacts.rows.map((x) => ({ id: x.id, name: x.name, title: x.title || undefined, department: x.department || undefined, role: roleName(x.role) })),
    };
  },
};

const searchContacts: ReadTool = {
  kind: "read",
  label: "연락처 검색",
  def: {
    name: "search_contacts",
    description: "연락처를 이름·회사·부서·직함·태그 일부, 회사, 역할로 검색합니다. 이메일·전화번호는 제공되지 않습니다.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        companyId: { type: "string" },
        role: { type: "string", enum: CONTACT_ROLES.map((r) => r.id) },
      },
    },
  },
  async run(a) {
    const q = str(a.query, 100).toLowerCase();
    const companyId = idArg(a, "companyId");
    const { rows } = await pool.query<{ id: string; name: string; companyId: string | null; company: string | null; department: string; title: string; role: ContactRole | null; tags: string[]; leads: number }>(
      `SELECT c.id, c.name, c.company_id AS "companyId", co.name AS company, c.department, c.title, c.role, c.tags,
              (SELECT count(*)::int FROM leads l WHERE l.contact_id = c.id) AS leads
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       ORDER BY c.name`
    );
    const found = rows
      .filter((c) => !q || [c.name, c.company ?? "", c.department, c.title, ...c.tags].some((v) => v.toLowerCase().includes(q)))
      .filter((c) => !companyId || c.companyId === companyId)
      .filter((c) => !a.role || c.role === a.role);
    return {
      count: found.length,
      contacts: found.slice(0, MAX_SEARCH).map((c) => ({
        id: c.id, name: c.name, companyId: c.companyId ?? undefined, company: c.company ?? undefined,
        department: c.department || undefined, title: c.title || undefined, role: roleName(c.role),
        tags: c.tags.length ? c.tags : undefined, leadCount: c.leads,
      })),
    };
  },
};

const getContact: ReadTool = {
  kind: "read",
  label: "연락처 상세 조회",
  def: {
    name: "get_contact",
    description: "연락처 한 명의 최신 정보, 메모, 담당 리드를 조회합니다. 이메일·전화번호·LinkedIn은 제공되지 않습니다.",
    parameters: { type: "object", properties: { contactId: { type: "string" } }, required: ["contactId"] },
  },
  async run(a) {
    const id = idArg(a, "contactId");
    if (!id) return { error: "연락처 id가 올바르지 않습니다" };
    const c = await findContact(pool, id);
    if (!c) return { error: "연락처를 찾을 수 없습니다" };
    const leads = await pool.query<{ id: string; company: string; stage: string; value: number }>(
      "SELECT id, company, stage, value::float8 AS value FROM leads WHERE contact_id = $1 ORDER BY position", [id]
    );
    return {
      contact: { ...contactForModel(c, await companyName(c.companyId)), notes: maskPii(c.notes) || undefined },
      leads: leads.rows,
    };
  },
};

/* ───────── 회사 변경 도구 ───────── */

/** 모델이 넘길 수 있는 회사 항목 (개인정보 항목 제외) */
const COMPANY_FIELDS = ["name", "industry", "size", "tier", "tags", "notes", "website", "emailDomain"] as const;
type CompanyField = (typeof COMPANY_FIELDS)[number];

const COMPANY_PROPS = {
  name: { type: "string", description: "회사명" },
  industry: { type: "string", description: "업종" },
  size: { type: "string", enum: COMPANY_SIZES, description: "직원 수 구간" },
  tier: { type: "string", enum: COMPANY_TIERS, description: "등급" },
  tags: { type: "array", items: { type: "string" }, description: "태그 전체 (기존 태그를 대체)" },
  notes: { type: "string", description: "메모 전체 (기존 메모를 대체)" },
  website: { type: "string", description: "웹사이트 주소" },
  emailDomain: { type: "string", description: "회사 메일 도메인 (예: acme.co.kr, 무료 메일 도메인 불가)" },
};

const parseCompanyFields = (a: Args, base: CompanyInput | null) => parseFields(a, COMPANY_FIELDS, base, parseCompanyInput);

const companyChange = (f: CompanyField, before: unknown, after: unknown): AgentChange => ({
  field: COMPANY_LABEL[f], before: text(before), after: text(after),
});

/** 같은 정규화 이름·도메인의 다른 회사 */
async function duplicateCompany(d: Pick<CompanyInput, "name" | "emailDomain">, selfId: string | null = null) {
  const { rows } = await pool.query<{ id: string; name: string; byDomain: boolean }>(
    `SELECT id, name, (email_domain = $2) AS "byDomain" FROM companies
     WHERE (name_key = crm_company_key($1) OR ($2::text IS NOT NULL AND email_domain = $2)) AND ($3::uuid IS NULL OR id <> $3)
     LIMIT 1`,
    [d.name, d.emailDomain, selfId]
  );
  return rows[0] ?? null;
}

const duplicateError = (dup: { id: string; name: string; byDomain: boolean }, what = "회사") => ({
  error: `${dup.byDomain ? "같은 이메일 도메인의" : "같은 이름의"} ${what}가 이미 있습니다: ${dup.name} (id ${dup.id}). 새로 만들지 말고 기존 ${what}를 쓰도록 안내하세요`,
});

const createCompanyTool: WriteTool = {
  kind: "write",
  label: "회사 등록",
  def: {
    name: "create_company",
    description: "새 회사를 등록하는 실행 계획을 작성합니다(사용자 승인 후 실행). 전화·주소·사업자번호·대표자명은 회사 화면에서 입력합니다.",
    parameters: { type: "object", properties: COMPANY_PROPS, required: ["name"] },
  },
  async prepare(a) {
    const p = parseCompanyFields(a, null);
    if (!p.ok) return { error: p.error };
    const dup = await duplicateCompany(p.data);
    if (dup) return duplicateError(dup);
    return {
      title: "회사 등록",
      changes: p.keys.filter((k) => text(p.data[k]) !== undefined).map((k) => companyChange(k, undefined, p.data[k])),
      args: pick(p.data, p.keys),
    };
  },
  async execute(client, userId, a) {
    const p = parseCompanyFields(a, null);
    if (!p.ok) return { ok: false, message: p.error };
    const r = await createCompany(client, userId, p.data);
    return r.ok ? { ok: true, message: "회사를 등록했습니다", target: companyTarget(r.company) } : { ok: false, message: r.error };
  },
};

const updateCompanyTool: WriteTool = {
  kind: "write",
  label: "회사 정보 수정",
  def: {
    name: "update_company",
    description: "회사 정보를 바꾸는 실행 계획을 작성합니다(사용자 승인 후 실행). 바꿀 항목만 넘기세요. 회사명을 바꾸면 연결된 리드의 회사명도 함께 바뀝니다.",
    parameters: { type: "object", properties: { companyId: { type: "string" }, ...COMPANY_PROPS }, required: ["companyId"] },
  },
  async prepare(a) {
    const id = idArg(a, "companyId");
    if (!id) return { error: "회사 id가 올바르지 않습니다" };
    const c = await findCompany(pool, id);
    if (!c) return { error: "회사를 찾을 수 없습니다" };
    const p = parseCompanyFields(a, companyInputOf(c));
    if (!p.ok) return { error: p.error };
    const { fields, set, expect } = diffFields(c, pick(p.data, p.keys));
    if (fields.length === 0) return { error: "바뀌는 항목이 없습니다" };
    if (fields.includes("name") || fields.includes("emailDomain")) {
      const dup = await duplicateCompany(p.data, id);
      if (dup) return duplicateError(dup);
    }
    const leads = fields.includes("name") ? await companyLeadCount(pool, id) : 0;
    return {
      title: "회사 정보 수정",
      changes: fields.map((f) => companyChange(f, c[f], set[f])),
      target: companyTarget(c),
      ...(leads > 0 ? { notice: { tone: "info" as const, text: `연결된 리드 ${leads}건의 회사명도 함께 바뀝니다` } } : {}),
      args: { companyId: id, ...set, expect },
    };
  },
  async execute(client, _userId, a, { meta }) {
    const id = idArg(a, "companyId");
    if (!id) return { ok: false, message: "회사 id가 올바르지 않습니다" };
    const c = await findCompany(client, id, { lock: true });
    if (!c) return { ok: false, message: "회사를 찾을 수 없습니다 (이미 삭제됐을 수 있습니다)" };
    if (!unchanged(c, a.expect)) return { ok: false, message: stale("회사 정보가") };
    const p = parseCompanyFields(a, companyInputOf(c));
    if (!p.ok) return { ok: false, message: p.error };
    const r = await updateCompany(client, id, p.data, meta);
    return r.ok ? { ok: true, message: "회사 정보를 수정했습니다", target: companyTarget(r.company) } : { ok: false, message: r.error };
  },
};

/* ───────── 연락처 변경 도구 ───────── */

/** 모델이 넘길 수 있는 연락처 항목 (이메일·전화·LinkedIn 제외) */
const CONTACT_FIELDS = ["name", "companyId", "department", "title", "role", "tags", "notes"] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];

const CONTACT_PROPS = {
  name: { type: "string", description: "이름" },
  companyId: { type: "string", description: "소속 회사 id (CRM 데이터의 companies.id, 빈 문자열이면 소속 없음)" },
  department: { type: "string", description: "부서" },
  title: { type: "string", description: "직함" },
  role: { type: "string", enum: CONTACT_ROLES.map((r) => r.id), description: CONTACT_ROLES.map((r) => `${r.id}=${r.label}`).join(", ") },
  tags: { type: "array", items: { type: "string" }, description: "태그 전체 (기존 태그를 대체)" },
  notes: { type: "string", description: "메모 전체 (기존 메모를 대체)" },
};

const parseContactFields = (a: Args, base: ContactInput | null) => parseFields(a, CONTACT_FIELDS, base, parseContactInput);

/** 카드 한 줄 (회사는 이름으로, 역할은 한국어로) */
async function contactChange(f: ContactField, before: unknown, after: unknown): Promise<AgentChange> {
  if (f === "companyId") {
    return { field: CONTACT_LABEL[f], before: await companyName(before as string | null), after: await companyName(after as string | null) };
  }
  if (f === "role") return { field: CONTACT_LABEL[f], before: roleName(before), after: roleName(after) };
  return { field: CONTACT_LABEL[f], before: text(before), after: text(after) };
}

/** 같은 회사에 같은 이름(공백·대소문자 무시)의 다른 연락처 */
async function samePerson(d: Pick<ContactInput, "name" | "companyId">, selfId: string | null = null) {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM contacts
     WHERE crm_person_key(name) = crm_person_key($1) AND company_id IS NOT DISTINCT FROM $2::uuid AND ($3::uuid IS NULL OR id <> $3)
     LIMIT 1`,
    [d.name, d.companyId, selfId]
  );
  return rows[0] ?? null;
}

const createContactTool: WriteTool = {
  kind: "write",
  label: "연락처 등록",
  def: {
    name: "create_contact",
    description:
      "새 연락처를 등록하는 실행 계획을 작성합니다(사용자 승인 후 실행). 이메일·전화번호·LinkedIn은 연락처 화면에서 입력합니다. " +
      "같은 회사에 같은 이름이 있으면 기존 연락처를 제안하고, 사용자가 다른 사람이라고 하면 allowSameName: true로 다시 호출하세요.",
    parameters: {
      type: "object",
      properties: {
        ...CONTACT_PROPS,
        newCompany: { type: "string", description: "CRM에 없는 회사명 (companyId 대신 — 승인하면 회사도 함께 등록)" },
        allowSameName: { type: "boolean", description: "같은 이름의 연락처가 있어도 새로 등록" },
      },
      required: ["name"],
    },
  },
  async prepare(a) {
    const p = parseContactFields(a, null);
    if (!p.ok) return { error: p.error };
    if (p.data.companyId && !(await companyName(p.data.companyId))) return { error: "회사를 찾을 수 없습니다" };
    // 없는 회사면 이 계획에서 회사도 함께 등록 (이미 있으면 그 회사 id로 다시 요청하게 한다)
    const newCompany = p.data.companyId ? "" : str(a.newCompany, 200).replace(/\s+/g, " ");
    if (newCompany) {
      const dupCompany = await duplicateCompany({ name: newCompany, emailDomain: null });
      if (dupCompany) return { error: `이미 등록된 회사입니다: ${dupCompany.name} (id ${dupCompany.id}). companyId로 지정하세요` };
    }
    const dup = a.allowSameName === true || newCompany ? null : await samePerson(p.data);
    if (dup) {
      return { error: `같은 회사에 같은 이름의 연락처가 이미 있습니다: ${dup.name} (id ${dup.id}). 같은 사람이면 기존 연락처를 쓰도록 안내하세요` };
    }
    const changes = await Promise.all(
      p.keys.filter((k) => text(p.data[k]) !== undefined).map((k) => contactChange(k, undefined, p.data[k]))
    );
    if (newCompany) changes.splice(1, 0, { field: CONTACT_LABEL.companyId, after: `${newCompany} (새 회사로 등록)` });
    return {
      title: newCompany ? "회사·연락처 등록" : "연락처 등록",
      changes,
      notice: { tone: "info", text: "이메일·전화번호는 등록 후 연락처 화면에서 입력하세요" },
      args: { ...pick(p.data, p.keys), ...(newCompany ? { newCompany } : {}) },
    };
  },
  async execute(client, userId, a) {
    const p = parseContactFields(a, null);
    if (!p.ok) return { ok: false, message: p.error };
    // 새 회사: 같은 트랜잭션에서 이름으로 찾거나 만든다 (그 사이 누가 등록했으면 그 회사로)
    const newCompany = p.data.companyId ? "" : str(a.newCompany, 200);
    if (newCompany) {
      const company = await resolveLeadCompany(client, null, newCompany, userId);
      if (!company) return { ok: false, message: "회사를 등록하지 못했습니다" };
      p.data.companyId = company.id;
    }
    const r = await createContact(client, userId, p.data);
    return r.ok ? { ok: true, message: "연락처를 등록했습니다", target: contactTarget(r.contact) } : { ok: false, message: r.error };
  },
};

const updateContactTool: WriteTool = {
  kind: "write",
  label: "연락처 수정",
  def: {
    name: "update_contact",
    description:
      "연락처 정보를 바꾸는 실행 계획을 작성합니다(사용자 승인 후 실행). 바꿀 항목만 넘기세요. 이름·직함을 바꾸면 담당 리드의 담당자 정보도 함께 바뀝니다. 이메일·전화번호는 연락처 화면에서 바꿉니다.",
    parameters: { type: "object", properties: { contactId: { type: "string" }, ...CONTACT_PROPS }, required: ["contactId"] },
  },
  async prepare(a) {
    const id = idArg(a, "contactId");
    if (!id) return { error: "연락처 id가 올바르지 않습니다" };
    const c = await findContact(pool, id);
    if (!c) return { error: "연락처를 찾을 수 없습니다" };
    const p = parseContactFields(a, contactInputOf(c));
    if (!p.ok) return { error: p.error };
    if (p.data.companyId && !(await companyName(p.data.companyId))) return { error: "회사를 찾을 수 없습니다" };
    const { fields, set, expect } = diffFields(c, pick(p.data, p.keys));
    if (fields.length === 0) return { error: "바뀌는 항목이 없습니다" };
    // 리드의 담당자 사본(이름·직함)이 바뀌는 경우만 리드에 영향
    const leads = fields.some((f) => f === "name" || f === "title") ? await contactLeadCount(id) : 0;
    return {
      title: "연락처 수정",
      changes: await Promise.all(fields.map((f) => contactChange(f, c[f], set[f]))),
      target: contactTarget(c),
      ...(leads > 0 ? { notice: { tone: "info" as const, text: `담당 리드 ${leads}건의 담당자 정보도 함께 바뀝니다` } } : {}),
      args: { contactId: id, ...set, expect },
    };
  },
  async execute(client, _userId, a, { meta }) {
    const id = idArg(a, "contactId");
    if (!id) return { ok: false, message: "연락처 id가 올바르지 않습니다" };
    const c = await findContact(client, id, { lock: true });
    if (!c) return { ok: false, message: "연락처를 찾을 수 없습니다 (이미 삭제됐을 수 있습니다)" };
    if (!unchanged(c, a.expect)) return { ok: false, message: stale("연락처가") };
    const p = parseContactFields(a, contactInputOf(c));
    if (!p.ok) return { ok: false, message: p.error };
    const r = await updateContact(client, id, p.data, { via: "contact", by: meta.via });
    return r.ok ? { ok: true, message: "연락처를 수정했습니다", target: contactTarget(r.contact) } : { ok: false, message: r.error };
  },
};

const linkContactTool: WriteTool = {
  kind: "write",
  label: "리드 담당자 연결",
  def: {
    name: "link_contact_to_lead",
    description: "리드의 담당 연락처를 지정하는 실행 계획을 작성합니다(사용자 승인 후 실행). 리드의 담당자 이름·직함·연락처가 그 연락처 값으로 바뀝니다.",
    parameters: {
      type: "object",
      properties: { leadId: { type: "string" }, contactId: { type: "string" } },
      required: ["leadId", "contactId"],
    },
  },
  async prepare(a) {
    const leadId = idArg(a, "leadId");
    const contactId = idArg(a, "contactId");
    if (!leadId || !contactId) return { error: "리드·연락처 id가 올바르지 않습니다" };
    const [lead, contact] = await Promise.all([findLead(pool, leadId), findContact(pool, contactId)]);
    if (!lead) return { error: "리드를 찾을 수 없습니다" };
    if (!contact) return { error: "연락처를 찾을 수 없습니다" };
    if (lead.contactId === contactId) return { error: `이미 ${contact.name} 님이 담당자로 연결되어 있습니다` };
    const before = lead.contactId ? (await findContact(pool, lead.contactId))?.name : undefined;
    const otherCompany = contact.companyId !== lead.companyId ? ((await companyName(contact.companyId)) ?? "소속 없음") : null;
    return {
      title: "리드 담당자 연결",
      changes: [
        { field: "담당 연락처", before, after: contact.name },
        ...(lead.title !== contact.title ? [{ field: "직함", before: text(lead.title), after: text(contact.title) }] : []),
      ],
      target: leadTarget(lead),
      ...(otherCompany
        ? { notice: { tone: "warning" as const, text: `리드 회사(${lead.company})가 아닌 ${otherCompany} 소속 연락처입니다` } }
        : {}),
      args: { leadId, contactId, expect: { contactId: lead.contactId } },
    };
  },
  async execute(client, userId, a, { meta }) {
    const leadId = idArg(a, "leadId");
    const contactId = idArg(a, "contactId");
    if (!leadId || !contactId) return { ok: false, message: "리드·연락처 id가 올바르지 않습니다" };
    const lead = await findLead(client, leadId, { lock: true });
    if (!lead) return { ok: false, message: "리드를 찾을 수 없습니다 (이미 삭제됐을 수 있습니다)" };
    if (!unchanged(lead, a.expect)) return { ok: false, message: stale("리드가") };
    const r = await linkContact(client, userId, leadId, contactId, meta);
    return r.ok ? { ok: true, message: "담당자를 연결했습니다", target: leadTarget(r.lead) } : { ok: false, message: r.error };
  },
};

/* ───────── 삭제 도구 (되돌릴 수 없음 → danger) ───────── */

const deleteCompanyTool: WriteTool = {
  kind: "write",
  label: "회사 삭제",
  def: {
    name: "delete_company",
    description: "회사를 삭제하는 실행 계획을 작성합니다(사용자 승인 후 실행). 연결된 리드가 있으면 삭제할 수 없습니다. 소속 연락처는 소속 없음이 되며 되돌릴 수 없습니다.",
    parameters: { type: "object", properties: { companyId: { type: "string" } }, required: ["companyId"] },
  },
  async prepare(a) {
    const id = idArg(a, "companyId");
    if (!id) return { error: "회사 id가 올바르지 않습니다" };
    const c = await findCompany(pool, id);
    if (!c) return { error: "회사를 찾을 수 없습니다" };
    const [leads, contacts] = await Promise.all([companyLeadCount(pool, id), companyContactCount(id)]);
    if (leads > 0) return { error: leadsBlockMessage(leads) };
    return {
      title: "회사 삭제",
      changes: [companyChange("name", c.name, undefined)],
      target: companyTarget(c),
      danger: true,
      approveLabel: "삭제 승인",
      ...(contacts > 0 ? { notice: { tone: "warning" as const, text: `소속 연락처 ${contacts}명은 소속 없음으로 바뀝니다` } } : {}),
      args: { companyId: id, expect: { name: c.name } },
    };
  },
  async execute(client, _userId, a) {
    const id = idArg(a, "companyId");
    if (!id) return { ok: false, message: "회사 id가 올바르지 않습니다" };
    const c = await findCompany(client, id, { lock: true });
    if (!c) return { ok: false, message: "회사를 찾을 수 없습니다 (이미 삭제됐을 수 있습니다)" };
    if (!unchanged(c, a.expect)) return { ok: false, message: stale("회사 정보가") };
    const r = await deleteCompany(client, id);
    return r.ok ? { ok: true, message: "회사를 삭제했습니다" } : { ok: false, message: r.error };
  },
};

const deleteContactTool: WriteTool = {
  kind: "write",
  label: "연락처 삭제",
  def: {
    name: "delete_contact",
    description: "연락처를 삭제하는 실행 계획을 작성합니다(사용자 승인 후 실행). 담당 리드는 연결만 끊기고 담당자 정보는 남습니다. 되돌릴 수 없습니다.",
    parameters: { type: "object", properties: { contactId: { type: "string" } }, required: ["contactId"] },
  },
  async prepare(a) {
    const id = idArg(a, "contactId");
    if (!id) return { error: "연락처 id가 올바르지 않습니다" };
    const c = await findContact(pool, id);
    if (!c) return { error: "연락처를 찾을 수 없습니다" };
    const leads = await contactLeadCount(id);
    return {
      title: "연락처 삭제",
      changes: [await contactChange("name", c.name, undefined)],
      target: contactTarget(c),
      danger: true,
      approveLabel: "삭제 승인",
      ...(leads > 0 ? { notice: { tone: "warning" as const, text: `담당 리드 ${leads}건은 연결만 끊기고 담당자 정보는 그대로 남습니다` } } : {}),
      args: { contactId: id, expect: { name: c.name } },
    };
  },
  async execute(client, _userId, a, { meta }) {
    const id = idArg(a, "contactId");
    if (!id) return { ok: false, message: "연락처 id가 올바르지 않습니다" };
    const c = await findContact(client, id, { lock: true });
    if (!c) return { ok: false, message: "연락처를 찾을 수 없습니다 (이미 삭제됐을 수 있습니다)" };
    if (!unchanged(c, a.expect)) return { ok: false, message: stale("연락처가") };
    const r = await deleteContact(client, id, { by: meta.via });
    return r.ok ? { ok: true, message: "연락처를 삭제했습니다" } : { ok: false, message: r.error };
  },
};

export const AGENT_CRM_TOOLS: AgentTool[] = [
  searchCompanies, getCompany, searchContacts, getContact,
  createCompanyTool, updateCompanyTool, createContactTool, updateContactTool, linkContactTool, deleteCompanyTool, deleteContactTool,
];
