import { NextResponse } from "next/server";
import {
  COMPANY_COLUMNS, CompanyConflictError, companyParams, conflictFromError, ownerExists, toCompany, type CompanyRow,
} from "@/lib/companies";
import { pool } from "@/lib/db";
import { recordEvent, withTransaction } from "@/lib/events";
import { parseCompanyInput, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "회사를 찾을 수 없습니다" }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const { rows } = await pool.query<CompanyRow>(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = $1`, [id]);
  return rows[0] ? NextResponse.json(toCompany(rows[0])) : notFound();
}

/** 회사 수정. 이름을 바꾸면 연결 리드의 회사명 사본도 바꾸고 리드마다 updated 이력을 남긴다 (같은 트랜잭션). */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const parsed = parseCompanyInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const d = parsed.data;

  try {
    const result = await withTransaction(async (client) => {
      const before = (await client.query<{ name: string }>("SELECT name FROM companies WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!before) return null;
      if (!(await ownerExists(client, d.ownerId))) return "no-owner" as const;

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
        return conflictFromError(client, e, d, id);
      }

      if (before.name !== d.name) {
        const { rows: leads } = await client.query<{ id: string; old: string }>(
          `UPDATE leads l SET company = $2, updated_at = now()
           FROM (SELECT id, company AS old FROM leads WHERE company_id = $1 FOR UPDATE) o
           WHERE l.id = o.id AND o.old <> $2
           RETURNING l.id, o.old`,
          [id, d.name]
        );
        for (const l of leads) await recordEvent(client, l.id, d.name, "updated", { company: { from: l.old, to: d.name } });
      }
      return toCompany(row);
    });
    if (result === "no-owner") return NextResponse.json({ error: "담당 영업을 찾을 수 없습니다" }, { status: 400 });
    return result ? NextResponse.json(result) : notFound();
  } catch (e) {
    if (e instanceof CompanyConflictError) return NextResponse.json({ error: e.message, company: e.existing }, { status: 409 });
    throw e;
  }
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
