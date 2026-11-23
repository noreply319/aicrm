import { NextResponse } from "next/server";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "@/lib/db";
import { parseLeadInput, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "리드를 찾을 수 없습니다" }, { status: 404 });

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const parsed = parseLeadInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const d = parsed.data;

  const { rows } = await pool.query<LeadRow>(
    `UPDATE leads SET company=$2, contact=$3, title=$4, email=$5, phone=$6, value=$7,
            close_date=$8, stage=$9, priority=$10, notes=$11, updated_at=now()
     WHERE id=$1
     RETURNING ${LEAD_COLUMNS}`,
    [id, d.company, d.contact, d.title, d.email, d.phone, d.value, d.closeDate || null, d.stage, d.priority, d.notes]
  );
  return rows[0] ? NextResponse.json(toLead(rows[0])) : notFound();
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const { rowCount } = await pool.query("DELETE FROM leads WHERE id=$1", [id]);
  return rowCount ? new NextResponse(null, { status: 204 }) : notFound();
}
