import "server-only";
import type { Pool, PoolClient } from "pg";
import type { Company, CompanyInput } from "./types";

export const COMPANY_COLUMNS = `
  id, name, website, email_domain AS "emailDomain", industry, size, phone, address,
  business_number AS "businessNumber", ceo_name AS "ceoName", owner_id AS "ownerId", tier, tags, notes,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export type CompanyRow = Omit<Company, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };

export const toCompany = (r: CompanyRow): Company => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** INSERT/UPDATE 바인딩 순서: $1..$13 */
export const companyParams = (d: CompanyInput) => [
  d.name, d.website, d.emailDomain, d.industry, d.size, d.phone, d.address,
  d.businessNumber, d.ceoName, d.ownerId, d.tier, d.tags, d.notes,
];

export type CompanyConflict = { ok: false; status: 409; error: string; existing: Company | null };

/** 유니크 인덱스 위반(23505)이면 어느 항목이 겹쳤는지 찾아 409 결과로 바꾼다 (그 밖의 에러는 그대로 던진다) */
export async function companyConflict(client: PoolClient, e: unknown, d: CompanyInput, selfId: string | null = null): Promise<CompanyConflict> {
  const err = e as { code?: string; constraint?: string };
  if (err.code !== "23505") throw e;
  if (err.constraint === "companies_email_domain_idx") {
    const existing = await findBy(client, "email_domain = $1", d.emailDomain, selfId);
    return { ok: false, status: 409, error: `이메일 도메인 ${d.emailDomain}은(는) 이미 '${existing?.name ?? "다른 회사"}'에 등록되어 있습니다`, existing };
  }
  const existing = await findBy(client, "name_key = crm_company_key($1)", d.name, selfId);
  return { ok: false, status: 409, error: `이미 등록된 회사입니다: ${existing?.name ?? d.name}`, existing };
}

async function findBy(client: PoolClient, where: string, value: unknown, selfId: string | null): Promise<Company | null> {
  const { rows } = await client.query<CompanyRow>(
    `SELECT ${COMPANY_COLUMNS} FROM companies WHERE ${where} AND ($2::uuid IS NULL OR id <> $2) LIMIT 1`,
    [value, selfId]
  );
  return rows[0] ? toCompany(rows[0]) : null;
}

/**
 * 같은 회사 찾기: 정규화 이름(name_key)이나 이메일 도메인이 같은 회사 (도메인 일치 우선).
 * Sales Agent 중복 확인·명함 등록이 같이 쓴다.
 */
export async function findCompanyMatch(
  db: Pool | PoolClient, d: { name: string; emailDomain: string | null }, selfId: string | null = null
): Promise<{ company: Company; byDomain: boolean } | null> {
  const { rows } = await db.query<CompanyRow & { byDomain: boolean }>(
    `SELECT ${COMPANY_COLUMNS}, coalesce(email_domain = $2, false) AS "byDomain" FROM companies
     WHERE ((length($1) > 0 AND name_key = crm_company_key($1)) OR ($2::text IS NOT NULL AND email_domain = $2))
       AND ($3::uuid IS NULL OR id <> $3)
     ORDER BY "byDomain" DESC
     LIMIT 1`,
    [d.name, d.emailDomain, selfId]
  );
  if (!rows[0]) return null;
  const { byDomain, ...row } = rows[0];
  return { company: toCompany(row), byDomain };
}

/** 담당 영업이 실제 사용자인지 확인 (없는 id면 false) */
export async function ownerExists(client: PoolClient, ownerId: string | null): Promise<boolean> {
  if (!ownerId) return true;
  const { rowCount } = await client.query("SELECT 1 FROM users WHERE id = $1", [ownerId]);
  return Boolean(rowCount);
}

/**
 * 리드 저장 시 회사 결정: companyId가 있으면 그 회사, 없으면 같은 정규화 이름의 회사를 찾거나 이름만으로 만든다.
 * 회사가 없으면 null. 반환한 name을 리드의 회사명 사본으로 저장한다.
 */
export async function resolveLeadCompany(
  client: PoolClient,
  companyId: string | null,
  name: string,
  userId: string | null
): Promise<{ id: string; name: string } | null> {
  if (companyId) {
    const { rows } = await client.query<{ id: string; name: string }>("SELECT id, name FROM companies WHERE id = $1", [companyId]);
    return rows[0] ?? null;
  }
  // 동시에 같은 이름을 만들면 첫 시도에서 상대 행이 안 보일 수 있어 한 번 더 조회한다
  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows } = await client.query<{ id: string; name: string }>(
    `WITH ins AS (
       INSERT INTO companies (name, name_key, created_by) VALUES ($1, crm_company_key($1), $2)
       ON CONFLICT (name_key) DO NOTHING
       RETURNING id, name
     )
     SELECT id, name FROM ins
     UNION ALL
     SELECT id, name FROM companies WHERE name_key = crm_company_key($1)
     LIMIT 1`,
    [name, userId]
    );
    if (rows[0]) return rows[0];
  }
  return null;
}
