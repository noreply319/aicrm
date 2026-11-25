import "server-only";
import type { PoolClient } from "pg";
import { leadCopyOf } from "./contact";
import { recordEvent } from "./events";
import type { Contact, ContactInput } from "./types";

export const CONTACT_COLUMNS = `
  id, name, company_id AS "companyId", department, title, email, mobile, office_phone AS "officePhone",
  linkedin_url AS "linkedinUrl", role, owner_id AS "ownerId", tags, notes,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export type ContactRow = Omit<Contact, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };

export const toContact = (r: ContactRow): Contact => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** INSERT/UPDATE 바인딩 순서: $1..$12 */
export const contactParams = (d: ContactInput) => [
  d.name, d.companyId, d.department, d.title, d.email, d.mobile, d.officePhone,
  d.linkedinUrl, d.role, d.ownerId, d.tags, d.notes,
];

export type ContactConflict = { ok: false; status: 409; error: string; existing: Contact | null };

/** 이메일 유니크 인덱스 위반(23505)이면 기존 연락처를 찾아 409 결과로 바꾼다 (그 밖의 에러는 그대로 던진다) */
export async function contactConflict(client: PoolClient, e: unknown, d: ContactInput, selfId: string | null = null): Promise<ContactConflict> {
  if ((e as { code?: string }).code !== "23505") throw e;
  const { rows } = await client.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE email = $1 AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
    [d.email, selfId]
  );
  const existing = rows[0] ? toContact(rows[0]) : null;
  return { ok: false, status: 409, error: `이미 등록된 이메일입니다: ${existing?.name ?? d.email}`, existing };
}

/** 회사·담당 영업이 실제로 있는지 확인. 문제가 있으면 에러 메시지 */
export async function checkContactRefs(client: PoolClient, d: ContactInput): Promise<string | null> {
  if (d.companyId && !(await client.query("SELECT 1 FROM companies WHERE id = $1", [d.companyId])).rowCount) {
    return "회사를 찾을 수 없습니다";
  }
  if (d.ownerId && !(await client.query("SELECT 1 FROM users WHERE id = $1", [d.ownerId])).rowCount) {
    return "담당 영업을 찾을 수 없습니다";
  }
  return null;
}

/** 리드 저장 시 담당 연락처의 사본 값 (없는 연락처면 null) */
export async function leadContactCopy(client: PoolClient, contactId: string) {
  const { rows } = await client.query<Pick<Contact, "name" | "title" | "email" | "mobile" | "officePhone">>(
    `SELECT name, title, email, mobile, office_phone AS "officePhone" FROM contacts WHERE id = $1`,
    [contactId]
  );
  return rows[0] ? leadCopyOf(rows[0]) : null;
}

type CopyRow = { id: string; company: string; contact: string; title: string; email: string; phone: string };
const COPY_FIELDS = ["contact", "title", "email", "phone"] as const;

/**
 * 연락처를 수정한 뒤 연결된 모든 리드(수주·실주 포함)의 담당자 사본을 바꾸고,
 * 바뀐 리드마다 updated 이력({ 바뀐 필드, ...meta(기본 via: "contact") })을 남긴다. 같은 트랜잭션의 client로 호출.
 */
export async function syncLeadCopies(
  client: PoolClient, contactId: string, c: Contact, meta: Record<string, unknown> = { via: "contact" }
): Promise<number> {
  const copy = leadCopyOf(c);
  const { rows } = await client.query<CopyRow>(
    `SELECT id, company, contact, title, email, phone FROM leads WHERE contact_id = $1 ORDER BY id FOR UPDATE`,
    [contactId]
  );
  let changed = 0;
  for (const l of rows) {
    const changes: Record<string, unknown> = {};
    for (const f of COPY_FIELDS) if (l[f] !== copy[f]) changes[f] = { from: l[f], to: copy[f] };
    if (!Object.keys(changes).length) continue;
    await client.query(
      "UPDATE leads SET contact = $2, title = $3, email = $4, phone = $5, updated_at = now() WHERE id = $1",
      [l.id, copy.contact, copy.title, copy.email, copy.phone]
    );
    await recordEvent(client, l.id, l.company, "updated", { ...changes, ...meta });
    changed++;
  }
  return changed;
}

/**
 * 연락처 삭제 전: 연결 리드의 연결만 끊고(사본은 유지) 리드마다 이력을 남긴다.
 * (FK가 ON DELETE SET NULL이지만 이력을 남기려고 먼저 직접 처리)
 */
export async function unlinkLeads(client: PoolClient, contactId: string, name: string): Promise<number> {
  const { rows } = await client.query<{ id: string; company: string }>(
    "UPDATE leads SET contact_id = NULL, updated_at = now() WHERE contact_id = $1 RETURNING id, company",
    [contactId]
  );
  for (const l of rows) await recordEvent(client, l.id, l.company, "updated", { contactLink: { from: name, to: null }, via: "contact_deleted" });
  return rows.length;
}
