import "server-only";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { recordEvent, withTransaction } from "./events";
import { NOTE_COLUMNS, noteSnapshot, summarizeNote, toNote, type NoteRow } from "./meetings";
import type { MeetingNote, MeetingNoteInput } from "./types";

/**
 * 미팅 노트 생성·요약 저장 로직 (Route Handler와 Sales Agent가 같은 코드를 쓴다).
 * meta는 리드 이력에 함께 남길 값 (예: { via: "agent" }).
 */
export type NoteOpResult = { ok: true; note: MeetingNote } | { ok: false; status: 400 | 404; error: string };

/** 노트 생성 (호출한 쪽 트랜잭션). 리드가 있으면 존재 확인 후 note_created 이력 */
export async function createNote(
  client: PoolClient, userId: string | null, d: MeetingNoteInput, meta: Record<string, unknown> = {}
): Promise<NoteOpResult> {
  // 리드 미지정 노트도 저장할 수 있다. 리드가 있으면 존재 확인 후 리드 이력에 남긴다.
  const lead = d.leadId
    ? (await client.query<{ company: string }>("SELECT company FROM leads WHERE id=$1 FOR SHARE", [d.leadId])).rows[0]
    : undefined;
  if (d.leadId && !lead) return { ok: false, status: 400, error: "연결할 리드를 찾을 수 없습니다" };

  const { rows } = await client.query<NoteRow>(
    `INSERT INTO meeting_notes (lead_id, title, met_at, body, source, summary, next_actions, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${NOTE_COLUMNS}`,
    [d.leadId, d.title, d.metAt, d.body, d.source, d.summary, d.nextActions, userId]
  );
  const created = toNote(rows[0]);
  if (d.leadId && lead) await recordEvent(client, d.leadId, lead.company, "note_created", { ...noteSnapshot(created), ...meta });
  return { ok: true, note: created };
}

/**
 * 저장된 노트를 AI로 요약해 summary·next_actions에 저장한다 (자동 요약 이력 note_updated).
 * OpenAI 호출(수 초)은 트랜잭션 밖에서 한다. AiError는 호출한 쪽에서 처리.
 */
export async function summarizeAndSaveNote(id: string): Promise<NoteOpResult> {
  const notFound = { ok: false, status: 404, error: "미팅 노트를 찾을 수 없습니다" } as const;
  const { rows } = await pool.query<{ title: string; body: string }>("SELECT title, body FROM meeting_notes WHERE id=$1", [id]);
  if (!rows[0]) return notFound;

  const result = await summarizeNote(rows[0].title, rows[0].body);

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
  return note ? { ok: true, note } : notFound;
}
