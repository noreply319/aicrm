import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import {
  deleteEvent, EVENT_ID_RE, inputRange, patchEvent, scheduleSnapshot,
  SCHEDULE_COLUMNS, SCHEDULE_FROM, toSchedule, type ScheduleRow,
} from "@/lib/calendar";
import { pool } from "@/lib/db";
import { recordEvent, withTransaction } from "@/lib/events";
import { googleErrorResponse, unauthorized } from "@/lib/google";
import { eventDescription } from "@/lib/schedules";
import { parseEventInput } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ eventId: string }> };
type OwnedRow = ScheduleRow & { calendarId: string | null; inviteSent: boolean };

/** CRM에서 등록한 내 일정만 수정·삭제할 수 있다 (구글 캘린더의 다른 일정은 읽기 전용) */
async function findOwned(eventId: string, user: SessionUser): Promise<OwnedRow | Response> {
  if (!EVENT_ID_RE.test(eventId)) return NextResponse.json({ error: "일정을 찾을 수 없습니다" }, { status: 404 });
  const row = (
    await pool.query<OwnedRow>(
      `SELECT ${SCHEDULE_COLUMNS}, m.calendar_id AS "calendarId", m.invite_sent AS "inviteSent"
       FROM ${SCHEDULE_FROM} WHERE m.google_event_id = $1 AND m.status = 'scheduled'`,
      [eventId]
    )
  ).rows[0];
  if (!row) return NextResponse.json({ error: "CRM에서 등록한 일정만 수정할 수 있습니다" }, { status: 403 });
  if (row.userId !== user.id) {
    return NextResponse.json({ error: `${row.ownerName || "다른 팀원"}님의 캘린더 일정이라 수정할 수 없습니다` }, { status: 403 });
  }
  return row;
}

const company = async (leadId: string | null) =>
  leadId ? (await pool.query<{ company: string; stage: string }>("SELECT company, stage FROM leads WHERE id = $1", [leadId])).rows[0] ?? null : null;

/** 일정 변경 (재확정) → 구글 이벤트 갱신 */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { eventId } = await params;
  const row = await findOwned(eventId, user);
  if (row instanceof Response) return row;

  const parsed = parseEventInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const d = parsed.data;
  const lead = await company(d.leadId);
  if (d.leadId && !lead) return NextResponse.json({ error: "연결할 리드를 찾을 수 없습니다" }, { status: 400 });
  const noteTitle = row.noteId
    ? (await pool.query<{ title: string }>("SELECT title FROM meeting_notes WHERE id = $1", [row.noteId])).rows[0]?.title ?? null
    : null;

  let event;
  try {
    event = await patchEvent(user, eventId, row.calendarId, d, {
      description: eventDescription(d.description, lead, noteTitle),
      notify: row.inviteSent,
    });
  } catch (e) {
    return googleErrorResponse(e);
  }

  const { startsAt, endsAt } = inputRange(d);
  const schedule = await withTransaction(async (client) => {
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
      });
    }
    const r = await client.query<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM ${SCHEDULE_FROM} WHERE m.id = $1`, [row.id]);
    return toSchedule(r.rows[0]);
  });
  return NextResponse.json({
    event: { ...event, crm: { scheduleId: row.id, leadId: d.leadId, company: lead?.company ?? null, noteId: row.noteId } },
    schedule,
  });
}

/** 일정 취소 → 구글 이벤트 삭제 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { eventId } = await params;
  const row = await findOwned(eventId, user);
  if (row instanceof Response) return row;

  try {
    await deleteEvent(user, eventId, row.calendarId, row.inviteSent);
  } catch (e) {
    return googleErrorResponse(e);
  }
  await withTransaction(async (client) => {
    await client.query(`UPDATE scheduled_meetings SET status = 'canceled', updated_at = now() WHERE id = $1`, [row.id]);
    const lead = await company(row.leadId);
    if (row.leadId && lead) await recordEvent(client, row.leadId, lead.company, "meeting_canceled", scheduleSnapshot(row));
  });
  return new NextResponse(null, { status: 204 });
}
