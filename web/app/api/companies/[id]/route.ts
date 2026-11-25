import { NextResponse } from "next/server";
import { findCompany, updateCompany } from "@/lib/companyOps";
import { pool } from "@/lib/db";
import { withTransaction } from "@/lib/events";
import { parseCompanyInput, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "회사를 찾을 수 없습니다" }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const company = await findCompany(pool, id);
  return company ? NextResponse.json(company) : notFound();
}

/** 회사 수정. 이름을 바꾸면 연결 리드의 회사명 사본도 바꾸고 리드마다 updated 이력을 남긴다 (같은 트랜잭션). */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const parsed = parseCompanyInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const r = await withTransaction((client) => updateCompany(client, id, parsed.data));
  if (r.ok) return NextResponse.json(r.company);
  return NextResponse.json(r.status === 409 ? { error: r.error, company: r.existing } : { error: r.error }, { status: r.status });
}

/** 회사 삭제. 연결된 리드가 있으면 409 (리드를 다른 회사로 옮기거나 삭제한 뒤 삭제) */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM leads WHERE company_id = $1", [id]);
  if (rows[0].n > 0) {
    return NextResponse.json(
      { error: `연결된 리드 ${rows[0].n}건이 있어 삭제할 수 없습니다. 리드를 다른 회사로 옮기거나 삭제해 주세요` },
      { status: 409 }
    );
  }
  try {
    const { rowCount } = await pool.query("DELETE FROM companies WHERE id = $1", [id]);
    return rowCount ? new NextResponse(null, { status: 204 }) : notFound();
  } catch (e) {
    // 확인과 삭제 사이에 리드가 연결된 경우 (FK RESTRICT)
    if ((e as { code?: string }).code === "23503") {
      return NextResponse.json({ error: "연결된 리드가 있어 삭제할 수 없습니다" }, { status: 409 });
    }
    throw e;
  }
}
