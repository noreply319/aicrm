import "server-only";
import type { Pool, PoolClient } from "pg";
import { LEAD_COLUMNS, toLead, type LeadRow } from "./db";
import { resolveLeadCompany } from "./companies";
import { leadContactCopy } from "./contacts";
import { diffLead, recordEvent, snapshot } from "./events";
import type { Lead, LeadInput, StageId } from "./types";

/**
 * 리드 변경 로직 (Route Handler와 Sales Agent가 같은 코드를 쓴다).
 * 모두 호출한 쪽의 트랜잭션 client로 실행하고, 같은 트랜잭션에서 lead_events 이력을 남긴다.
 * meta는 이력 changes에 함께 남길 값 (예: { via: "agent" }).
 */
export type LeadOpResult = { ok: true; lead: Lead } | { ok: false; status: 400 | 404; error: string };
type Meta = Record<string, unknown>;

const NOT_FOUND = { ok: false, status: 404, error: "리드를 찾을 수 없습니다" } as const;
const NO_COMPANY = { ok: false, status: 400, error: "회사를 찾을 수 없습니다" } as const;
const NO_CONTACT = { ok: false, status: 400, error: "담당 연락처를 찾을 수 없습니다" } as const;

/** 리드 조회. lock이면 트랜잭션 안에서 잠근다 (변경 전 값 비교·이력용) */
export async function findLead(db: Pool | PoolClient, id: string, { lock = false } = {}): Promise<Lead | null> {
  const { rows } = await db.query<LeadRow>(`SELECT ${LEAD_COLUMNS} FROM leads WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
  return rows[0] ? toLead(rows[0]) : null;
}

/** 리드 → 전체 교체용 입력 (updateLead는 모든 필드를 덮어쓰므로 일부만 바꿀 때 현재 값과 합친다) */
export const leadInputOf = (l: Lead): LeadInput => ({
  companyId: l.companyId, company: l.company, contactId: l.contactId, contact: l.contact, title: l.title,
  email: l.email, phone: l.phone, value: l.value, closeDate: l.closeDate, stage: l.stage, priority: l.priority, notes: l.notes,
});

export async function createLead(client: PoolClient, userId: string | null, d: LeadInput, meta: Meta = {}): Promise<LeadOpResult> {
  // 회사: companyId로 지정하거나, 회사명만 오면 같은 이름의 회사를 찾거나 만든다
  const company = await resolveLeadCompany(client, d.companyId, d.company, userId);
  if (!company) return NO_COMPANY;
  // 담당 연락처가 있으면 담당자 사본은 연락처 값으로 채운다 (클라이언트 값 무시)
  const copy = d.contactId ? await leadContactCopy(client, d.contactId) : null;
  if (d.contactId && !copy) return NO_CONTACT;
  const c = { ...d, ...copy };
  const { rows } = await client.query<LeadRow>(
    `INSERT INTO leads (company_id, company, contact, title, email, phone, value, close_date, stage, priority, notes, contact_id, position)
     VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,
             (SELECT coalesce(max(position), 0) + 1 FROM leads))
     RETURNING ${LEAD_COLUMNS}`,
    [company.name, c.contact, c.title, c.email, c.phone, d.value, d.closeDate || null, d.stage, d.priority, d.notes, company.id, d.contactId]
  );
  const created = toLead(rows[0]);
  await recordEvent(client, created.id, created.company, "created", { ...snapshot(created), ...meta });
  return { ok: true, lead: created };
}

/** 전체 값 교체 (PATCH). 일부만 바꾸려면 호출 전에 현재 값과 합친다 */
export async function updateLead(
  client: PoolClient, userId: string | null, id: string, d: LeadInput, meta: Meta = {},
  /** 필드 비교로는 안 보이는 변경 (예: 연결 연락처) — 있으면 항상 이력을 남긴다 */
  extra: Meta = {}
): Promise<LeadOpResult> {
  const before = await findLead(client, id, { lock: true });
  if (!before) return NOT_FOUND;

  const company = await resolveLeadCompany(client, d.companyId, d.company, userId);
  if (!company) return NO_COMPANY;
  const copy = d.contactId ? await leadContactCopy(client, d.contactId) : null;
  if (d.contactId && !copy) return NO_CONTACT;
  const input = { ...d, ...copy, companyId: company.id, company: company.name };

  const { rows } = await client.query<LeadRow>(
    `UPDATE leads SET company_id=$12, company=$2, contact=$3, title=$4, email=$5, phone=$6, value=$7,
            close_date=$8, stage=$9, priority=$10, notes=$11, contact_id=$13, updated_at=now()
     WHERE id=$1
     RETURNING ${LEAD_COLUMNS}`,
    [id, input.company, input.contact, input.title, input.email, input.phone, d.value, d.closeDate || null, d.stage, d.priority, d.notes,
      company.id, d.contactId]
  );
  const changes = { ...diffLead(before, input), ...extra };
  if (Object.keys(changes).length > 0) await recordEvent(client, id, input.company, "updated", { ...changes, ...meta });
  return { ok: true, lead: toLead(rows[0]) };
}

/**
 * 리드의 담당 연락처 연결(contactId=null이면 해제). 담당자 사본은 연락처 값으로 바뀌고,
 * 이력에 contactLink { from, to }(연락처 이름)를 남긴다.
 */
export async function linkContact(
  client: PoolClient, userId: string | null, id: string, contactId: string | null, meta: Meta = {}
): Promise<LeadOpResult> {
  const lead = await findLead(client, id, { lock: true });
  if (!lead) return NOT_FOUND;
  const names = await client.query<{ id: string; name: string }>("SELECT id, name FROM contacts WHERE id = ANY($1)", [
    [lead.contactId, contactId].filter((x): x is string => !!x),
  ]);
  const nameOf = (cid: string | null) => (cid ? (names.rows.find((r) => r.id === cid)?.name ?? null) : null);
  if (contactId && !nameOf(contactId)) return NO_CONTACT;
  return updateLead(client, userId, id, { ...leadInputOf(lead), contactId }, meta, {
    contactLink: { from: nameOf(lead.contactId), to: nameOf(contactId) },
  });
}

/**
 * 카드 이동: beforeId 카드 바로 앞에 오도록 두 이웃 position의 중간값을 부여한다 (null이면 맨 뒤).
 * 같은 단계 안에서 순서만 바뀐 경우는 이력을 남기지 않는다.
 */
export async function moveLead(
  client: PoolClient, id: string, stage: StageId, beforeId: string | null, meta: Meta = {}
): Promise<LeadOpResult> {
  // 먼저 잠그고(동시 이동 방지) 없으면 위치 계산 없이 404
  const prev = await findLead(client, id, { lock: true });
  if (!prev) return NOT_FOUND;

  let position: number;
  const before = beforeId
    ? (await client.query<{ position: number }>("SELECT position FROM leads WHERE id=$1", [beforeId])).rows[0]
    : undefined;
  if (before) {
    const { rows } = await client.query<{ prev: number | null }>(
      "SELECT max(position) AS prev FROM leads WHERE position < $1 AND id <> $2",
      [before.position, id]
    );
    const p = rows[0].prev;
    position = p === null ? before.position - 1 : (p + before.position) / 2;
  } else {
    const { rows } = await client.query<{ max: number | null }>("SELECT max(position) AS max FROM leads WHERE id <> $1", [id]);
    position = (rows[0].max ?? 0) + 1;
  }

  const { rows } = await client.query<LeadRow>(
    `UPDATE leads SET stage=$2, position=$3, updated_at=now() WHERE id=$1 RETURNING ${LEAD_COLUMNS}`,
    [id, stage, position]
  );
  if (prev.stage !== stage) {
    await recordEvent(client, id, rows[0].company, "moved", { stage: { from: prev.stage, to: stage }, ...meta });
  }
  return { ok: true, lead: toLead(rows[0]) };
}

export async function deleteLead(client: PoolClient, id: string, meta: Meta = {}): Promise<LeadOpResult> {
  const { rows } = await client.query<LeadRow>(`DELETE FROM leads WHERE id=$1 RETURNING ${LEAD_COLUMNS}`, [id]);
  if (!rows[0]) return NOT_FOUND;
  const lead = toLead(rows[0]);
  await recordEvent(client, id, lead.company, "deleted", { ...snapshot(lead), ...meta });
  return { ok: true, lead };
}
