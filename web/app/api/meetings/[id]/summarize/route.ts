import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { recordEvent, withTransaction } from "@/lib/events";
import { NOTE_COLUMNS, summarizeNote, toNote, type NoteRow } from "@/lib/meetings";
import { AiError } from "@/lib/openai";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "미팅 노트를 찾을 수 없습니다" }, { status: 404 });

/**
 * 저장된 노트를 AI로 요약해 summary·next_actions에 저장한다 → 저장된 MeetingNote.
 * 미팅(녹음) 완료 후 자동 요약에 쓴다. 서버가 저장까지 하므로 사용자가 작성 화면을 닫아도 요약이 남는다.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

  const { rows } = await pool.query<{ title: string; body: string }>(
    "SELECT title, body FROM meeting_notes WHERE id=$1",
    [id]
  );
  if (!rows[0]) return notFound();

  // OpenAI 호출(수 초)은 트랜잭션 밖에서 한다
  let result;
  try {
    result = await summarizeNote(rows[0].title, rows[0].body);
  } catch (e) {
    if (e instanceof AiError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const note = await withTransaction(async (client) => {
    const updated = (
      await client.query<NoteRow>(
        `UPDATE meeting_notes SET summary=$2, next_actions=$3, updated_at=now()
         WHERE id=$1 RETURNING ${NOTE_COLUMNS}`,
        [id, result.summary, result.nextActions]
      )
    ).rows[0];
    if (!updated) return null; // 요약하는 사이 삭제됨
    const saved = toNote(updated);
    if (saved.leadId) {
      const company = (await client.query<{ company: string }>("SELECT company FROM leads WHERE id=$1", [saved.leadId]))
        .rows[0]?.company ?? "";
      await recordEvent(client, saved.leadId, company, "note_updated", {
        noteId: id, title: saved.title, summary: "changed", auto: true,
      });
    }
    return saved;
  });
  return note ? NextResponse.json(note) : notFound();
}
