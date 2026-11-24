import { NextResponse } from "next/server";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "@/lib/db";
import { requestUserId } from "@/lib/auth";
import { resolveLeadCompany } from "@/lib/companies";
import { leadContactCopy } from "@/lib/contacts";
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
  const result = await withTransaction(async (client) => {
    // 회사: companyId로 지정하거나, 회사명만 오면 같은 이름의 회사를 찾거나 만든다
    const company = await resolveLeadCompany(client, d.companyId, d.company, userId);
    if (!company) return "no-company" as const;
    // 담당 연락처가 있으면 담당자 사본은 연락처 값으로 채운다 (클라이언트 값 무시)
    const copy = d.contactId ? await leadContactCopy(client, d.contactId) : null;
    if (d.contactId && !copy) return "no-contact" as const;
    const c = { ...d, ...copy };
    const { rows } = await client.query<LeadRow>(
      `INSERT INTO leads (company_id, company, contact, title, email, phone, value, close_date, stage, priority, notes, contact_id, position)
       VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,
               (SELECT coalesce(max(position), 0) + 1 FROM leads))
       RETURNING ${LEAD_COLUMNS}`,
      [company.name, c.contact, c.title, c.email, c.phone, d.value, d.closeDate || null, d.stage, d.priority, d.notes, company.id, d.contactId]
    );
    const created = toLead(rows[0]);
    await recordEvent(client, created.id, created.company, "created", snapshot(created));
    return created;
  });
  if (result === "no-company") return NextResponse.json({ error: "회사를 찾을 수 없습니다" }, { status: 400 });
  if (result === "no-contact") return NextResponse.json({ error: "담당 연락처를 찾을 수 없습니다" }, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}
