import "server-only";
import type { Pool, PoolClient } from "pg";
import type { SessionUser } from "./auth";
import {
  deleteEvent, EVENT_ID_RE, inputRange, patchEvent, scheduleSnapshot, SCHEDULE_COLUMNS, SCHEDULE_FROM, toSchedule, type ScheduleRow,
} from "./calendar";
import { pool } from "./db";
import { recordEvent, withTransaction } from "./events";
import { eventDescription, inSavepoint } from "./schedules";
import type { CalendarEvent, CalendarEventInput, ScheduledMeeting } from "./types";

/**
 * 캘린더 일정 수정·취소 로직 (Route Handler와 Sales Agent가 같은 코드를 쓴다).
 * CRM에서 등록한 **본인** 일정만 바꿀 수 있다. 구글을 먼저 바꾸고 DB에 반영한다.
 * client가 있으면 호출한 쪽 트랜잭션 안에서(SAVEPOINT) 저장한다. meta는 리드 이력에 함께 남길 값.
 */
export type OwnedSchedule = ScheduleRow & { calendarId: string | null; inviteSent: boolean };
type Opts = { client?: PoolClient; meta?: Record<string, unknown> };

const OWNED_COLUMNS = `${SCHEDULE_COLUMNS}, m.calendar_id AS "calendarId", m.invite_sent AS "inviteSent"`;
const OWNED_BY_EVENT = `SELECT ${OWNED_COLUMNS} FROM ${SCHEDULE_FROM} WHERE m.google_event_id = $1 AND m.status = 'scheduled'`;
const OWNED_BY_ID = `SELECT ${OWNED_COLUMNS} FROM ${SCHEDULE_FROM} WHERE m.id = $1 AND m.status = 'scheduled'`;

/** 등록된(scheduled) CRM 일정을 찾아 본인 것인지 확인. by: 구글 이벤트 id 또는 CRM 일정 id */
export async function findOwnedSchedule(
  db: Pool | PoolClient,
  by: { eventId: string } | { scheduleId: string },
  userId: string,
  { lock = false } = {}
): Promise<{ ok: true; row: OwnedSchedule } | { ok: false; status: 403 | 404; error: string }> {
  if ("eventId" in by && !EVENT_ID_RE.test(by.eventId)) return { ok: false, status: 404, error: "일정을 찾을 수 없습니다" };
  const sql = "eventId" in by ? OWNED_BY_EVENT : OWNED_BY_ID;
  const row = (await db.query<OwnedSchedule>(lock ? `${sql} FOR UPDATE OF m` : sql, ["eventId" in by ? by.eventId : by.scheduleId])).rows[0];
  if (!row) return { ok: false, status: 403, error: "CRM에서 등록한 일정만 수정할 수 있습니다" };
  if (row.userId !== userId) {
    return { ok: false, status: 403, error: `${row.ownerName || "다른 팀원"}님의 캘린더 일정이라 수정할 수 없습니다` };
  }
  return { ok: true, row };
}

const leadOf = async (db: Pool | PoolClient, leadId: string | null) =>
  leadId ? (await db.query<{ company: string; stage: string }>("SELECT company, stage FROM leads WHERE id = $1", [leadId])).rows[0] ?? null : null;

/** 일정 전체 값 교체 (재확정) → 구글 이벤트 갱신 + DB 반영, 리드 이력 meeting_rescheduled/scheduled */
export async function updateSchedule(
  user: SessionUser, row: OwnedSchedule, d: CalendarEventInput, opts: Opts = {}
): Promise<{ ok: true; event: CalendarEvent; schedule: ScheduledMeeting } | { ok: false; status: 400; error: string }> {
  const db = opts.client ?? pool;
  const lead = await leadOf(db, d.leadId);
  if (d.leadId && !lead) return { ok: false, status: 400, error: "연결할 리드를 찾을 수 없습니다" };
  const noteTitle = row.noteId
    ? (await db.query<{ title: string }>("SELECT title FROM meeting_notes WHERE id = $1", [row.noteId])).rows[0]?.title ?? null
    : null;

  const event = await patchEvent(user, row.googleEventId ?? "", row.calendarId, d, {
    description: eventDescription(d.description, lead, noteTitle),
    notify: row.inviteSent,
  });

  const { startsAt, endsAt } = inputRange(d);
  const save = async (client: PoolClient) => {
    await client.query(
      `UPDATE scheduled_meetings SET lead_id = $2, title = $3, starts_at = $4, ends_at = $5, all_day = $6,
              location = $7, memo = $8, updated_at = now() WHERE id = $1`,
      [row.id, d.leadId, d.title, startsAt, endsAt, d.allDay, d.location, d.description]
    );
    const timeChanged = row.startsAt.getTime() !== startsAt.getTime() || row.endsAt.getTime() !== endsAt.getTime();
    if (d.leadId && lead && (timeChanged || row.title !== d.title || row.leadId !== d.leadId)) {
      await recordEvent(client, d.leadId, lead.company, row.leadId === d.leadId ? "meeting_rescheduled" : "meeting_scheduled", {
        ...scheduleSnapshot({ id: row.id, title: d.title, startsAt, allDay: d.allDay }),
        ...(timeChanged ? { from: scheduleSnapshot(row).startsAt } : {}),
        ...opts.meta,
      });
    }
    const r = await client.query<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM ${SCHEDULE_FROM} WHERE m.id = $1`, [row.id]);
    return toSchedule(r.rows[0]);
  };
  const schedule = opts.client ? await inSavepoint(opts.client, save) : await withTransaction(save);
  return {
    ok: true,
    event: { ...event, crm: { scheduleId: row.id, leadId: d.leadId, company: lead?.company ?? null, noteId: row.noteId } },
    schedule,
  };
}

/** 일정 취소 → 구글 이벤트 삭제(초대한 일정이면 참석자에게 알림) + canceled, 리드 이력 meeting_canceled */
export async function cancelSchedule(user: SessionUser, row: OwnedSchedule, opts: Opts = {}): Promise<void> {
  await deleteEvent(user, row.googleEventId ?? "", row.calendarId, row.inviteSent);
  const save = async (client: PoolClient) => {
    await client.query(`UPDATE scheduled_meetings SET status = 'canceled', updated_at = now() WHERE id = $1`, [row.id]);
    const lead = await leadOf(client, row.leadId);
    if (row.leadId && lead) await recordEvent(client, row.leadId, lead.company, "meeting_canceled", { ...scheduleSnapshot(row), ...opts.meta });
  };
  await (opts.client ? inSavepoint(opts.client, save) : withTransaction(save));
}
