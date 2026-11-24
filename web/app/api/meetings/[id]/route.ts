import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { recordEvent, withTransaction } from "@/lib/events";
import { diffNote, NOTE_COLUMNS, noteSnapshot, toNote, type NoteRow } from "@/lib/meetings";
import { parseNoteInput, UUID_RE } from "@/lib/validate";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "미팅 노트를 찾을 수 없습니다" }, { status: 404 });

/** 노트 상세 (본문 전체) */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();
  const { rows } = await pool.query<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM meeting_notes WHERE id=$1`, [id]);
  return rows[0] ? NextResponse.json(toNote(rows[0])) : notFound();
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const parsed = parseNoteInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const d = parsed.data;

  const result = await withTransaction(async (client) => {
    const before = (
      await client.query<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM meeting_notes WHERE id=$1 FOR UPDATE`, [id])
    ).rows[0];
    if (!before) return "not_found" as const;

    const lead = d.leadId
      ? (await client.query<{ company: string }>("SELECT company FROM leads WHERE id=$1 FOR SHARE", [d.leadId])).rows[0]
      : undefined;
    if (d.leadId && !lead) return "no_lead" as const;

    const { rows } = await client.query<NoteRow>(
      `UPDATE meeting_notes SET lead_id=$2, title=$3, met_at=$4, body=$5, source=$6,
              summary=$7, next_actions=$8, updated_at=now()
       WHERE id=$1
       RETURNING ${NOTE_COLUMNS}`,
      [id, d.leadId, d.title, d.metAt, d.body, d.source, d.summary, d.nextActions]
    );
    const changes = diffNote(toNote(before), d);
    if (Object.keys(changes).length > 0) {
      const payload = { noteId: id, title: d.title, ...changes };
      // 이력은 리드 기준: 새로 연결된(또는 계속 연결된) 리드에 기록
      if (d.leadId && lead) await recordEvent(client, d.leadId, lead.company, "note_updated", payload);
      // 다른 리드로 옮기거나 연결을 해제하면 이전 리드에도 남긴다
      if (before.leadId && before.leadId !== d.leadId) {
        const prev = (await client.query<{ company: string }>("SELECT company FROM leads WHERE id=$1", [before.leadId])).rows[0];
        if (prev) await recordEvent(client, before.leadId, prev.company, "note_updated", payload);
      }
    }
    return toNote(rows[0]);
  });

  if (result === "not_found") return notFound();
  if (result === "no_lead") return NextResponse.json({ error: "연결할 리드를 찾을 수 없습니다" }, { status: 400 });
  return NextResponse.json(result);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const deleted = await withTransaction(async (client) => {
    const { rows } = await client.query<NoteRow>(`DELETE FROM meeting_notes WHERE id=$1 RETURNING ${NOTE_COLUMNS}`, [id]);
    if (!rows[0]) return false;
    const note = toNote(rows[0]);
    // 리드에 연결된 노트만 리드 이력에 남긴다 (FK로 연결된 리드는 항상 존재)
    if (note.leadId) {
      const company = (await client.query<{ company: string }>("SELECT company FROM leads WHERE id=$1", [note.leadId]))
        .rows[0]?.company ?? "";
      await recordEvent(client, note.leadId, company, "note_deleted", noteSnapshot(note));
    }
    return true;
  });
  return deleted ? new NextResponse(null, { status: 204 }) : notFound();
}
