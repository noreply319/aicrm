import { NextResponse } from "next/server";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "@/lib/db";
import { requestUserId } from "@/lib/auth";
import { withTransaction } from "@/lib/events";
import { createLead } from "@/lib/leadOps";
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

  const userId = await requestUserId();
  const result = await withTransaction((client) => createLead(client, userId, parsed.data));
  return result.ok
    ? NextResponse.json(result.lead, { status: 201 })
    : NextResponse.json({ error: result.error }, { status: result.status });
}
