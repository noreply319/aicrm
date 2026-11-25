import { NextResponse } from "next/server";
import { requestUserId } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withTransaction } from "@/lib/events";
import { NOTE_SUMMARY_COLUMNS, toNoteSummary, type NoteSummaryRow } from "@/lib/meetings";
import { createNote } from "@/lib/noteOps";
import { parseNoteInput, UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** 미팅 노트 목록 (미팅 일시 최신순). ?leadId= 로 리드별 조회 */
export async function GET(req: Request) {
  const leadId = new URL(req.url).searchParams.get("leadId");
  if (leadId !== null && !UUID_RE.test(leadId)) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  const { rows } = await pool.query<NoteSummaryRow>(
    `SELECT ${NOTE_SUMMARY_COLUMNS} FROM meeting_notes
     WHERE ($1::uuid IS NULL OR lead_id = $1)
     ORDER BY met_at DESC, created_at DESC`,
    [leadId]
  );
  return NextResponse.json(rows.map(toNoteSummary));
}

export async function POST(req: Request) {
  const parsed = parseNoteInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const userId = await requestUserId();
  const r = await withTransaction((client) => createNote(client, userId, parsed.data));
  return r.ok ? NextResponse.json(r.note, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
}
