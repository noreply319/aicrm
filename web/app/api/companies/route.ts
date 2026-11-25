import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { COMPANY_COLUMNS, toCompany, type CompanyRow } from "@/lib/companies";
import { createCompany } from "@/lib/companyOps";
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
  const userId = await requestUserId();

  const r = await withTransaction((client) => createCompany(client, userId, parsed.data));
  if (r.ok) return NextResponse.json(r.company, { status: 201 });
  return NextResponse.json(r.status === 409 ? { error: r.error, company: r.existing } : { error: r.error }, { status: r.status });
}
