import "server-only";
import type { PoolClient } from "pg";
import { featureState, type SessionUser } from "./auth";
import { CRM_DESCRIPTION_MARK, DATE_RE, STAGES, TIME_RE } from "./constants";
import { weekday } from "./format";
import {
  addDays, deleteEvent, fromKst, inputRange, insertEvent, kstDate, kstDateTime,
  SCHEDULE_COLUMNS, SCHEDULE_FROM, scheduleSnapshot, toSchedule, type ScheduleRow,
} from "./calendar";
import { pool } from "./db";
import { recordEvent, withTransaction } from "./events";
import { GoogleError } from "./google";
import { AiError, chatCompletion, maskPii } from "./openai";
import type { CalendarEvent, CalendarEventInput, ExtractResult, ScheduledMeeting } from "./types";

/** 미팅 노트 → 다음 미팅 일정 후보 (AI 추출) */

const MAX_CANDIDATES = 3;
const DEFAULT_MINUTES = 60;

const EXTRACT_PROMPT = `당신은 B2B 영업 담당자의 미팅 노트에서 "다음 미팅(후속 일정)"을 찾는 비서입니다.
노트에서 우리와 고객이 앞으로 만나거나 통화·데모·발표하기로 한 일정을 찾아 다음 JSON 객체만 출력하세요:
{"meetings": [{"title": string, "date": "YYYY-MM-DD", "startTime": "HH:mm" | null, "endTime": "HH:mm" | null,
  "location": string, "evidence": string, "certainty": "confirmed" | "tentative"}]}

- 노트에 명시된 미래 일정만 추출하세요. 추측해서 만들지 마세요. 없으면 {"meetings": []}.
- 우리 쪽 내부 업무 기한(견적서 발송 등)은 미팅이 아니므로 제외하세요.
- "다음 주 화요일", "모레" 같은 상대 표현은 아래 [미팅 일시]를 기준으로 계산하고, [날짜표]에서 요일을 확인하세요.
- 날짜·시간이 확정되지 않았으면("다음 주 중", "시간은 추후 조율") certainty를 "tentative"로 하고,
  날짜는 가장 이른 후보일, 시간이 없으면 startTime을 null로 두세요.
- title: "{회사명} {목적}" 형식의 짧은 제목 (예: "한빛소프트 데모 미팅").
- location: 언급된 장소나 방식(방문, 화상, 전화 등). 없으면 "".
- evidence: 근거가 된 노트 원문 한 문장 (100자 이내).
- 최대 ${MAX_CANDIDATES}개. 전사 텍스트에는 오인식이 있을 수 있으니 문맥에 맞게 해석하세요.`;

interface ExtractInput {
  title: string;
  body: string;
  summary: string;
  nextActions: string;
  metAt: Date;
  company: string | null;
}

interface Candidate {
  title: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  location: string;
  evidence: string;
  certainty: "confirmed" | "tentative";
}


export async function extractNextMeetings(input: ExtractInput): Promise<Candidate[]> {
  const base = kstDate(input.metAt);
  const dateTable = Array.from({ length: 28 }, (_, i) => addDays(base, i))
    .map((d) => `${d}(${weekday(d)})`)
    .join(" ");

  const content = await chatCompletion(
    [
      { role: "system", content: EXTRACT_PROMPT },
      {
        role: "user",
        content: [
          `[미팅 일시] ${kstDateTime(input.metAt)} (${weekday(base)}요일, 한국 시간)`,
          `[날짜표] ${dateTable}`,
          `[회사명] ${input.company ?? "(리드 미지정)"}`,
          `[제목] ${maskPii(input.title)}`,
          input.summary ? `[요약]\n${maskPii(input.summary)}` : "",
          input.nextActions ? `[다음 액션]\n${maskPii(input.nextActions)}` : "",
          `[본문]\n${maskPii(input.body.slice(0, 30000))}`,
        ].filter(Boolean).join("\n\n"),
      },
    ],
    { maxTokens: 1000, json: true, timeoutMs: 45_000 }
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AiError("일정 추출 결과를 읽지 못했습니다", 502);
  }
  const list = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).meetings : null;
  if (!Array.isArray(list)) return [];

  const today = kstDate(Date.now());
  const out: Candidate[] = [];
  for (const item of list.slice(0, MAX_CANDIDATES)) {
    const m = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const date = typeof m.date === "string" ? m.date : "";
    if (!DATE_RE.test(date) || date < today || Number.isNaN(Date.parse(date))) continue; // 지난 일정은 제외
    const start = typeof m.startTime === "string" && TIME_RE.test(m.startTime) ? m.startTime : null;
    const end = typeof m.endTime === "string" && TIME_RE.test(m.endTime) ? m.endTime : null;
    const title = (typeof m.title === "string" ? m.title.trim() : "").slice(0, 200) || `${input.company ?? ""} 미팅`.trim();

    let startsAt: Date, endsAt: Date;
    if (start) {
      startsAt = fromKst(date, start);
      endsAt = end && end > start ? fromKst(date, end) : new Date(startsAt.getTime() + DEFAULT_MINUTES * 60_000);
    } else {
      // 시간 미정: 그날 종일로 두고 확인 필요 표시
      startsAt = fromKst(date);
      endsAt = fromKst(addDays(date, 1));
    }
    out.push({
      title,
      startsAt,
      endsAt,
      allDay: !start,
      location: (typeof m.location === "string" ? m.location : "").slice(0, 300),
      evidence: (typeof m.evidence === "string" ? m.evidence : "").slice(0, 300),
      certainty: !start || m.certainty === "tentative" ? "tentative" : "confirmed",
    });
  }
  return out;
}

/**
 * 노트에서 후보를 찾아 저장하고 새로 찾은 후보만 반환한다.
 * 같은 노트에서 이미 저장(등록·무시 포함)한 일정과 시작 시각이 같으면 다시 제안하지 않는다.
 */
export async function createCandidatesForNote(noteId: string): Promise<ScheduledMeeting[]> {
  const { rows } = await pool.query<ExtractInput & { leadId: string | null }>(
    `SELECT n.title, n.body, n.summary, n.next_actions AS "nextActions", n.met_at AS "metAt",
            n.lead_id AS "leadId", l.company
     FROM meeting_notes n LEFT JOIN leads l ON l.id = n.lead_id WHERE n.id = $1`,
    [noteId]
  );
  const note = rows[0];
  if (!note) return [];

  const found = await extractNextMeetings(note);
  if (found.length === 0) return [];

  const existing = await pool.query<{ startsAt: Date; title: string }>(
    `SELECT starts_at AS "startsAt", title FROM scheduled_meetings WHERE note_id = $1`,
    [noteId]
  );
  const seen = new Set(existing.rows.map((r) => kstDate(r.startsAt)));
  const fresh = found.filter((c) => !seen.has(kstDate(c.startsAt)));
  if (fresh.length === 0) return [];

  const ids: string[] = [];
  for (const c of fresh) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO scheduled_meetings (lead_id, note_id, status, certainty, title, starts_at, ends_at, all_day, location, evidence)
       VALUES ($1, $2, 'candidate', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [note.leadId, noteId, c.certainty, c.title, c.startsAt, c.endsAt, c.allDay, c.location, c.evidence]
    );
    ids.push(r.rows[0].id);
  }
  return getSchedules({ ids });
}

/** 일정 목록 조회 */
export async function getSchedules(filter: { ids?: string[]; leadId?: string } = {}, client?: PoolClient): Promise<ScheduledMeeting[]> {
  const q = client ?? pool;
  const { rows } = await q.query<ScheduleRow>(
    `SELECT ${SCHEDULE_COLUMNS} FROM ${SCHEDULE_FROM}
     WHERE ($1::uuid[] IS NULL OR m.id = ANY($1))
       AND ($2::uuid IS NULL OR m.lead_id = $2)
       AND ($1::uuid[] IS NOT NULL OR m.status IN ('candidate','scheduled'))
       AND ($1::uuid[] IS NOT NULL OR m.lead_id IS NOT NULL OR m.note_id IS NOT NULL OR m.status = 'scheduled')
       AND ($1::uuid[] IS NOT NULL OR m.status = 'candidate' OR m.ends_at > now() - interval '90 days')
     ORDER BY m.starts_at`,
    [filter.ids ?? null, filter.leadId ?? null]
  );
  return rows.map(toSchedule);
}

/** 캘린더 이벤트 설명: 사용자가 쓴 메모 + CRM 연결 정보 (이메일·전화번호는 넣지 않는다) */
export function eventDescription(
  memo: string,
  lead: { company: string; stage: string } | null,
  noteTitle: string | null
): string {
  const crm = [
    lead ? `리드: ${lead.company} (${STAGES.find((s) => s.id === lead.stage)?.name ?? lead.stage})` : "",
    noteTitle ? `미팅 노트: ${noteTitle}` : "",
  ].filter(Boolean);
  return [memo.trim(), [CRM_DESCRIPTION_MARK, ...crm].join("\n")]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
}

/** 호출한 쪽 트랜잭션 안에서 SAVEPOINT로 감싸 실행 (실패하면 그 부분만 되돌리고 예외를 다시 던진다) */
export async function inSavepoint<T>(client: PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await client.query("SAVEPOINT schedule_step");
  try {
    const r = await fn(client);
    await client.query("RELEASE SAVEPOINT schedule_step");
    return r;
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT schedule_step");
    throw e;
  }
}

/** 일정 등록 실패 (사용자에게 보여줄 메시지 + 상태 코드) */
export class ScheduleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type LeadInfo = { company: string; stage: string; email: string };

/**
 * 일정 등록: 내 구글 캘린더에 이벤트 생성 + CRM 일정(scheduled_meetings) 저장.
 * scheduleId가 있으면 미팅 노트에서 찾은 후보를 확정한다.
 * 구글 먼저 만들고, DB 저장이 실패하면 방금 만든 이벤트를 지운다 (보상).
 */
export async function registerSchedule(
  user: SessionUser,
  d: CalendarEventInput,
  /**
   * client: 호출한 쪽 트랜잭션 안에서 저장 (Sales Agent 승인 실행). SAVEPOINT로 감싸 실패해도 그 트랜잭션은 계속 쓸 수 있다.
   * meta: meeting_scheduled 이력에 함께 남길 값 (예: { via: "agent" })
   */
  opts: { client?: PoolClient; meta?: Record<string, unknown> } = {}
): Promise<{ event: CalendarEvent; schedule: ScheduledMeeting }> {
  let noteId = d.noteId;
  if (d.scheduleId) {
    const c = (
      await pool.query<{ status: string; noteId: string | null }>(
        `SELECT status, note_id AS "noteId" FROM scheduled_meetings WHERE id = $1`,
        [d.scheduleId]
      )
    ).rows[0];
    if (!c) throw new ScheduleError("일정 후보를 찾을 수 없습니다", 404);
    if (c.status !== "candidate") throw new ScheduleError("이미 처리된 일정 후보입니다", 409);
    noteId = noteId ?? c.noteId;
  }

  const lead = d.leadId
    ? (await pool.query<LeadInfo>("SELECT company, stage, email FROM leads WHERE id = $1", [d.leadId])).rows[0]
    : null;
  if (d.leadId && !lead) throw new ScheduleError("연결할 리드를 찾을 수 없습니다", 400);
  const noteTitle = noteId
    ? (await pool.query<{ title: string }>("SELECT title FROM meeting_notes WHERE id = $1", [noteId])).rows[0]?.title ?? null
    : null;

  const attendees = d.invite && lead?.email ? [lead.email] : [];
  const created = await insertEvent(user, d, {
    description: eventDescription(d.description, lead, noteTitle),
    attendees,
    scheduleId: d.scheduleId ?? undefined,
  });

  const { startsAt, endsAt } = inputRange(d);
  const save = async (client: PoolClient): Promise<ScheduledMeeting> => {
      const params = [
        d.leadId, noteId, user.id, d.title, startsAt, endsAt, d.allDay, d.location,
        created.calendarId, created.id, created.htmlLink, attendees.length > 0, d.description,
      ];
      const row = d.scheduleId
        ? (
            await client.query<{ id: string }>(
              `UPDATE scheduled_meetings SET lead_id = $1, note_id = $2, user_id = $3, title = $4, starts_at = $5,
                      ends_at = $6, all_day = $7, location = $8, calendar_id = $9, google_event_id = $10,
                      google_html_link = $11, invite_sent = $12, memo = $13, status = 'scheduled',
                      certainty = 'confirmed', updated_at = now()
               WHERE id = $14 AND status = 'candidate' RETURNING id`,
              [...params, d.scheduleId]
            )
          ).rows[0]
        : (
            await client.query<{ id: string }>(
              `INSERT INTO scheduled_meetings (lead_id, note_id, user_id, title, starts_at, ends_at, all_day, location,
                      calendar_id, google_event_id, google_html_link, invite_sent, memo, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'scheduled') RETURNING id`,
              params
            )
          ).rows[0];
      if (!row) throw new ScheduleError("이미 처리된 일정 후보입니다", 409);
      if (d.leadId && lead) {
        await recordEvent(client, d.leadId, lead.company, "meeting_scheduled",
          { ...scheduleSnapshot({ id: row.id, title: d.title, startsAt, allDay: d.allDay, noteId }), ...opts.meta });
      }
      const r = await client.query<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM ${SCHEDULE_FROM} WHERE m.id = $1`, [row.id]);
      return toSchedule(r.rows[0]);
  };
  try {
    const schedule = opts.client ? await inSavepoint(opts.client, save) : await withTransaction(save);
    return {
      event: { ...created, crm: { scheduleId: schedule.id, leadId: d.leadId, company: lead?.company ?? null, noteId } },
      schedule,
    };
  } catch (e) {
    await deleteEvent(user, created.id, created.calendarId, false).catch(() => undefined);
    throw e;
  }
}

/**
 * 미팅 노트 저장 후: 다음 미팅을 찾아 날짜·시간이 확정된 일정은 확인 없이 바로 캘린더에 등록한다.
 * 시간 미정(tentative) 후보와 캘린더를 쓸 수 없을 때의 후보는 "확인 필요"로 남긴다.
 * 같은 리드에 같은 시작 시각의 일정이 이미 등록돼 있으면 중복 등록하지 않는다.
 */
export async function extractAndAutoRegister(noteId: string, user: SessionUser | null): Promise<ExtractResult> {
  const found = await createCandidatesForNote(noteId);
  const result: ExtractResult = { registered: [], candidates: [] };
  const calState = featureState(user, "calendar");
  const canRegister = calState === "connected";
  if (!canRegister && found.some((c) => c.certainty === "confirmed")) {
    result.calendarError = calState === "expired" ? "캘린더 연동이 만료되었습니다" : "캘린더가 연동되지 않았습니다";
  }

  for (const c of found) {
    if (!user || !canRegister || c.certainty !== "confirmed" || result.calendarError) {
      result.candidates.push(c);
      continue;
    }
    const dup = c.leadId
      ? (
          await pool.query(
            `SELECT 1 FROM scheduled_meetings WHERE lead_id = $1 AND starts_at = $2 AND status = 'scheduled' AND id <> $3`,
            [c.leadId, c.startsAt, c.id]
          )
        ).rowCount
      : 0;
    if (dup) {
      // 이미 같은 일정이 캘린더에 있으면 후보는 무시 처리
      await pool.query(`UPDATE scheduled_meetings SET status = 'dismissed', updated_at = now() WHERE id = $1`, [c.id]);
      continue;
    }
    try {
      const { schedule } = await registerSchedule(user, {
        title: c.title,
        allDay: c.allDay,
        start: c.startsAt,
        end: c.endsAt,
        location: c.location,
        description: c.evidence ? `노트 근거: "${c.evidence}"` : "",
        leadId: c.leadId,
        noteId: c.noteId,
        scheduleId: c.id,
        invite: false,
      });
      result.registered.push(schedule);
    } catch (e) {
      if (!(e instanceof GoogleError || e instanceof ScheduleError)) throw e;
      result.calendarError = e.message;
      result.candidates.push(c);
    }
  }
  return result;
}
