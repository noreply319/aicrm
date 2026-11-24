import "server-only";
import type { SessionUser } from "./auth";
import { CRM_TITLE_PREFIX, stripCrmPrefix } from "./constants";
import { pool } from "./db";
import { forgetAccessToken, getAccessToken, GoogleError } from "./google";
import type { CalendarEvent, CalendarEventInput, CalendarInfo, CrmLink, ScheduledMeeting } from "./types";

/** 구글 캘린더 REST API (SDK 없이 fetch). 시간대는 한국 시간 고정 */

const API = "https://www.googleapis.com/calendar/v3";
export const TIME_ZONE = "Asia/Seoul";
/** 한 번에 조회할 수 있는 최대 기간 */
export const MAX_RANGE_DAYS = 92;

type CalendarUser = Pick<SessionUser, "id" | "refreshToken" | "calendarExpired" | "calendarId">;

/** 'YYYY-MM-DD' (한국 시간) */
export const kstDate = (d: Date | string | number) =>
  new Date(d).toLocaleString("sv-SE", { timeZone: TIME_ZONE }).slice(0, 10);
/** 'YYYY-MM-DD HH:mm' (한국 시간) */
export const kstDateTime = (d: Date | string | number) =>
  new Date(d).toLocaleString("sv-SE", { timeZone: TIME_ZONE }).slice(0, 16);
/** 'YYYY-MM-DD' + 'HH:mm' (한국 시간) → Date */
export const fromKst = (date: string, time = "00:00") => new Date(`${date}T${time}:00+09:00`);

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 구글 API 호출: 401이면 토큰을 새로 받아 1회, 429/5xx면 1회 재시도 */
async function gfetch(user: CalendarUser, path: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
  const token = await getAccessToken(user);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new GoogleError(timeout ? "구글 캘린더 응답 시간이 초과되었습니다" : "구글 캘린더에 연결할 수 없습니다", 502);
  });

  if ((res.status === 401 || res.status === 429 || res.status >= 500) && attempt === 0) {
    if (res.status === 401) forgetAccessToken(user.id);
    return gfetch(user, path, init, 1);
  }
  if (res.status === 204) return null;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = JSON.stringify(body).slice(0, 300);
    console.error("[calendar] error", res.status, path.split("?")[0], reason);
    if (res.status === 404 || res.status === 410) throw new GoogleError("캘린더 일정을 찾을 수 없습니다", 404, "not_found");
    if (res.status === 403 && reason.includes("insufficient")) {
      throw new GoogleError("캘린더 권한이 부족합니다. 설정에서 다시 연동하세요 (동의 화면에서 캘린더 권한 체크)", 403, "scope");
    }
    if (res.status === 403 && reason.includes("accessNotConfigured")) {
      throw new GoogleError("Google Calendar API가 사용 설정되지 않았습니다 (Google Cloud Console 확인)", 503);
    }
    if (res.status === 429 || reason.includes("rateLimit")) throw new GoogleError("구글 캘린더 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요", 429);
    throw new GoogleError("구글 캘린더 요청을 처리하지 못했습니다", 502);
  }
  return body;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const s = (v: unknown) => (typeof v === "string" ? v : "");

/** 쓰기 가능한 캘린더 목록 */
export async function listCalendars(user: CalendarUser): Promise<CalendarInfo[]> {
  const body = obj(await gfetch(user, "/users/me/calendarList?minAccessRole=writer&maxResults=100"));
  const items = Array.isArray(body.items) ? body.items : [];
  return items
    .map((it) => {
      const c = obj(it);
      return { id: s(c.id), name: s(c.summaryOverride) || s(c.summary), primary: c.primary === true, color: s(c.backgroundColor) };
    })
    .filter((c) => c.id)
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "ko"));
}

const calendarPath = (user: CalendarUser) => `/calendars/${encodeURIComponent(user.calendarId || "primary")}`;

/** 구글 이벤트 → 화면용 일정 (참석자·회의 링크 등은 버린다) */
function toEvent(raw: unknown): CalendarEvent | null {
  const e = obj(raw);
  if (!s(e.id) || e.status === "cancelled") return null;
  const start = obj(e.start);
  const end = obj(e.end);
  const allDay = Boolean(s(start.date));
  const startValue = allDay ? s(start.date) : s(start.dateTime);
  if (!startValue) return null;
  // 구글의 종일 일정 종료일은 다음 날(제외)이므로 하루 빼서 마지막 날(포함)로 바꾼다
  const endValue = allDay ? addDays(s(end.date) || addDays(startValue, 1), -1) : s(end.dateTime) || startValue;
  return {
    id: s(e.id),
    title: s(e.summary) || "(제목 없음)",
    start: allDay ? startValue : new Date(startValue).toISOString(),
    end: allDay ? endValue : new Date(endValue).toISOString(),
    allDay,
    location: s(e.location),
    description: s(e.description),
    htmlLink: s(e.htmlLink),
    crm: null,
  };
}

/** CRM에서 만든 일정이면 리드 정보를 붙인다 */
async function attachCrm(events: CalendarEvent[]): Promise<CalendarEvent[]> {
  if (events.length === 0) return events;
  const { rows } = await pool.query<CrmLink & { eventId: string }>(
    `SELECT m.google_event_id AS "eventId", m.id AS "scheduleId", m.lead_id AS "leadId", l.company, m.note_id AS "noteId"
     FROM scheduled_meetings m LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.google_event_id = ANY($1::text[]) AND m.status = 'scheduled'`,
    [events.map((e) => e.id)]
  );
  const byId = new Map(rows.map(({ eventId, ...link }) => [eventId, link]));
  return events.map((e) => ({ ...e, crm: byId.get(e.id) ?? null }));
}

/** 기간 내 일정 (반복 일정은 펼쳐서, 시작 시각순) */
export async function listEvents(
  user: CalendarUser,
  timeMin: Date,
  timeMax: Date,
  opts: { query?: string; max?: number } = {}
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  const max = opts.max ?? 500;
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      timeZone: TIME_ZONE,
    });
    if (opts.query) params.set("q", opts.query);
    if (pageToken) params.set("pageToken", pageToken);
    const body = obj(await gfetch(user, `${calendarPath(user)}/events?${params}`));
    for (const it of Array.isArray(body.items) ? body.items : []) {
      const ev = toEvent(it);
      if (ev) out.push(ev);
    }
    pageToken = s(body.nextPageToken);
  } while (pageToken && out.length < max);
  return attachCrm(out.slice(0, max));
}

export async function getEvent(user: CalendarUser, eventId: string, calendarId?: string | null): Promise<CalendarEvent | null> {
  try {
    const path = `/calendars/${encodeURIComponent(calendarId || user.calendarId || "primary")}/events/${encodeURIComponent(eventId)}`;
    return toEvent(await gfetch(user, path));
  } catch (e) {
    if (e instanceof GoogleError && e.code === "not_found") return null;
    throw e;
  }
}

/** 일정 입력 → 구글 이벤트 본문 */
function eventBody(input: CalendarEventInput, extra: { description: string; attendees?: string[]; scheduleId?: string }) {
  const time = input.allDay
    ? { start: { date: input.start }, end: { date: addDays(input.end, 1) } }
    : { start: { dateTime: input.start, timeZone: TIME_ZONE }, end: { dateTime: input.end, timeZone: TIME_ZONE } };
  return {
    summary: `${CRM_TITLE_PREFIX} ${stripCrmPrefix(input.title)}`,
    location: input.location,
    description: extra.description,
    ...time,
    ...(extra.attendees?.length ? { attendees: extra.attendees.map((email) => ({ email })) } : {}),
    // CRM에서 만든 일정 표시 (다른 앱에는 보이지 않는 private 속성)
    extendedProperties: { private: { crm: "1", ...(extra.scheduleId ? { crmScheduleId: extra.scheduleId } : {}) } },
  };
}

export async function insertEvent(
  user: CalendarUser,
  input: CalendarEventInput,
  extra: { description: string; attendees?: string[]; scheduleId?: string }
): Promise<CalendarEvent & { calendarId: string }> {
  const sendUpdates = extra.attendees?.length ? "all" : "none";
  const raw = await gfetch(user, `${calendarPath(user)}/events?sendUpdates=${sendUpdates}`, {
    method: "POST",
    body: JSON.stringify(eventBody(input, extra)),
  });
  const ev = toEvent(raw);
  if (!ev) throw new GoogleError("구글 캘린더 일정을 만들지 못했습니다", 502);
  return { ...ev, calendarId: user.calendarId || "primary" };
}

export async function patchEvent(
  user: CalendarUser,
  eventId: string,
  calendarId: string | null,
  input: CalendarEventInput,
  extra: { description: string; notify: boolean }
): Promise<CalendarEvent> {
  const { extendedProperties: _x, ...body } = eventBody(input, { description: extra.description });
  const path = `/calendars/${encodeURIComponent(calendarId || user.calendarId || "primary")}/events/${encodeURIComponent(eventId)}`;
  const ev = toEvent(
    await gfetch(user, `${path}?sendUpdates=${extra.notify ? "all" : "none"}`, { method: "PATCH", body: JSON.stringify(body) })
  );
  if (!ev) throw new GoogleError("구글 캘린더 일정을 수정하지 못했습니다", 502);
  return ev;
}

/** 일정 삭제. 이미 삭제된 일정이면 성공으로 본다 */
export async function deleteEvent(user: CalendarUser, eventId: string, calendarId: string | null, notify: boolean) {
  const path = `/calendars/${encodeURIComponent(calendarId || user.calendarId || "primary")}/events/${encodeURIComponent(eventId)}`;
  try {
    await gfetch(user, `${path}?sendUpdates=${notify ? "all" : "none"}`, { method: "DELETE" });
  } catch (e) {
    if (!(e instanceof GoogleError && e.code === "not_found")) throw e;
  }
}

/** 구글 이벤트 id 형식 (반복 일정 인스턴스는 _20261125T... 접미사) */
export const EVENT_ID_RE = /^[A-Za-z0-9_\-@.]{1,1024}$/;

// ───────────── scheduled_meetings (DB) ─────────────

export const SCHEDULE_COLUMNS = `
  m.id, m.lead_id AS "leadId", m.note_id AS "noteId", m.user_id AS "userId",
  coalesce(u.name, u.email, '') AS "ownerName", m.status, m.certainty, m.title,
  m.starts_at AS "startsAt", m.ends_at AS "endsAt", m.all_day AS "allDay", m.location, m.evidence, m.memo,
  m.google_event_id AS "googleEventId", m.google_html_link AS "htmlLink", m.created_at AS "createdAt"`;

export const SCHEDULE_FROM = "scheduled_meetings m LEFT JOIN users u ON u.id = m.user_id";

export type ScheduleRow = Omit<ScheduledMeeting, "startsAt" | "endsAt" | "createdAt"> & {
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  calendarId?: string | null;
};

export const toSchedule = ({ calendarId: _c, ...r }: ScheduleRow): ScheduledMeeting => ({
  ...r,
  startsAt: r.startsAt.toISOString(),
  endsAt: r.endsAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

/** 일정 입력의 시작·종료 → DB timestamptz (종일이면 한국 시간 자정 기준) */
export function inputRange(input: CalendarEventInput): { startsAt: Date; endsAt: Date } {
  return input.allDay
    ? { startsAt: fromKst(input.start), endsAt: fromKst(addDays(input.end, 1)) }
    : { startsAt: new Date(input.start), endsAt: new Date(input.end) };
}

/** lead_events 스냅샷 */
export const scheduleSnapshot = (m: { id: string; title: string; startsAt: Date | string; allDay: boolean; noteId?: string | null }) => ({
  scheduleId: m.id,
  title: m.title,
  startsAt: m.allDay ? kstDate(m.startsAt) : kstDateTime(m.startsAt),
  allDay: m.allDay,
  ...(m.noteId ? { noteId: m.noteId } : {}),
});
