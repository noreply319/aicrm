import { NextResponse } from "next/server";
import { LEAD_COLUMNS, toLead, type LeadRow } from "@/lib/db";
import { requestUserId } from "@/lib/auth";
import { resolveLeadCompany } from "@/lib/companies";
import { diffLead, recordEvent, snapshot, withTransaction } from "@/lib/events";
import { parseLeadInput, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "리드를 찾을 수 없습니다" }, { status: 404 });

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const parsed = parseLeadInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const d = parsed.data;

  const userId = await requestUserId();
  const result = await withTransaction(async (client) => {
    // 변경 전 값을 잠금 조회해 이력(diff)을 만든다
    const before = (
      await client.query<LeadRow>(`SELECT ${LEAD_COLUMNS} FROM leads WHERE id=$1 FOR UPDATE`, [id])
    ).rows[0];
    if (!before) return null;

    const company = await resolveLeadCompany(client, d.companyId, d.company, userId);
    if (!company) return "no-company" as const;
    const input = { ...d, companyId: company.id, company: company.name };

    const { rows } = await client.query<LeadRow>(
      `UPDATE leads SET company_id=$12, company=$2, contact=$3, title=$4, email=$5, phone=$6, value=$7,
              close_date=$8, stage=$9, priority=$10, notes=$11, updated_at=now()
       WHERE id=$1
       RETURNING ${LEAD_COLUMNS}`,
      [id, input.company, d.contact, d.title, d.email, d.phone, d.value, d.closeDate || null, d.stage, d.priority, d.notes, company.id]
    );
    const changes = diffLead(toLead(before), input);
    if (Object.keys(changes).length > 0) await recordEvent(client, id, input.company, "updated", changes);
    return toLead(rows[0]);
  });
  if (result === "no-company") return NextResponse.json({ error: "회사를 찾을 수 없습니다" }, { status: 400 });
  return result ? NextResponse.json(result) : notFound();
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const deleted = await withTransaction(async (client) => {
    const { rows } = await client.query<LeadRow>(`DELETE FROM leads WHERE id=$1 RETURNING ${LEAD_COLUMNS}`, [id]);
    if (!rows[0]) return false;
    const lead = toLead(rows[0]);
    await recordEvent(client, id, lead.company, "deleted", snapshot(lead));
    return true;
  });
  return deleted ? new NextResponse(null, { status: 204 }) : notFound();
}
