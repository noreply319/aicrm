import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import {
  COMPANY_COLUMNS, CompanyConflictError, companyParams, conflictFromError, ownerExists, toCompany, type CompanyRow,
} from "@/lib/companies";
import { pool } from "@/lib/db";
import { withTransaction } from "@/lib/events";
import { parseCompanyInput } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 회사 목록 (이름순). 리드 수·금액 집계는 클라이언트가 leads로 계산한다. */
export async function GET() {
  const { rows } = await pool.query<CompanyRow>(`SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY name`);
  return NextResponse.json(rows.map(toCompany));
}

/** 회사 생성. { name }만 보내도 된다. 같은 이름·도메인이 있으면 409 + { error, company: 기존 회사 } */
export async function POST(req: Request) {
  const parsed = parseCompanyInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const d = parsed.data;
  const userId = await requestUserId();

  try {
    const company = await withTransaction(async (client) => {
      if (!(await ownerExists(client, d.ownerId))) return null;
      try {
        await client.query("SAVEPOINT ins");
        const { rows } = await client.query<CompanyRow>(
          `INSERT INTO companies (name, name_key, website, email_domain, industry, size, phone, address,
                                  business_number, ceo_name, owner_id, tier, tags, notes, created_by)
           VALUES ($1, crm_company_key($1), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING ${COMPANY_COLUMNS}`,
          [...companyParams(d), userId]
        );
        return toCompany(rows[0]);
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT ins");
        return conflictFromError(client, e, d);
      }
    });
    if (!company) return NextResponse.json({ error: "담당 영업을 찾을 수 없습니다" }, { status: 400 });
    return NextResponse.json(company, { status: 201 });
  } catch (e) {
    if (e instanceof CompanyConflictError) return NextResponse.json({ error: e.message, company: e.existing }, { status: 409 });
    throw e;
  }
}
