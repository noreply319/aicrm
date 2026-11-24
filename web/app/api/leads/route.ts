import { NextResponse } from "next/server";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "@/lib/db";
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

  const lead = await withTransaction(async (client) => {
    const { rows } = await client.query<LeadRow>(
      `INSERT INTO leads (company, contact, title, email, phone, value, close_date, stage, priority, notes, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               (SELECT coalesce(max(position), 0) + 1 FROM leads))
       RETURNING ${LEAD_COLUMNS}`,
      [d.company, d.contact, d.title, d.email, d.phone, d.value, d.closeDate || null, d.stage, d.priority, d.notes]
    );
    const created = toLead(rows[0]);
    await recordEvent(client, created.id, created.company, "created", snapshot(created));
    return created;
  });
  return NextResponse.json(lead, { status: 201 });
}
