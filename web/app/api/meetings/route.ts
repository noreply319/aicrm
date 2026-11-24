import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { recordEvent, withTransaction } from "@/lib/events";
import { NOTE_COLUMNS, NOTE_SUMMARY_COLUMNS, noteSnapshot, toNote, toNoteSummary, type NoteRow, type NoteSummaryRow } from "@/lib/meetings";
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
  const d = parsed.data;

  const note = await withTransaction(async (client) => {
    const lead = (
      await client.query<{ company: string }>("SELECT company FROM leads WHERE id=$1 FOR SHARE", [d.leadId])
    ).rows[0];
    if (!lead) return null;

    const { rows } = await client.query<NoteRow>(
      `INSERT INTO meeting_notes (lead_id, title, met_at, body, source, summary, next_actions)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${NOTE_COLUMNS}`,
      [d.leadId, d.title, d.metAt, d.body, d.source, d.summary, d.nextActions]
    );
    const created = toNote(rows[0]);
    await recordEvent(client, d.leadId, lead.company, "note_created", noteSnapshot(created));
    return created;
  });
  if (!note) return NextResponse.json({ error: "연결할 리드를 찾을 수 없습니다" }, { status: 400 });
  return NextResponse.json(note, { status: 201 });
}
