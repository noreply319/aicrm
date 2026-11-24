import { NextResponse } from "next/server";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "@/lib/db";
import { requestUserId } from "@/lib/auth";
import { resolveLeadCompany } from "@/lib/companies";
import { recordEvent, snapshot, withTransaction } from "@/lib/events";
import { parseLeadInput } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET() {
  const { rows } = await pool.query<LeadRow>(
    `SELECT ${LEAD_COLUMNS} FROM leads ORDER BY position`
  );
  return NextResponse.json(rows.map(toLead));
}

export async function POST(req: Request) {
  const parsed = parseLeadInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const d = parsed.data;

  const userId = await requestUserId();
  const lead = await withTransaction(async (client) => {
    // 회사: companyId로 지정하거나, 회사명만 오면 같은 이름의 회사를 찾거나 만든다
    const company = await resolveLeadCompany(client, d.companyId, d.company, userId);
    if (!company) return null;
    const { rows } = await client.query<LeadRow>(
      `INSERT INTO leads (company_id, company, contact, title, email, phone, value, close_date, stage, priority, notes, position)
       VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               (SELECT coalesce(max(position), 0) + 1 FROM leads))
       RETURNING ${LEAD_COLUMNS}`,
      [company.name, d.contact, d.title, d.email, d.phone, d.value, d.closeDate || null, d.stage, d.priority, d.notes, company.id]
    );
    const created = toLead(rows[0]);
    await recordEvent(client, created.id, created.company, "created", snapshot(created));
    return created;
  });
  if (!lead) return NextResponse.json({ error: "회사를 찾을 수 없습니다" }, { status: 400 });
  return NextResponse.json(lead, { status: 201 });
}
