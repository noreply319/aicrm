import "server-only";
import type { PoolClient } from "pg";
import { idArg, stale, str, text, unchanged, type AgentTool, type Args, type ReadTool, type WriteTool } from "./agentToolKit";
import { featureState, findUserById, type SessionUser } from "./auth";
import { addDays, fromKst, kstDate, kstDateTime } from "./calendar";
import { DATE_RE, TIME_RE } from "./constants";
import { pool } from "./db";
import { weekday } from "./format";
import { GoogleError } from "./google";
import { createNote, summarizeAndSaveNote } from "./noteOps";
import { AiError, maskPii } from "./openai";
import { cancelSchedule, findOwnedSchedule, updateSchedule, type OwnedSchedule } from "./scheduleOps";
import { createCandidatesForNote, registerSchedule, ScheduleError } from "./schedules";
import type { AgentChange, AgentTarget, CalendarEventInput } from "./types";
import { parseEventInput, parseNoteInput } from "./validate";

/**
 * 미팅 노트·캘린더 도구.
 * - 노트 본문·요약·제목, 일정 제목·장소는 maskPii 후 모델에 보낸다 (참석자·설명·회의 링크는 보내지 않음)
 * - 일정은 본인 구글 캘린더에 등록하고, 수정·취소는 CRM에서 등록한 본인 일정만
 * - 날짜는 모델이 현재 시각(KST) 기준으로 계산해 YYYY-MM-DD·HH:mm으로 넘기고, 카드에는 요일까지 확정 날짜로 보여준다
 */

const MAX_NOTES = 20;
const NOTE_BODY_CHARS = 6000;
const DEFAULT_MINUTES = 60;
const DAY_MS = 86_400_000;

/* ───────── 날짜 표시 ───────── */

/** "2026-12-02(수) 14:00~15:00" / 종일 "2026-12-02(수) 종일" */
function rangeLabel(r: { allDay: boolean; startsAt: Date; endsAt: Date }): string {
  if (r.allDay) {
    const start = kstDate(r.startsAt);
    const last = kstDate(new Date(r.endsAt.getTime() - 1));
    return start === last ? `${start}(${weekday(start)}) 종일` : `${start}(${weekday(start)})~${last}(${weekday(last)}) 종일`;
  }
  const s = kstDateTime(r.startsAt);
  const e = kstDateTime(r.endsAt);
  const day = s.slice(0, 10);
  return `${day}(${weekday(day)}) ${s.slice(11)}~${e.slice(0, 10) === day ? e.slice(11) : e}`;
}

const inputLabel = (d: CalendarEventInput) =>
  rangeLabel(
    d.allDay
      ? { allDay: true, startsAt: fromKst(d.start), endsAt: fromKst(addDays(d.end, 1)) }
      : { allDay: false, startsAt: new Date(d.start), endsAt: new Date(d.end) }
  );

/* ───────── 공통 ───────── */

/** 캘린더를 쓸 수 있는 사용자 (연동·만료 확인) */
async function calendarUser(userId: string): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }> {
  const user = await findUserById(userId);
  const state = featureState(user, "calendar");
  if (!user || state === "none") return { ok: false, error: "구글 캘린더가 연동되지 않았습니다. 설정 → Google 연동에서 연동하세요" };
  if (state === "expired") return { ok: false, error: "구글 캘린더 연동이 만료되었습니다. 설정 → Google 연동에서 다시 연동하세요" };
  return { ok: true, user };
}

const leadLabel = async (leadId: string | null) => {
  if (!leadId) return null;
  const l = (await pool.query<{ company: string; contact: string; email: string }>(
    "SELECT company, contact, email FROM leads WHERE id = $1", [leadId]
  )).rows[0];
  return l ? { label: l.contact ? `${l.company} · ${l.contact}` : l.company, contact: l.contact, hasEmail: !!l.email } : null;
};

/**
 * 실행 실패로 보여줄 에러 (구글·일정 에러) — 그 밖의 에러는 다시 던진다.
 * 변경·취소는 구글에 이미 반영된 뒤 DB 에러가 나면 되돌릴 수 없으므로 계획을 승인 대기로 남겨 다시 승인하면 맞춰지게 한다
 * (구글 수정은 같은 값으로 다시 적용, 삭제는 이미 지운 일정도 성공으로 본다).
 */
function calendarFailure(e: unknown): { ok: false; message: string } {
  if (e instanceof GoogleError || e instanceof ScheduleError) return { ok: false, message: e.message };
  throw e;
}

/* ───────── 조회 도구 ───────── */

const searchNotes: ReadTool = {
  kind: "read",
  label: "미팅 노트 검색",
  def: {
    name: "search_meeting_notes",
    description: "미팅 노트를 검색합니다(최신순 최대 20건). 제목·본문·요약·회사명에 포함된 글자, 리드, 최근 N일로 거를 수 있습니다. 본문 전체는 get_meeting_note로 보세요.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        leadId: { type: "string" },
        days: { type: "number", description: "최근 N일 (미팅 일시 기준)" },
      },
    },
  },
  async run(a) {
    const q = str(a.query, 100);
    const days = Number.isFinite(Number(a.days)) && Number(a.days) > 0 ? Math.min(Math.round(Number(a.days)), 3650) : null;
    const { rows } = await pool.query<{ id: string; leadId: string | null; company: string | null; title: string; metAt: Date; summary: string; nextActions: string }>(
      `SELECT n.id, n.lead_id AS "leadId", l.company, n.title, n.met_at AS "metAt", n.summary, n.next_actions AS "nextActions"
       FROM meeting_notes n LEFT JOIN leads l ON l.id = n.lead_id
       WHERE ($1::uuid IS NULL OR n.lead_id = $1)
         AND ($2::int IS NULL OR n.met_at > now() - make_interval(days => $2))
         AND ($3 = '' OR n.title ILIKE '%' || $3 || '%' OR n.body ILIKE '%' || $3 || '%' OR n.summary ILIKE '%' || $3 || '%' OR l.company ILIKE '%' || $3 || '%')
       ORDER BY n.met_at DESC, n.created_at DESC LIMIT $4`,
      [idArg(a, "leadId"), days, q, MAX_NOTES]
    );
    return {
      count: rows.length,
      notes: rows.map((n) => ({
        id: n.id,
        leadId: n.leadId ?? undefined,
        company: n.company ?? "(리드 미지정)",
        title: maskPii(n.title),
        metAt: kstDateTime(n.metAt),
        summary: maskPii(n.summary) || undefined,
        nextActions: maskPii(n.nextActions) || undefined,
      })),
    };
  },
};

const getNote: ReadTool = {
  kind: "read",
  label: "미팅 노트 보기",
  def: {
    name: "get_meeting_note",
    description: "미팅 노트 한 건의 본문(앞부분 6000자)·요약·다음 액션과 이 노트에서 잡은 일정을 조회합니다. 본문은 녹음 전사일 수 있어 오인식이 있을 수 있습니다.",
    parameters: { type: "object", properties: { noteId: { type: "string" } }, required: ["noteId"] },
  },
  async run(a) {
    const id = idArg(a, "noteId");
    if (!id) return { error: "노트 id가 올바르지 않습니다" };
    const n = (await pool.query<{ leadId: string | null; company: string | null; title: string; metAt: Date; body: string; summary: string; nextActions: string }>(
      `SELECT n.lead_id AS "leadId", l.company, n.title, n.met_at AS "metAt", n.body, n.summary, n.next_actions AS "nextActions"
       FROM meeting_notes n LEFT JOIN leads l ON l.id = n.lead_id WHERE n.id = $1`,
      [id]
    )).rows[0];
    if (!n) return { error: "미팅 노트를 찾을 수 없습니다" };
    const schedules = await pool.query<{ id: string; status: string; title: string; startsAt: Date; endsAt: Date; allDay: boolean }>(
      `SELECT id, status, title, starts_at AS "startsAt", ends_at AS "endsAt", all_day AS "allDay"
       FROM scheduled_meetings WHERE note_id = $1 AND status IN ('candidate','scheduled') ORDER BY starts_at`,
      [id]
    );
    return {
      note: {
        id, leadId: n.leadId ?? undefined, company: n.company ?? "(리드 미지정)", title: maskPii(n.title), metAt: kstDateTime(n.metAt),
        body: maskPii(n.body.slice(0, NOTE_BODY_CHARS)), summary: maskPii(n.summary) || undefined, nextActions: maskPii(n.nextActions) || undefined,
      },
      schedules: schedules.rows.map((s) => ({ id: s.id, status: s.status, title: maskPii(s.title), when: rangeLabel(s) })),
    };
  },
};

/* ───────── 노트 작성 ───────── */

const NOTE_AFTER = "승인하면 AI 요약과 다음 미팅 후보 찾기를 함께 실행합니다 (후보는 캘린더에 자동 등록하지 않습니다)";

function parseNoteArgs(a: Args) {
  const date = str(a.date, 10);
  const time = str(a.time, 5);
  if (!DATE_RE.test(date)) return { ok: false as const, error: "미팅 날짜는 YYYY-MM-DD로 넘기세요" };
  if (time && !TIME_RE.test(time)) return { ok: false as const, error: "미팅 시간은 HH:mm(24시간)으로 넘기세요" };
  const v = parseNoteInput({
    leadId: a.leadId, title: a.title, body: a.body, source: "manual", metAt: fromKst(date, time || "00:00").toISOString(),
  });
  return v.ok ? { ok: true as const, data: v.data, date, time } : v;
}

const createNoteTool: WriteTool = {
  kind: "write",
  label: "미팅 노트 작성",
  def: {
    name: "create_meeting_note",
    description: "미팅 노트를 작성하는 실행 계획을 만듭니다(사용자 승인 후 저장, 이어서 AI 요약·다음 미팅 후보 찾기). 본문은 사용자가 말한 내용을 정리해 넣으세요.",
    parameters: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "연결할 리드 id (없으면 리드 미지정 노트)" },
        title: { type: "string" },
        date: { type: "string", description: "미팅 날짜 YYYY-MM-DD (KST)" },
        time: { type: "string", description: "미팅 시작 시간 HH:mm (모르면 생략)" },
        body: { type: "string", description: "노트 본문" },
      },
      required: ["title", "date", "body"],
    },
  },
  async prepare(a) {
    const p = parseNoteArgs(a);
    if (!p.ok) return { error: p.error };
    const lead = await leadLabel(p.data.leadId);
    if (p.data.leadId && !lead) return { error: "연결할 리드를 찾을 수 없습니다" };
    const changes: AgentChange[] = [
      { field: "리드", after: lead?.label ?? "(리드 미지정)" },
      { field: "제목", after: p.data.title },
      { field: "미팅 일시", after: `${p.date}(${weekday(p.date)})${p.time ? ` ${p.time}` : ""}` },
      { field: "본문", after: text(p.data.body) },
    ];
    return {
      title: "미팅 노트 작성",
      changes,
      notice: { tone: "info", text: NOTE_AFTER },
      args: { leadId: p.data.leadId, title: p.data.title, date: p.date, time: p.time, body: p.data.body },
    };
  },
  async execute(client, userId, a, ctx) {
    const p = parseNoteArgs(a);
    if (!p.ok) return { ok: false, message: p.error };
    const r = await createNote(client, userId, p.data, ctx.meta);
    if (!r.ok) return { ok: false, message: r.error };
    const id = r.note.id;
    return {
      ok: true,
      message: "미팅 노트를 저장했습니다",
      target: { kind: "note", id, label: r.note.title },
      // AI 요약·후보 찾기는 커밋 뒤에 (OpenAI 호출 수 초). 후보는 저장만 하고 캘린더에 등록하지 않는다
      after: async () => {
        const done: string[] = [];
        try {
          const r = await summarizeAndSaveNote(id);
          if (!r.ok) return "노트가 삭제되어 AI 요약을 하지 못했습니다";
          done.push("AI 요약 완료");
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
          done.push("AI 요약 실패 (노트 화면에서 다시 요약하세요)");
        }
        try {
          const found = await createCandidatesForNote(id);
          if (found.length) done.push(`다음 미팅 후보 ${found.length}건 (캘린더 메뉴에서 확정)`);
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
        }
        return done.join(" · ");
      },
    };
  },
};

/* ───────── 캘린더 ───────── */

const EVENT_PROPS = {
  title: { type: "string" },
  date: { type: "string", description: "날짜 YYYY-MM-DD (KST)" },
  startTime: { type: "string", description: "시작 HH:mm (24시간). 없으면 종일" },
  endTime: { type: "string", description: "종료 HH:mm (없으면 시작 + 1시간)" },
  location: { type: "string" },
  memo: { type: "string", description: "일정 메모" },
  leadId: { type: "string", description: "연결할 리드 id (선택)" },
};

type Range = { allDay: boolean; start: string; end: string };

/** 시각 + 종료 시간 → 종료 시각 (시작보다 이르거나 같으면 다음 날: 자정을 넘는 일정) */
function endAt(start: Date, date: string, endTime: string): Date {
  const end = fromKst(date, endTime);
  return end > start ? end : new Date(end.getTime() + DAY_MS);
}

/** 날짜·시간 인자 → 일정 입력의 start/end (종일: 날짜, 시간: ISO) */
function timeRange(date: string, startTime: string, endTime: string): Range | { error: string } {
  if (!DATE_RE.test(date)) return { error: "날짜는 YYYY-MM-DD로 넘기세요" };
  if (!startTime) return { allDay: true, start: date, end: date };
  if (!TIME_RE.test(startTime) || (endTime && !TIME_RE.test(endTime))) return { error: "시간은 HH:mm(24시간)으로 넘기세요" };
  const start = fromKst(date, startTime);
  const end = endTime ? endAt(start, date, endTime) : new Date(start.getTime() + DEFAULT_MINUTES * 60_000);
  return { allDay: false, start: start.toISOString(), end: end.toISOString() };
}

/** 지금 일정의 범위 (종일은 마지막 날 포함 날짜) */
const rowRange = (r: OwnedSchedule): Range =>
  r.allDay
    ? { allDay: true, start: kstDate(r.startsAt), end: kstDate(new Date(r.endsAt.getTime() - 1)) }
    : { allDay: false, start: r.startsAt.toISOString(), end: r.endsAt.toISOString() };

/**
 * 변경 인자 + 지금 일정 → 새 범위. 날짜·시간을 안 넘기면 그대로(여러 날·자정을 넘는 일정 유지).
 * 날짜만 바꾸면 시작·종료를 같은 날 수만큼 옮기고, 시작 시간만 바꾸면 길이를 유지한다.
 */
function mergedRange(row: OwnedSchedule, a: Args): Range | { error: string } {
  const date = str(a.date, 10);
  const startTime = str(a.startTime, 5);
  const endTime = str(a.endTime, 5);
  const cur = rowRange(row);
  if (!date && !startTime && !endTime) return cur;
  if (date && !DATE_RE.test(date)) return { error: "날짜는 YYYY-MM-DD로 넘기세요" };

  if (row.allDay && !startTime) {
    if (endTime) return { error: "종일 일정에 시간을 넣으려면 시작 시간도 넘기세요" };
    const span = Math.round((fromKst(cur.end).getTime() - fromKst(cur.start).getTime()) / DAY_MS);
    return { allDay: true, start: date, end: addDays(date, span) };
  }
  if (row.allDay) return timeRange(date || cur.start, startTime, endTime);

  const newDate = date || kstDate(row.startsAt);
  const newStart = startTime || kstDateTime(row.startsAt).slice(11);
  if (!TIME_RE.test(newStart) || (endTime && !TIME_RE.test(endTime))) return { error: "시간은 HH:mm(24시간)으로 넘기세요" };
  const start = fromKst(newDate, newStart);
  const end = endTime ? endAt(start, newDate, endTime) : new Date(start.getTime() + (row.endsAt.getTime() - row.startsAt.getTime()));
  return { allDay: false, start: start.toISOString(), end: end.toISOString() };
}

const eventChanges = (d: CalendarEventInput, leadName: string | undefined, invite: boolean): AgentChange[] => [
  { field: "제목", after: d.title },
  { field: "일시", after: inputLabel(d) },
  ...(d.location ? [{ field: "장소", after: text(d.location) }] : []),
  ...(leadName ? [{ field: "리드", after: leadName }] : []),
  ...(d.description ? [{ field: "메모", after: text(d.description) }] : []),
  ...(invite ? [{ field: "초대", after: "리드 담당자에게 초대 메일 발송" }] : []),
];

/** 저장된 인자 → 검증된 일정 입력 (승인 때 다시 검증) */
const eventInputOf = (a: Args) => parseEventInput(a.input);

const createEventTool: WriteTool = {
  kind: "write",
  label: "캘린더 일정 등록",
  def: {
    name: "create_calendar_event",
    description: "내 구글 캘린더에 일정을 등록하는 실행 계획을 만듭니다(사용자 승인 후 등록, 제목 앞에 [AI CRM]). invite는 사용자가 리드 담당자 초대를 요청했을 때만 true.",
    parameters: {
      type: "object",
      properties: { ...EVENT_PROPS, invite: { type: "boolean", description: "리드 담당자에게 초대 메일 발송" } },
      required: ["title", "date"],
    },
  },
  async prepare(a, userId) {
    const cal = await calendarUser(userId);
    if (!cal.ok) return { error: cal.error };
    const range = timeRange(str(a.date, 10), str(a.startTime, 5), str(a.endTime, 5));
    if ("error" in range) return { error: range.error };
    const invite = a.invite === true;
    const v = parseEventInput({
      ...range, title: a.title, location: a.location, description: a.memo, leadId: a.leadId, noteId: null, scheduleId: null, invite,
    });
    if (!v.ok) return { error: v.error };
    const lead = await leadLabel(v.data.leadId);
    if (v.data.leadId && !lead) return { error: "연결할 리드를 찾을 수 없습니다" };
    if (invite && !lead) return { error: "초대하려면 리드를 지정하세요" };
    if (invite && !lead?.hasEmail) return { error: "리드 담당자 이메일이 없어 초대할 수 없습니다. 리드 화면에서 이메일을 입력하세요" };
    return {
      title: "캘린더 일정 등록",
      changes: eventChanges(v.data, lead?.label, invite),
      danger: invite,
      ...(invite ? { approveLabel: "등록·초대 승인" } : {}),
      notice: invite
        ? { tone: "warning", text: `승인하면 리드 담당자(${lead?.contact || "담당자"})에게 구글 캘린더 초대 메일이 발송됩니다` }
        : { tone: "info", text: "내 구글 캘린더에 [AI CRM] 일정으로 등록됩니다" },
      args: { input: v.data },
    };
  },
  async execute(client, userId, a, ctx) {
    const cal = await calendarUser(userId);
    if (!cal.ok) return { ok: false, message: cal.error };
    const v = eventInputOf(a);
    if (!v.ok) return { ok: false, message: v.error };
    try {
      const { schedule } = await registerSchedule(cal.user, v.data, { client, meta: ctx.meta });
      return { ok: true, message: "캘린더에 일정을 등록했습니다", target: { kind: "event", id: schedule.id, label: schedule.title } };
    } catch (e) {
      if (e instanceof GoogleError || e instanceof ScheduleError) return calendarFailure(e);
      // DB 저장 실패: registerSchedule이 방금 만든 구글 일정을 지웠고 SAVEPOINT로 되돌렸으므로 실패로 기록해도 된다
      console.error("[agent] create_calendar_event", e);
      return { ok: false, message: "일정을 저장하지 못했습니다. 잠시 후 다시 요청하세요" };
    }
  },
};

/** 계획 이후 바뀌었는지 비교할 일정 값 */
const scheduleState = (r: OwnedSchedule) => ({
  title: r.title, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), location: r.location, leadId: r.leadId,
});

const scheduleTarget = (r: OwnedSchedule): AgentTarget => ({ kind: "event", id: r.id, label: r.title });

/** 승인 때: 내 일정 다시 찾고(잠금) 계획 이후 바뀌지 않았는지 확인 */
async function lockedOwned(client: PoolClient, userId: string, a: Args) {
  const id = idArg(a, "scheduleId");
  if (!id) return { ok: false as const, message: "일정 id가 올바르지 않습니다" };
  const owned = await findOwnedSchedule(client, { scheduleId: id }, userId, { lock: true });
  if (!owned.ok) return { ok: false as const, message: owned.error };
  if (!unchanged(scheduleState(owned.row), a.expect)) return { ok: false as const, message: stale("일정이") };
  return { ok: true as const, row: owned.row };
}

/** 넘어온 항목만 바꾸고 나머지는 지금 값 → 검증된 일정 입력 */
function mergedEventInput(row: OwnedSchedule, a: Args) {
  const range = mergedRange(row, a);
  if ("error" in range) return { ok: false as const, error: range.error };
  return parseEventInput({
    ...range,
    title: a.title ?? row.title,
    location: a.location ?? row.location,
    description: a.memo ?? row.memo,
    leadId: a.leadId ?? row.leadId,
    noteId: row.noteId, scheduleId: null, invite: false,
  });
}

/** 지금 일정 → 바꿀 일정 카드 줄 */
function eventDiff(row: OwnedSchedule, d: CalendarEventInput, beforeLead?: string, afterLead?: string): AgentChange[] {
  const before = rangeLabel(row);
  const after = inputLabel(d);
  return [
    ...(d.title !== row.title ? [{ field: "제목", before: row.title, after: d.title }] : []),
    ...(after !== before ? [{ field: "일시", before, after }] : []),
    ...(d.location !== row.location ? [{ field: "장소", before: text(row.location), after: text(d.location) }] : []),
    ...(d.description !== row.memo ? [{ field: "메모", before: text(row.memo), after: text(d.description) }] : []),
    ...(d.leadId !== row.leadId ? [{ field: "리드", before: beforeLead, after: afterLead }] : []),
  ];
}

const updateEventTool: WriteTool = {
  kind: "write",
  label: "캘린더 일정 변경",
  def: {
    name: "update_calendar_event",
    description: "CRM에서 등록한 내 일정을 바꾸는 실행 계획을 만듭니다(사용자 승인 후 구글 캘린더에 반영). 바꿀 항목만 넘기세요. 날짜만 바꾸면 시간은 그대로 둡니다.",
    parameters: {
      type: "object",
      properties: { scheduleId: { type: "string", description: "scheduledMeetings.id 또는 캘린더 조회 결과의 scheduleId" }, ...EVENT_PROPS },
      required: ["scheduleId"],
    },
  },
  async prepare(a, userId) {
    const cal = await calendarUser(userId);
    if (!cal.ok) return { error: cal.error };
    const id = idArg(a, "scheduleId");
    if (!id) return { error: "일정 id가 올바르지 않습니다" };
    const owned = await findOwnedSchedule(pool, { scheduleId: id }, userId);
    if (!owned.ok) return { error: owned.error };
    const row = owned.row;

    const v = mergedEventInput(row, a);
    if (!v.ok) return { error: v.error };
    const d = v.data;
    const [beforeLead, afterLead] = await Promise.all([leadLabel(row.leadId), leadLabel(d.leadId)]);
    if (d.leadId && !afterLead) return { error: "연결할 리드를 찾을 수 없습니다" };
    const changes = eventDiff(row, d, beforeLead?.label, afterLead?.label);
    if (changes.length === 0) return { error: "바뀌는 항목이 없습니다" };
    return {
      title: "캘린더 일정 변경",
      changes,
      target: scheduleTarget(row),
      ...(row.inviteSent ? { notice: { tone: "warning" as const, text: "초대한 참석자에게 변경 알림 메일이 발송됩니다" } } : {}),
      args: { scheduleId: id, input: d, expect: scheduleState(row) },
    };
  },
  async execute(client, userId, a, ctx) {
    const cal = await calendarUser(userId);
    if (!cal.ok) return { ok: false, message: cal.error };
    const owned = await lockedOwned(client, userId, a);
    if (!owned.ok) return owned;
    const v = eventInputOf(a);
    if (!v.ok) return { ok: false, message: v.error };
    try {
      const r = await updateSchedule(cal.user, owned.row, v.data, { client, meta: ctx.meta });
      if (!r.ok) return { ok: false, message: r.error };
      return { ok: true, message: "일정을 변경했습니다", target: { kind: "event", id: r.schedule.id, label: r.schedule.title } };
    } catch (e) {
      return calendarFailure(e);
    }
  },
};

const cancelEventTool: WriteTool = {
  kind: "write",
  label: "캘린더 일정 취소",
  def: {
    name: "cancel_calendar_event",
    description: "CRM에서 등록한 내 일정을 취소하는 실행 계획을 만듭니다(사용자 승인 후 구글 캘린더에서 삭제).",
    parameters: { type: "object", properties: { scheduleId: { type: "string" } }, required: ["scheduleId"] },
  },
  async prepare(a, userId) {
    const cal = await calendarUser(userId);
    if (!cal.ok) return { error: cal.error };
    const id = idArg(a, "scheduleId");
    if (!id) return { error: "일정 id가 올바르지 않습니다" };
    const owned = await findOwnedSchedule(pool, { scheduleId: id }, userId);
    if (!owned.ok) return { error: owned.error };
    const row = owned.row;
    return {
      title: "캘린더 일정 취소",
      changes: [
        { field: "제목", before: row.title },
        { field: "일시", before: rangeLabel(row) },
        ...(row.leadId ? [{ field: "리드", before: (await leadLabel(row.leadId))?.label }] : []),
      ],
      target: scheduleTarget(row),
      danger: true,
      approveLabel: "취소 승인",
      ...(row.inviteSent ? { notice: { tone: "warning" as const, text: "초대한 참석자에게 취소 알림 메일이 발송됩니다" } } : {}),
      args: { scheduleId: id, expect: scheduleState(row) },
    };
  },
  async execute(client, userId, a, ctx) {
    const cal = await calendarUser(userId);
    if (!cal.ok) return { ok: false, message: cal.error };
    const owned = await lockedOwned(client, userId, a);
    if (!owned.ok) return owned;
    try {
      await cancelSchedule(cal.user, owned.row, { client, meta: ctx.meta });
      return { ok: true, message: "일정을 취소했습니다" };
    } catch (e) {
      return calendarFailure(e);
    }
  },
};

export const AGENT_MEETING_TOOLS: AgentTool[] = [searchNotes, getNote, createNoteTool, createEventTool, updateEventTool, cancelEventTool];
