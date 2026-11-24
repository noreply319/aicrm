import "server-only";
import { CONTACT_ROLE_LABEL, PRIORITY_LABEL, STAGES } from "./constants";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "./db";
import type { LeadEvent } from "./events";
import { featureState, getSessionUser, type ConnectionState, type SessionUser } from "./auth";
import { findRelevantEmails, searchStoredEmails, summarizePending, syncLeadEmails, type EmailContext } from "./emailStore";
import { leadTarget } from "./gmail";
import { addDays, fromKst, kstDate, kstDateTime, listEvents } from "./calendar";
import { chatCompletion, chatWithTools, maskPii, type ToolDef } from "./openai";
import type { ChatMessage, ContactRole } from "./types";
import { parseDateRange, UUID_RE } from "./validate";

export { AiError as AssistantError } from "./openai";

// 컨텍스트에 넣을 최근 이력 개수 상한 (토큰 비용 제한)
const MAX_EVENTS = 500;
// 미팅 노트: 최근 N건, 질문에 언급된 리드의 노트만 본문 포함 (토큰 비용 제한)
const MAX_NOTES = 100;
const MAX_COMPANIES = 500;
const COMPANY_NOTE_CHARS = 1000;
// 컨텍스트에 넣을 연락처 상한, 메모 길이
const MAX_CONTACTS = 1000;
const CONTACT_NOTE_CHARS = 500;
const NOTE_BODY_CHARS = 4000;
const NOTE_BODY_TOTAL_CHARS = 40000;
const TIME_ZONE = "Asia/Seoul";

const stageName = (id: unknown) => STAGES.find((s) => s.id === id)?.name ?? String(id);

// 'YYYY-MM-DD HH:mm' (한국 시간)
const kst = (d: Date | number) =>
  new Date(d).toLocaleString("sv-SE", { timeZone: TIME_ZONE }).slice(0, 16);

/** 단계 id를 한국어 이름으로 바꿔 모델이 읽기 쉽게 만든다 */
function readableChanges(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (k === "stage" && v && typeof v === "object" && "from" in v && "to" in v) {
      out[k] = { from: stageName(v.from), to: stageName(v.to) };
    } else if (k === "stage") {
      out[k] = stageName(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 컨텍스트에 넣을 CRM 일정 상한
const MAX_SCHEDULES = 200;
// 캘린더 도구: 한 번에 조회할 최대 기간·건수
const TOOL_MAX_DAYS = 90;
const TOOL_MAX_EVENTS = 100;

interface ScheduleContextRow {
  leadId: string | null;
  company: string | null;
  status: string;
  certainty: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  location: string;
  owner: string | null;
}

interface NoteContextRow {
  leadId: string | null;
  company: string | null;
  title: string;
  metAt: Date;
  source: string;
  summary: string;
  nextActions: string;
  body: string;
}

interface ContactContextRow {
  id: string;
  name: string;
  company: string | null;
  department: string;
  title: string;
  role: string | null;
  tags: string[];
  notes: string;
  owner: string | null;
}

interface CompanyContextRow {
  id: string;
  name: string;
  industry: string;
  size: string | null;
  tier: string | null;
  tags: string[];
  notes: string;
  emailDomain: string | null;
  owner: string | null;
}

/**
 * DB에서 현재 리드 + 변경 이력 + 미팅 노트를 읽어 모델 컨텍스트 문자열을 만든다.
 * question에 회사명이 언급된 리드의 노트는 본문까지 넣는다.
 */
async function buildContext(question: string, emails: EmailContext[] = []): Promise<string> {
  const [leadsRes, eventsRes, notesRes, schedulesRes, companiesRes, contactsRes] = await Promise.all([
    pool.query<LeadRow>(`SELECT ${LEAD_COLUMNS} FROM leads ORDER BY position`),
    pool.query<LeadEvent & { by: string | null }>(
      `SELECT e.lead_id AS "leadId", e.company, e.type, e.changes, e.created_at AS "createdAt", u.name AS "by"
       FROM lead_events e LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
      [MAX_EVENTS]
    ),
    pool.query<NoteContextRow>(
      `SELECT m.lead_id AS "leadId", l.company, m.title, m.met_at AS "metAt", m.source,
              m.summary, m.next_actions AS "nextActions", m.body
       FROM meeting_notes m LEFT JOIN leads l ON l.id = m.lead_id
       ORDER BY m.met_at DESC LIMIT $1`,
      [MAX_NOTES]
    ),
    pool.query<ScheduleContextRow>(
      `SELECT m.lead_id AS "leadId", l.company, m.status, m.certainty, m.title, m.starts_at AS "startsAt",
              m.ends_at AS "endsAt", m.all_day AS "allDay", m.location, coalesce(u.name, u.email) AS "owner"
       FROM scheduled_meetings m
       LEFT JOIN leads l ON l.id = m.lead_id LEFT JOIN users u ON u.id = m.user_id
       WHERE m.status IN ('candidate','scheduled') AND m.ends_at > now() - interval '30 days'
       ORDER BY m.starts_at LIMIT $1`,
      [MAX_SCHEDULES]
    ),
    // 회사 정보: 전화·주소·사업자번호·대표자명은 보내지 않는다 (개인정보 최소화)
    pool.query<CompanyContextRow>(
      `SELECT c.id, c.name, c.industry, c.size, c.tier, c.tags, c.notes, c.email_domain AS "emailDomain", u.name AS "owner"
       FROM companies c LEFT JOIN users u ON u.id = c.owner_id
       ORDER BY c.name LIMIT $1`,
      [MAX_COMPANIES]
    ),
    // 연락처: 이메일·전화·LinkedIn은 보내지 않는다 (개인정보 최소화)
    pool.query<ContactContextRow>(
      `SELECT ct.id, ct.name, co.name AS company, ct.department, ct.title, ct.role, ct.tags, ct.notes, u.name AS "owner"
       FROM contacts ct LEFT JOIN companies co ON co.id = ct.company_id LEFT JOIN users u ON u.id = ct.owner_id
       ORDER BY ct.name LIMIT $1`,
      [MAX_CONTACTS]
    ),
  ]);

  // 이메일·전화번호는 외부 API로 보내지 않는다 (개인정보 최소화)
  const leads = leadsRes.rows.map(toLead).map((l) => ({
    id: l.id,
    companyId: l.companyId,
    company: l.company,
    contactId: l.contactId,
    contact: l.contact,
    title: l.title,
    value: l.value,
    closeDate: l.closeDate || null,
    stage: stageName(l.stage),
    priority: PRIORITY_LABEL[l.priority],
    notes: maskPii(l.notes),
    createdAt: kst(l.createdAt),
  }));

  const events = eventsRes.rows.reverse().map((e) => ({
    at: kst(new Date(e.createdAt)),
    leadId: e.leadId,
    company: e.company,
    type: e.type,
    changes: readableChanges(e.changes),
    ...(e.by ? { by: e.by } : {}),
  }));

  // CRM에서 잡은 다음 미팅 (팀 전체). scheduled = 등록자 구글 캘린더에 등록됨, candidate = 노트에서 찾았지만 미확정
  const scheduledMeetings = schedulesRes.rows.map((m) => ({
    leadId: m.leadId,
    company: m.company ?? "(리드 미지정)",
    status: m.status,
    certainty: m.certainty,
    title: maskPii(m.title),
    start: m.allDay ? kstDate(m.startsAt) : kstDateTime(m.startsAt),
    end: m.allDay ? kstDate(new Date(m.endsAt.getTime() - 1)) : kstDateTime(m.endsAt),
    allDay: m.allDay,
    location: maskPii(m.location) || undefined,
    owner: m.owner ?? undefined,
  }));

  // 질문에 회사명이 나온 리드의 노트는 본문 포함, 나머지는 요약(없으면 본문 앞부분)만
  const q = question.toLowerCase();
  let bodyBudget = NOTE_BODY_TOTAL_CHARS;
  const meetingNotes = notesRes.rows.map((n) => {
    const mentioned = n.company !== null && q.includes(n.company.toLowerCase());
    const bodyText = mentioned && bodyBudget > 0 ? n.body.slice(0, Math.min(NOTE_BODY_CHARS, bodyBudget)) : "";
    bodyBudget -= bodyText.length;
    return {
      leadId: n.leadId,
      company: n.company ?? "(리드 미지정)",
      title: maskPii(n.title),
      metAt: kst(n.metAt),
      source: n.source,
      summary: maskPii(n.summary) || null,
      nextActions: maskPii(n.nextActions) || null,
      ...(bodyText
        ? { body: maskPii(bodyText) }
        : n.summary ? {} : { bodyPreview: maskPii(n.body.slice(0, 300)) }),
    };
  });

  // 회사 메모는 질문에 회사명이 나온 회사만 (나머지는 기본 정보만)
  const companies = companiesRes.rows.map((c) => ({
    id: c.id,
    name: c.name,
    industry: c.industry || undefined,
    size: c.size ?? undefined,
    tier: c.tier ?? undefined,
    tags: c.tags.length ? c.tags : undefined,
    owner: c.owner ?? undefined,
    emailDomain: c.emailDomain ?? undefined,
    ...(c.notes && q.includes(c.name.toLowerCase()) ? { notes: maskPii(c.notes.slice(0, COMPANY_NOTE_CHARS)) } : {}),
  }));

  // 연락처 메모는 질문에 이름이 나온 사람만
  const contacts = contactsRes.rows.map((c) => ({
    id: c.id,
    name: c.name,
    company: c.company ?? undefined,
    department: c.department || undefined,
    title: c.title || undefined,
    role: c.role ? CONTACT_ROLE_LABEL[c.role as ContactRole] : undefined,
    tags: c.tags.length ? c.tags : undefined,
    owner: c.owner ?? undefined,
    ...(c.notes && q.includes(c.name.toLowerCase()) ? { notes: maskPii(c.notes.slice(0, CONTACT_NOTE_CHARS)) } : {}),
  }));

  // 질문과 관련된 저장 메일(제목·AI 요약)만. 본문은 넣지 않는다
  return JSON.stringify({ companies, contacts, leads, events, meetingNotes, scheduledMeetings, emails });
}

type CalendarState = ConnectionState;

function gmailRules(state: ConnectionState, userName: string): string {
  const who = userName ? `${userName}님` : "로그인한 사용자";
  const base = `- emails는 ${who}의 Gmail에서 리드와 주고받은 메일 중 이 질문과 관련된 것만 골라 넣은 목록입니다(제목·AI 요약, 본문 없음).
  direction: sent(내가 보냄), received(고객 쪽에서 받음). with: contact(리드 담당자 본인), colleague(같은 회사 도메인의 다른 사람).
  메일을 근거로 답할 때는 "(출처: 메일 제목, 날짜)"를 붙이세요. 메일 주소·전화번호는 [이메일]/[전화번호]로 가려져 있습니다.`;
  if (state !== "connected") {
    return `${base}
  ${who}의 Gmail이 ${state === "expired" ? "연동 만료 상태라 새 메일은 가져올 수 없습니다" : "연동되지 않았습니다"}.
  메일 질문에 emails로 답할 수 없으면 그 사실을 알리고("설정 → Gmail에서 연동하세요"), 나머지 CRM 데이터로 답하세요.`;
  }
  return `${base}
  특정 리드(회사)에 대한 질문(현황, 요약, 다음 할 일, 고객 반응, 견적·계약 등)인데 emails에 그 리드 메일이 없거나 최신 메일이 필요하면
  search_lead_emails 도구에 leads의 id를 넣어 조회하세요(Gmail에서 새 메일만 가져와 요약). 리드를 특정하지 않은 메일 검색은 leadId 없이 query로 조회하세요.
  메일과 함께 리드 정보·이력·미팅 노트·일정을 종합해서 답하세요.`;
}

function calendarRules(state: CalendarState, userName: string): string {
  const who = userName ? `${userName}님` : "로그인한 사용자";
  if (state !== "connected") {
    return `- 구글 캘린더: ${who}의 캘린더가 ${state === "expired" ? "연동 만료 상태" : "연동되지 않은 상태"}입니다.
  일정 질문에는 그 사실을 먼저 알리고("설정 → Google 연동에서 연결하세요"), scheduledMeetings만으로 답하세요.`;
  }
  return `- 구글 캘린더: list_calendar_events 도구로 ${who}의 구글 캘린더 일정을 조회할 수 있습니다.
  "오늘/이번 주/다음 주 일정", "비어 있는 시간", 특정 회사 미팅 일시 등 일정 질문에는 필요한 기간만 조회해서 답하세요.
  비어 있는 시간을 물으면 조회한 일정 사이의 빈 시간을 업무 시간(09:00~18:00) 기준으로 알려주세요.
  도구 결과의 crmCompany가 있으면 CRM 리드와 연결된 일정입니다. 제목이 "[AI CRM]"으로 시작하면 CRM에서 등록한 일정입니다.`;
}

function systemPrompt(context: string, state: CalendarState = "none", userName = "", gmail: ConnectionState = "none"): string {
  return `당신은 Pipeline CRM의 AI Assistant입니다. 영업 담당자의 리드 관련 질문에 한국어로 간결하게 답합니다.

규칙:
- 아래 CRM 데이터만 근거로 답하세요. 데이터에 없는 내용은 추측하지 말고 "기록이 없습니다"라고 답하세요.
- 시간은 한국 시간(KST) 기준입니다. 현재 시각: ${kst(Date.now())} (${"일월화수목금토"[new Date(kst(Date.now()).slice(0, 10) + "T00:00:00Z").getUTCDay()]}요일)
- 금액은 원화(₩)이며 천 단위 구분 기호를 붙이세요.
- 단계 흐름: ${STAGES.map((s) => s.name).join(" → ")}. 파이프라인 금액은 수주·실주를 제외한 리드 금액 합계입니다.
- companies는 회사 목록입니다(업종·규모(직원 수)·등급 A/B/C·태그·담당 영업 owner). leads.companyId로 연결됩니다.
  회사 단위 질문(이 회사 리드 전체, 회사별 파이프라인 등)은 companyId로 묶어 답하세요. notes는 질문에 회사명이 나온 회사만 포함됩니다.
- contacts는 연락처(영업 상대방) 목록입니다(회사·부서·직함·역할 의사결정자/영향력자/실무자·태그·담당 영업 owner). leads.contactId로 담당 리드와 연결됩니다.
  사람 단위 질문(이 사람이 담당자인 리드, 회사의 의사결정자 등)은 contactId·company로 답하세요. 연락처의 이메일·전화번호는 제공되지 않습니다.
- events는 리드 변경 이력입니다. type: created(생성), updated(필드 수정, changes에 {from,to}), moved(단계 이동), deleted(삭제),
  note_created/note_updated/note_deleted(미팅 노트 작성/수정/삭제).
- meetingNotes는 리드별 미팅 노트입니다(최근 ${MAX_NOTES}건, 미팅 일시 최신순). summary(요약·고객 니즈), nextActions(다음 액션)를 우선 참고하세요.
  company가 "(리드 미지정)"인 노트는 아직 리드에 연결되지 않은 노트입니다.
  body는 질문에 회사명이 언급된 리드의 노트에만 포함됩니다. 노트를 근거로 답할 때는 "(출처: 노트 제목, 미팅 일시)"를 붙이세요.
  본문은 녹음 전사일 수 있어 오인식이 있을 수 있습니다.
  changes.backfilled=true인 created 이벤트는 이력 기능 도입 전 리드로, 생성 시각만 정확하고 그 이전 변경 내역은 없습니다.
  meeting_scheduled/meeting_rescheduled/meeting_canceled(다음 미팅 등록/변경/취소). by는 변경한 사용자입니다.
- 이력은 최근 ${MAX_EVENTS}건까지만 포함됩니다.
- scheduledMeetings는 CRM에서 잡은 다음 미팅입니다(팀 전체). status: scheduled(등록자 owner의 구글 캘린더에 등록됨),
  candidate(미팅 노트에서 찾았지만 아직 확정 안 됨, certainty=tentative면 시간 미정). 다른 팀원의 미팅은 여기서 답하세요.
  candidate를 말할 때는 반드시 "아직 확정 전인 후보(미팅 노트 기준)"라고 밝히세요.
${calendarRules(state, userName)}
${gmailRules(gmail, userName)}
- 당신은 데이터를 조회만 할 수 있습니다. 수정·삭제 요청에는 보드에서 직접 하도록 안내하세요.
  일정 등록 요청에는 "캘린더 메뉴의 일정 추가" 또는 "미팅 노트 저장 시 다음 미팅 등록"을 안내하세요.
- 답변은 짧은 문장이나 "- " 목록으로 작성하고, 마크다운 강조(**, #)는 쓰지 마세요 (일반 텍스트로 표시됩니다).

CRM 데이터(JSON):
${context}`;
}

const CALENDAR_TOOL: ToolDef = {
  name: "list_calendar_events",
  description: "로그인한 사용자의 구글 캘린더 일정을 기간으로 조회합니다 (한국 시간). 기간은 최대 90일.",
  parameters: {
    type: "object",
    properties: {
      start: { type: "string", description: "시작일 YYYY-MM-DD (포함)" },
      end: { type: "string", description: "종료일 YYYY-MM-DD (포함)" },
      query: { type: "string", description: "제목·장소 검색어 (선택)" },
    },
    required: ["start", "end"],
    additionalProperties: false,
  },
};

/** 캘린더 도구 실행: 제목·시간·장소·CRM 연결만 반환 (참석자·설명·회의 링크는 보내지 않음) */
async function runCalendarTool(user: SessionUser, args: unknown): Promise<unknown> {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const range = parseDateRange(
    typeof a.start === "string" ? a.start : null,
    typeof a.end === "string" ? a.end : null,
    TOOL_MAX_DAYS
  );
  if (!range.ok) return { error: range.error };
  const query = typeof a.query === "string" ? a.query.trim().slice(0, 100) : "";
  const events = await listEvents(user, fromKst(range.data.start), fromKst(addDays(range.data.end, 1)), {
    query: query || undefined,
    max: TOOL_MAX_EVENTS,
  });
  return {
    range: range.data,
    count: events.length,
    events: events.map((e) => ({
      title: maskPii(e.title),
      start: e.allDay ? e.start : kstDateTime(e.start),
      end: e.allDay ? e.end : kstDateTime(e.end),
      allDay: e.allDay,
      ...(e.location ? { location: maskPii(e.location) } : {}),
      ...(e.crm?.company ? { crmCompany: e.crm.company } : {}),
    })),
  };
}

// 이메일 도구: 최대 건수
const EMAIL_TOOL_MAX = 20;

const EMAIL_TOOL: ToolDef = {
  name: "search_lead_emails",
  description:
    "로그인한 사용자가 리드와 주고받은 메일의 제목·AI 요약을 최신순으로 조회합니다. " +
    "leadId를 주면 그 리드의 새 메일을 Gmail에서 먼저 가져와 요약한 뒤 조회하고, 없으면 저장된 메일 전체에서 query·days로 찾습니다.",
  parameters: {
    type: "object",
    properties: {
      leadId: { type: "string", description: "CRM 데이터 leads[].id (선택)" },
      query: { type: "string", description: "제목·요약 검색어 (선택, 예: 견적)" },
      days: { type: "integer", description: "최근 N일 이내 메일만 (선택, 1~365)" },
      max: { type: "integer", description: "최대 건수 (선택, 1~20, 기본 10)" },
    },
    additionalProperties: false,
  },
};

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/**
 * 이메일 도구 실행: 저장된 메일의 제목·요약만 반환 (본문·이메일 주소는 보내지 않음).
 * leadId가 있으면 Gmail에서 그 리드의 새 메일만 가져와 요약해 둔 뒤 조회한다.
 */
async function runEmailTool(user: SessionUser, args: unknown): Promise<unknown> {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const leadId = typeof a.leadId === "string" && a.leadId ? a.leadId : undefined;
  if (leadId && !UUID_RE.test(leadId)) return { error: "leadId가 올바르지 않습니다. CRM 데이터 leads[].id를 쓰세요" };
  const max = clampInt(a.max, 1, EMAIL_TOOL_MAX, 10);
  const days = a.days === undefined ? undefined : clampInt(a.days, 1, 365, 30);
  const query = typeof a.query === "string" ? a.query.slice(0, 100) : undefined;

  let note: string | undefined;
  if (leadId) {
    const { rows } = await pool.query<{ email: string }>("SELECT email FROM leads WHERE id = $1", [leadId]);
    if (!rows[0]) return { error: "리드를 찾을 수 없습니다" };
    const target = leadTarget(rows[0].email, user.email);
    if (!target) return { count: 0, emails: [], note: "이 리드에는 이메일 주소가 없습니다" };
    try {
      await syncLeadEmails(user, leadId, target);
      await summarizePending(user, { leadId, max: EMAIL_TOOL_MAX });
    } catch (e) {
      // Gmail·요약 실패여도 저장된 메일로 답한다
      note = `새 메일을 가져오지 못했습니다: ${e instanceof Error ? e.message : "알 수 없는 오류"}`;
    }
  }
  const emails = await searchStoredEmails(user, { leadId, query, days, max });
  return { count: emails.length, ...(days ? { days } : {}), ...(note ? { note } : {}), emails };
}

/**
 * 대화 내역을 받아 OpenAI로 답변을 생성한다.
 * 캘린더·Gmail이 연동돼 있으면 캘린더 조회·리드 이메일 조회 도구를 쓸 수 있다.
 */
export async function askAssistant(messages: ChatMessage[]): Promise<string> {
  const question = messages.at(-1)?.content ?? "";
  const user = await getSessionUser();
  const emails = user ? await findRelevantEmails(user, question) : [];
  const context = await buildContext(question, emails);
  const state = featureState(user, "calendar");
  const gmail = featureState(user, "gmail");
  const chat = [
    { role: "system" as const, content: systemPrompt(context, state, user?.name ?? "", gmail) },
    ...messages.map((m) => ({ ...m, content: maskPii(m.content) })),
  ];
  const tools = [...(state === "connected" ? [CALENDAR_TOOL] : []), ...(gmail === "connected" ? [EMAIL_TOOL] : [])];
  if (!user || tools.length === 0) return chatCompletion(chat, { maxTokens: 1200 });

  return chatWithTools(
    chat,
    tools,
    (name, args) =>
      name === CALENDAR_TOOL.name && state === "connected"
        ? runCalendarTool(user, args)
        : name === EMAIL_TOOL.name && gmail === "connected"
          ? runEmailTool(user, args)
          : Promise.resolve({ error: "알 수 없는 도구" }),
    { maxTokens: 1200, maxRounds: 3, timeoutMs: 40_000 }
  );
}
