import "server-only";
import type { Pool, PoolClient } from "pg";
import {
  COMPANY_COLUMNS, companyConflict, companyParams, ownerExists, toCompany, type CompanyConflict, type CompanyRow,
} from "./companies";
import { recordEvent } from "./events";
import type { Company, CompanyInput } from "./types";

/**
 * 회사 생성·수정·삭제 로직 (Route Handler와 Sales Agent가 같은 코드를 쓴다). 호출한 쪽의 트랜잭션 client로 실행.
 * 중복(유니크 위반)은 SAVEPOINT로 되돌린 뒤 409 결과로 돌려준다 — 트랜잭션은 계속 쓸 수 있다.
 * meta는 회사명 변경으로 바뀐 리드 이력에 함께 남길 값 (예: { via: "agent" }).
 */
export type CompanyOpResult = { ok: true; company: Company } | { ok: false; status: 400 | 404; error: string } | CompanyConflict;

type Meta = Record<string, unknown>;

const NO_OWNER = { ok: false, status: 400, error: "담당 영업을 찾을 수 없습니다" } as const;

export async function findCompany(db: Pool | PoolClient, id: string, { lock = false } = {}): Promise<Company | null> {
  const { rows } = await db.query<CompanyRow>(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  return rows[0] ? toCompany(rows[0]) : null;
}

/** 회사 → 전체 교체용 입력 (updateCompany는 모든 필드를 덮어쓰므로 일부만 바꿀 때 현재 값과 합친다) */
export const companyInputOf = (c: Company): CompanyInput => ({
  name: c.name, website: c.website, emailDomain: c.emailDomain, industry: c.industry, size: c.size, phone: c.phone,
  address: c.address, businessNumber: c.businessNumber, ceoName: c.ceoName, ownerId: c.ownerId, tier: c.tier, tags: c.tags, notes: c.notes,
});

export async function createCompany(client: PoolClient, userId: string | null, d: CompanyInput): Promise<CompanyOpResult> {
  if (!(await ownerExists(client, d.ownerId))) return NO_OWNER;
  try {
    await client.query("SAVEPOINT ins");
    const { rows } = await client.query<CompanyRow>(
      `INSERT INTO companies (name, name_key, website, email_domain, industry, size, phone, address,
                              business_number, ceo_name, owner_id, tier, tags, notes, created_by)
       VALUES ($1, crm_company_key($1), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${COMPANY_COLUMNS}`,
      [...companyParams(d), userId]
    );
    return { ok: true, company: toCompany(rows[0]) };
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT ins");
    return companyConflict(client, e, d);
  }
}

/** 전체 값 교체. 이름을 바꾸면 연결 리드의 회사명 사본도 바꾸고 리드마다 updated 이력을 남긴다 */
export async function updateCompany(client: PoolClient, id: string, d: CompanyInput, meta: Meta = {}): Promise<CompanyOpResult> {
  const before = (await client.query<{ name: string }>("SELECT name FROM companies WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!before) return { ok: false, status: 404, error: "회사를 찾을 수 없습니다" };
  if (!(await ownerExists(client, d.ownerId))) return NO_OWNER;

  let row: CompanyRow;
  try {
    await client.query("SAVEPOINT upd");
    row = (
      await client.query<CompanyRow>(
        `UPDATE companies SET name=$1, name_key=crm_company_key($1), website=$2, email_domain=$3, industry=$4, size=$5,
                phone=$6, address=$7, business_number=$8, ceo_name=$9, owner_id=$10, tier=$11, tags=$12, notes=$13,
                updated_at=now()
         WHERE id=$14
         RETURNING ${COMPANY_COLUMNS}`,
        [...companyParams(d), id]
      )
    ).rows[0];
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT upd");
    return companyConflict(client, e, d, id);
  }

  if (before.name !== d.name) {
    const { rows: leads } = await client.query<{ id: string; old: string }>(
      `UPDATE leads l SET company = $2, updated_at = now()
       FROM (SELECT id, company AS old FROM leads WHERE company_id = $1 FOR UPDATE) o
       WHERE l.id = o.id AND o.old <> $2
       RETURNING l.id, o.old`,
      [id, d.name]
    );
    for (const l of leads) await recordEvent(client, l.id, d.name, "updated", { company: { from: l.old, to: d.name }, ...meta });
  }
  return { ok: true, company: toCompany(row) };
}

export type CompanyDeleteResult = { ok: true; name: string } | { ok: false; status: 404 | 409; error: string };

/** 회사에 연결된 리드 수 (회사 삭제 가능 여부·회사명 변경 전파 건수) */
export async function companyLeadCount(db: Pool | PoolClient, id: string): Promise<number> {
  return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM leads WHERE company_id = $1", [id])).rows[0].n;
}

/** 연결된 리드가 있어 회사를 삭제할 수 없을 때 안내 (API·Agent 공용) */
export const leadsBlockMessage = (n: number) =>
  `연결된 리드 ${n}건이 있어 삭제할 수 없습니다. 리드를 다른 회사로 옮기거나 삭제해 주세요`;

/** 연결된 리드가 있으면 삭제하지 않는다 (FK RESTRICT). 소속 연락처는 FK에 따라 소속 없음이 된다 */
export async function deleteCompany(client: PoolClient, id: string): Promise<CompanyDeleteResult> {
  const row = (await client.query<{ name: string }>("SELECT name FROM companies WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!row) return { ok: false, status: 404, error: "회사를 찾을 수 없습니다" };
  const n = await companyLeadCount(client, id);
  if (n > 0) return { ok: false, status: 409, error: leadsBlockMessage(n) };
  try {
    await client.query("SAVEPOINT del");
    await client.query("DELETE FROM companies WHERE id = $1", [id]);
  } catch (e) {
    // 확인과 삭제 사이에 리드가 연결된 경우 (FK RESTRICT)
    if ((e as { code?: string }).code !== "23503") throw e;
    await client.query("ROLLBACK TO SAVEPOINT del");
    return { ok: false, status: 409, error: "연결된 리드가 있어 삭제할 수 없습니다" };
  }
  return { ok: true, name: row.name };
}
