import { businessDigits, isFreeMailDomain, normalizeDomain } from "./company";
import { isValidEmail, normalizeUrl } from "./contact";
import {
  COMPANY_NAME_MAX, COMPANY_NOTES_MAX, COMPANY_SIZES, COMPANY_TAG_LEN, COMPANY_TAG_MAX, COMPANY_TIERS,
  CONTACT_NAME_MAX, CONTACT_NOTES_MAX, CONTACT_ROLES,
  NOTE_BODY_MAX, NOTE_SUMMARY_MAX, NOTE_TITLE_MAX, STAGES, stripCrmPrefix,
} from "./constants";
import type {
  CalendarEventInput, ChatMessage, CompanyInput, CompanySize, CompanyTier, ContactInput, ContactRole, LeadInput, MeetingNoteInput, NoteSource, Priority, StageId,
} from "./types";

const STAGE_IDS = new Set<string>(STAGES.map((s) => s.id));
const PRIORITIES = new Set<string>(["high", "mid", "low"]);

export const isStage = (v: unknown): v is StageId => typeof v === "string" && STAGE_IDS.has(v);

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 요청 본문을 검증된 LeadInput으로 변환. 잘못되면 에러 메시지를 반환. */
export function parseLeadInput(body: unknown): { ok: true; data: LeadInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "잘못된 요청입니다" };
  const b = body as Record<string, unknown>;

  // 회사는 companyId로 지정한다. companyId 없이 회사명만 오면 서버가 같은 이름의 회사를 찾거나 만든다.
  const companyId = typeof b.companyId === "string" && b.companyId !== "" ? b.companyId : null;
  if (companyId !== null && !UUID_RE.test(companyId)) return { ok: false, error: "회사가 올바르지 않습니다" };
  const company = str(b.company, COMPANY_NAME_MAX);
  if (!companyId && !company) return { ok: false, error: "회사명은 필수입니다" };

  // 담당자는 contactId로 지정한다 (담당자 사본은 서버가 연락처 값으로 채움). 없으면 보낸 텍스트를 그대로 둔다.
  const contactId = typeof b.contactId === "string" && b.contactId !== "" ? b.contactId : null;
  if (contactId !== null && !UUID_RE.test(contactId)) return { ok: false, error: "담당자가 올바르지 않습니다" };

  const value = Number(b.value ?? 0);
  if (!Number.isFinite(value) || value < 0) return { ok: false, error: "금액이 올바르지 않습니다" };

  const closeDate = str(b.closeDate, 10);
  if (closeDate && !/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) return { ok: false, error: "날짜 형식이 올바르지 않습니다" };

  const stage = isStage(b.stage) ? b.stage : "new";
  const priority = (PRIORITIES.has(b.priority as string) ? b.priority : "mid") as Priority;

  return {
    ok: true,
    data: {
      companyId,
      company,
      contactId,
      contact: str(b.contact, 100),
      title: str(b.title, 100),
      email: str(b.email, 200),
      phone: str(b.phone, 50),
      value: Math.round(value),
      closeDate,
      stage,
      priority,
      notes: str(b.notes, 5000),
    },
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 태그 목록 검증 (회사·연락처 공용): 공백 제거·중복 제거. 잘못되면 에러 메시지 문자열 */
function parseTags(v: unknown): string[] | string {
  if (v !== undefined && v !== null && !Array.isArray(v)) return "태그가 올바르지 않습니다";
  const tags: string[] = [];
  for (const t of (v as unknown[] | undefined) ?? []) {
    const tag = str(t, 1000);
    if (!tag) continue;
    if (tag.length > COMPANY_TAG_LEN) return `태그는 ${COMPANY_TAG_LEN}자 이하로 입력하세요`;
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > COMPANY_TAG_MAX) return `태그는 ${COMPANY_TAG_MAX}개까지 등록할 수 있습니다`;
  return tags;
}

const optionalId = (v: unknown): string | null | false =>
  v === null || v === undefined || v === "" ? null : typeof v === "string" && UUID_RE.test(v) ? v : false;

const ROLE_IDS = new Set<string>(CONTACT_ROLES.map((r) => r.id));
const PHONE_RE = /^[0-9+\-()\s]*$/;

/** 연락처 요청 본문 검증. 이름만 보내도 된다 (리드 모달에서 바로 생성). */
export function parseContactInput(body: unknown): { ok: true; data: ContactInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "잘못된 요청입니다" };
  const b = body as Record<string, unknown>;

  const name = str(b.name, 1000).replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "이름은 필수입니다" };
  if (name.length > CONTACT_NAME_MAX) return { ok: false, error: `이름은 ${CONTACT_NAME_MAX}자 이하로 입력하세요` };

  const companyId = optionalId(b.companyId);
  if (companyId === false) return { ok: false, error: "회사가 올바르지 않습니다" };
  const ownerId = optionalId(b.ownerId);
  if (ownerId === false) return { ok: false, error: "담당 영업이 올바르지 않습니다" };

  const email = str(b.email, 1000).toLowerCase();
  if (email && (email.length > 254 || !isValidEmail(email))) return { ok: false, error: "이메일 형식이 올바르지 않습니다" };

  const mobile = str(b.mobile, 1000);
  if (mobile.length > 30 || !PHONE_RE.test(mobile)) return { ok: false, error: "휴대폰 번호는 숫자·-·+만 30자 이하로 입력하세요" };
  const officePhone = str(b.officePhone, 1000);
  if (officePhone.length > 30) return { ok: false, error: "유선 전화는 30자 이하로 입력하세요" };

  const rawUrl = str(b.linkedinUrl, 1000);
  const linkedinUrl = rawUrl ? normalizeUrl(rawUrl) : "";
  if (linkedinUrl === null || linkedinUrl.length > 500) return { ok: false, error: "LinkedIn 주소가 올바르지 않습니다" };

  const role = b.role === null || b.role === undefined || b.role === "" ? null : ROLE_IDS.has(b.role as string) ? (b.role as ContactRole) : false;
  if (role === false) return { ok: false, error: "역할이 올바르지 않습니다" };

  const tags = parseTags(b.tags);
  if (typeof tags === "string") return { ok: false, error: tags };

  const notes = typeof b.notes === "string" ? b.notes.trim() : "";
  if (notes.length > CONTACT_NOTES_MAX) return { ok: false, error: `메모는 ${CONTACT_NOTES_MAX.toLocaleString()}자 이하로 입력하세요` };

  return {
    ok: true,
    data: {
      name,
      companyId,
      department: str(b.department, 50),
      title: str(b.title, 50),
      email,
      mobile,
      officePhone,
      linkedinUrl,
      role,
      ownerId,
      tags,
      notes,
    },
  };
}

const SIZES = new Set<string>(COMPANY_SIZES);
const TIERS = new Set<string>(COMPANY_TIERS);

/** 회사 요청 본문 검증. 이름만 보내도 된다 (리드 모달에서 바로 생성). */
export function parseCompanyInput(body: unknown): { ok: true; data: CompanyInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "잘못된 요청입니다" };
  const b = body as Record<string, unknown>;

  const name = str(b.name, 1000).replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "회사명은 필수입니다" };
  if (name.length > COMPANY_NAME_MAX) return { ok: false, error: `회사명은 ${COMPANY_NAME_MAX}자 이하로 입력하세요` };

  let website = str(b.website, 500);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;

  const rawDomain = str(b.emailDomain, 253);
  let emailDomain: string | null = null;
  if (rawDomain) {
    emailDomain = normalizeDomain(rawDomain);
    if (!emailDomain) return { ok: false, error: "이메일 도메인 형식이 올바르지 않습니다 (예: acme.co.kr)" };
    if (isFreeMailDomain(emailDomain)) return { ok: false, error: "무료 메일 도메인은 회사 도메인으로 등록할 수 없습니다" };
  }

  const size = b.size === null || b.size === undefined || b.size === "" ? null : SIZES.has(b.size as string) ? (b.size as CompanySize) : false;
  if (size === false) return { ok: false, error: "회사 규모가 올바르지 않습니다" };
  const tier = b.tier === null || b.tier === undefined || b.tier === "" ? null : TIERS.has(b.tier as string) ? (b.tier as CompanyTier) : false;
  if (tier === false) return { ok: false, error: "등급이 올바르지 않습니다" };

  // 사업자등록번호: 숫자 10자리만 강제 (검증 숫자가 틀리면 화면에서 경고만)
  const businessNumber = businessDigits(str(b.businessNumber, 30));
  if (businessNumber && businessNumber.length !== 10) return { ok: false, error: "사업자등록번호는 숫자 10자리로 입력하세요" };

  const ownerId = typeof b.ownerId === "string" && b.ownerId !== "" ? b.ownerId : null;
  if (ownerId !== null && !UUID_RE.test(ownerId)) return { ok: false, error: "담당 영업이 올바르지 않습니다" };

  const tags = parseTags(b.tags);
  if (typeof tags === "string") return { ok: false, error: tags };

  const notes = typeof b.notes === "string" ? b.notes.trim() : "";
  if (notes.length > COMPANY_NOTES_MAX) return { ok: false, error: `메모는 ${COMPANY_NOTES_MAX.toLocaleString()}자 이하로 입력하세요` };

  return {
    ok: true,
    data: {
      name,
      website,
      emailDomain,
      industry: str(b.industry, 50),
      size,
      phone: str(b.phone, 30),
      address: str(b.address, 300),
      businessNumber,
      ceoName: str(b.ceoName, 50),
      ownerId,
      tier,
      tags,
      notes,
    },
  };
}

const MAX_CHAT_MESSAGES = 20;
const MAX_CHAT_CHARS = 2000;

/** AI Assistant 요청 본문 { messages } 검증. 최근 메시지만 남기고, 마지막은 사용자 질문이어야 한다. */
export function parseChatInput(body: unknown): { ok: true; data: ChatMessage[] } | { ok: false; error: string } {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).messages : null;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "잘못된 요청입니다" };

  const messages: ChatMessage[] = [];
  for (const m of raw.slice(-MAX_CHAT_MESSAGES)) {
    const r = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
    if ((r.role !== "user" && r.role !== "assistant") || typeof r.content !== "string") {
      return { ok: false, error: "잘못된 요청입니다" };
    }
    const content = r.content.trim();
    if (content.length > MAX_CHAT_CHARS) return { ok: false, error: `메시지는 ${MAX_CHAT_CHARS}자 이하로 입력하세요` };
    if (content) messages.push({ role: r.role, content });
  }
  if (messages.at(-1)?.role !== "user") return { ok: false, error: "질문을 입력하세요" };
  return { ok: true, data: messages };
}

const NOTE_SOURCES = new Set<string>(["manual", "recording", "mixed"]);

/** 미팅 노트 요청 본문 검증 */
export function parseNoteInput(body: unknown): { ok: true; data: MeetingNoteInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "잘못된 요청입니다" };
  const b = body as Record<string, unknown>;

  // 리드는 나중에 지정할 수 있다 (null 또는 빈 문자열 = 미지정)
  const leadId = typeof b.leadId === "string" && b.leadId !== "" ? b.leadId : null;
  if (leadId !== null && !UUID_RE.test(leadId)) return { ok: false, error: "리드가 올바르지 않습니다" };

  const title = str(b.title, NOTE_TITLE_MAX);
  if (!title) return { ok: false, error: "제목은 필수입니다" };

  const metAt = typeof b.metAt === "string" ? new Date(b.metAt) : null;
  if (!metAt || Number.isNaN(metAt.getTime())) return { ok: false, error: "미팅 일시가 올바르지 않습니다" };

  // 본문은 줄바꿈·들여쓰기를 보존하기 위해 trim하지 않는다 (앞뒤 빈 줄만 제거)
  const rawBody = typeof b.body === "string" ? b.body.replace(/^\s*\n|\n\s*$/g, "") : "";
  if (!rawBody.trim()) return { ok: false, error: "본문을 입력하세요" };
  if (rawBody.length > NOTE_BODY_MAX) return { ok: false, error: `본문은 ${NOTE_BODY_MAX.toLocaleString()}자 이하로 입력하세요` };

  const source = (NOTE_SOURCES.has(b.source as string) ? b.source : "manual") as NoteSource;

  return {
    ok: true,
    data: {
      leadId,
      title,
      metAt: metAt.toISOString(),
      body: rawBody,
      source,
      summary: str(b.summary, NOTE_SUMMARY_MAX),
      nextActions: str(b.nextActions, NOTE_SUMMARY_MAX),
    },
  };
}

/** AI 요약 요청 { title, body } 검증 */
export function parseSummarizeInput(body: unknown): { ok: true; data: { title: string; body: string } } | { ok: false; error: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (!text) return { ok: false, error: "요약할 본문이 없습니다" };
  if (text.length > NOTE_BODY_MAX) return { ok: false, error: `본문은 ${NOTE_BODY_MAX.toLocaleString()}자 이하여야 합니다` };
  return { ok: true, data: { title: str(b.title, NOTE_TITLE_MAX), body: text } };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const optionalUuid = (v: unknown): string | null | false =>
  v === null || v === undefined || v === "" ? null : typeof v === "string" && UUID_RE.test(v) ? v : false;

/** 일정 등록/수정 요청 검증 */
export function parseEventInput(body: unknown): { ok: true; data: CalendarEventInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "잘못된 요청입니다" };
  const b = body as Record<string, unknown>;

  // 구글 일정 제목의 [AI CRM] 표시는 저장하지 않는다 (등록할 때 다시 붙임)
  const title = stripCrmPrefix(str(b.title, 200));
  if (!title) return { ok: false, error: "일정 제목을 입력하세요" };

  const allDay = b.allDay === true;
  const start = typeof b.start === "string" ? b.start.trim() : "";
  const end = typeof b.end === "string" ? b.end.trim() : "";
  let startIso = start;
  let endIso = end;
  if (allDay) {
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) return { ok: false, error: "날짜를 입력하세요" };
    if (end < start) return { ok: false, error: "종료일이 시작일보다 빠릅니다" };
  } else {
    const s = new Date(start);
    const e = new Date(end);
    if (!start || !end || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return { ok: false, error: "시작·종료 시각을 입력하세요" };
    if (e <= s) return { ok: false, error: "종료 시각이 시작 시각보다 늦어야 합니다" };
    startIso = s.toISOString();
    endIso = e.toISOString();
  }
  const days = (Date.parse(allDay ? end : endIso) - Date.parse(allDay ? start : startIso)) / 86_400_000;
  if (days > 31) return { ok: false, error: "일정 기간은 31일 이하로 입력하세요" };

  const leadId = optionalUuid(b.leadId);
  const noteId = optionalUuid(b.noteId);
  const scheduleId = optionalUuid(b.scheduleId);
  if (leadId === false || noteId === false || scheduleId === false) return { ok: false, error: "잘못된 요청입니다" };

  return {
    ok: true,
    data: {
      title,
      allDay,
      start: startIso,
      end: endIso,
      location: str(b.location, 300),
      description: typeof b.description === "string" ? b.description.trim().slice(0, 4000) : "",
      leadId,
      noteId,
      scheduleId,
      invite: b.invite === true,
    },
  };
}

/** 'YYYY-MM-DD' 조회 기간 검증 (end 포함) */
export function parseDateRange(start: string | null, end: string | null, maxDays: number):
  { ok: true; data: { start: string; end: string } } | { ok: false; error: string } {
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end) || end < start) {
    return { ok: false, error: "조회 기간이 올바르지 않습니다" };
  }
  if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > maxDays) {
    return { ok: false, error: `조회 기간은 ${maxDays}일 이하로 지정하세요` };
  }
  return { ok: true, data: { start, end } };
}

/** Gmail 목록 다음 페이지 토큰 (영숫자) */
export const PAGE_TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
