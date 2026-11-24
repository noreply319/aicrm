import { NextResponse } from "next/server";
import { featureState, getSessionUser, type SessionUser } from "@/lib/auth";
import { getEvent, inputRange, scheduleSnapshot } from "@/lib/calendar";
import { pool } from "@/lib/db";
import { stripCrmPrefix } from "@/lib/constants";
import { recordEvent, withTransaction } from "@/lib/events";
import { unauthorized } from "@/lib/google";
import { getSchedules } from "@/lib/schedules";
import { UUID_RE } from "@/lib/validate";

export const dynamic = "force-dynamic";

const SYNC_LIMIT = 10;

/**
 * 다음 미팅 일정 목록 (후보 + 등록된 일정). ?leadId= 로 리드별 조회.
 * ?sync=1이면 내가 등록한 앞으로의 일정을 구글에서 다시 읽어, 구글에서 직접 바꾸거나 지운 내용을 반영한다.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const sp = new URL(req.url).searchParams;
  const leadId = sp.get("leadId");
  if (leadId !== null && !UUID_RE.test(leadId)) return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });

  if (leadId && sp.get("sync") === "1" && featureState(user, "calendar") === "connected") {
    await syncFromGoogle(user, leadId).catch((e: unknown) => console.error("[schedules] sync", (e as Error).message));
  }
  return NextResponse.json(await getSchedules({ leadId: leadId ?? undefined }));
}

async function syncFromGoogle(user: SessionUser, leadId: string) {
  const { rows } = await pool.query<{
    id: string; eventId: string; calendarId: string | null; title: string; startsAt: Date; endsAt: Date; allDay: boolean; company: string;
  }>(
    `SELECT m.id, m.google_event_id AS "eventId", m.calendar_id AS "calendarId", m.title, m.starts_at AS "startsAt",
            m.ends_at AS "endsAt", m.all_day AS "allDay", l.company
     FROM scheduled_meetings m JOIN leads l ON l.id = m.lead_id
     WHERE m.lead_id = $1 AND m.user_id = $2 AND m.status = 'scheduled' AND m.google_event_id IS NOT NULL
       AND m.ends_at > now()
     ORDER BY m.starts_at LIMIT $3`,
    [leadId, user.id, SYNC_LIMIT]
  );
  for (const r of rows) {
    const ev = await getEvent(user, r.eventId, r.calendarId);
    if (!ev) {
      await withTransaction(async (client) => {
        await client.query(`UPDATE scheduled_meetings SET status = 'canceled', updated_at = now() WHERE id = $1`, [r.id]);
        await recordEvent(client, leadId, r.company, "meeting_canceled", { ...scheduleSnapshot(r), source: "google" });
      });
      continue;
    }
    const title = stripCrmPrefix(ev.title);
    const next = inputRange({ ...ev, location: ev.location, description: "", leadId: null, noteId: null, scheduleId: null, invite: false });
    if (next.startsAt.getTime() !== r.startsAt.getTime() || next.endsAt.getTime() !== r.endsAt.getTime() || title !== r.title) {
      await pool.query(
        `UPDATE scheduled_meetings SET title = $2, starts_at = $3, ends_at = $4, all_day = $5, location = $6, updated_at = now()
         WHERE id = $1`,
        [r.id, title, next.startsAt, next.endsAt, ev.allDay, ev.location]
      );
    }
  }
}
