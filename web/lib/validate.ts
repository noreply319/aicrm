import { businessDigits, isFreeMailDomain, normalizeDomain } from "./company";
import { isValidEmail, normalizeUrl } from "./contact";
import {
  COMPANY_NAME_MAX, COMPANY_NOTES_MAX, COMPANY_SIZES, COMPANY_TAG_LEN, COMPANY_TAG_MAX, COMPANY_TIERS,
  CONTACT_NAME_MAX, CONTACT_NOTES_MAX, CONTACT_ROLES, DATE_RE,
  NOTE_BODY_MAX, NOTE_SUMMARY_MAX, NOTE_TITLE_MAX, STAGES, stripCrmPrefix,
} from "./constants";
import { cleanItem, ITEM_LIMITS, syncFields, TEMPLATE_LIMITS } from "./docTemplate";
import type {
  CalendarEventInput, ChatMessage, CompanyInput, CompanySize, CompanyTier, ContactInput, ContactRole, DocAction, DocKind, DocTemplateInput, FieldType,
  LeadInput, LeadSource, LineItem, LineItemsConfig, MeetingNoteInput, NoteSource, Priority, StageId, TemplateField,
} from "./types";

const STAGE_IDS = new Set<string>(STAGES.map((s) => s.id));
const PRIORITIES = new Set<string>(["high", "mid", "low"]);
export const isPriority = (v: unknown): v is Priority => typeof v === "string" && PRIORITIES.has(v);

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

// ───────────────────────── 계약서·견적서 ─────────────────────────

const FIELD_TYPES = new Set<string>(["text", "multiline", "number", "money", "date", "period", "email", "phone", "choice"]);
const LEAD_SOURCES = new Set<string>(["", "company", "contact", "email", "phone", "value"]);
const oneLine = (v: unknown, max: number) => str(v, max).replace(/[\r\n]+/g, " ");
/** 줄바꿈을 보존하는 긴 텍스트 (앞뒤 공백만 제거) */
const longText = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");

export const isDocKind = (v: unknown): v is DocKind => v === "contract" || v === "quote";

function parseField(raw: unknown): TemplateField | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r) return null;
  const key = oneLine(r.key, TEMPLATE_LIMITS.key + 10);
  if (!key || key.length > TEMPLATE_LIMITS.key || /[{}]/.test(key)) return null;
  const options = Array.isArray(r.options)
    ? [...new Set(r.options.map((o) => oneLine(o, 50)).filter(Boolean))].slice(0, TEMPLATE_LIMITS.options)
    : [];
  return {
    key,
    type: (FIELD_TYPES.has(r.type as string) ? r.type : "text") as FieldType,
    question: oneLine(r.question, 200),
    hint: oneLine(r.hint, 200),
    required: r.required !== false,
    defaultValue: oneLine(r.defaultValue, 200),
    leadSource: (LEAD_SOURCES.has(r.leadSource as string) ? r.leadSource : "") as LeadSource,
    options,
  };
}

/** 템플릿 등록·수정 검증. 항목은 본문·메일 양식의 {{항목}}에 맞춰 정리한다 */
export function parseTemplateInput(body: unknown): { ok: true; data: DocTemplateInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "잘못된 요청입니다" };
  const b = body as Record<string, unknown>;
  if (!isDocKind(b.kind)) return { ok: false, error: "문서 종류를 선택하세요" };
  const name = oneLine(b.name, TEMPLATE_LIMITS.name);
  if (!name) return { ok: false, error: "템플릿 이름을 입력하세요" };
  const text = longText(b.body, TEMPLATE_LIMITS.body + 1);
  if (!text) return { ok: false, error: "본문을 입력하세요" };
  if (text.length > TEMPLATE_LIMITS.body) return { ok: false, error: `본문은 ${TEMPLATE_LIMITS.body.toLocaleString()}자 이하로 입력하세요` };
  const emailSubject = oneLine(b.emailSubject, 200);
  const emailBody = longText(b.emailBody, TEMPLATE_LIMITS.email);

  const parsed: TemplateField[] = [];
  for (const raw of Array.isArray(b.fields) ? b.fields : []) {
    const f = parseField(raw);
    if (!f) return { ok: false, error: "항목 이름이 올바르지 않습니다 (40자 이하, 중괄호 불가)" };
    if (parsed.some((p) => p.key === f.key)) return { ok: false, error: `항목 이름이 중복됩니다: ${f.key}` };
    parsed.push(f);
  }
  const fields = syncFields([text, emailSubject, emailBody], parsed);
  if (fields.length > TEMPLATE_LIMITS.fields) return { ok: false, error: `항목은 ${TEMPLATE_LIMITS.fields}개 이하로 만드세요` };
  const noOptions = fields.find((f) => f.type === "choice" && f.options.length === 0);
  if (noOptions) return { ok: false, error: `"${noOptions.key}" 선택지 보기를 1개 이상 입력하세요` };

  const li = b.lineItems && typeof b.lineItems === "object" ? (b.lineItems as Record<string, unknown>) : {};
  const lineItems: LineItemsConfig | null =
    b.kind === "quote"
      ? { spec: li.spec !== false, vat: li.vat === "included" || li.vat === "none" ? li.vat : "excluded" }
      : null;

  return {
    ok: true,
    data: { kind: b.kind, name, description: oneLine(b.description, TEMPLATE_LIMITS.description), body: text, fields, lineItems, emailSubject, emailBody },
  };
}

const DOC_ACTIONS = new Set<string>([
  "select_lead", "no_lead", "answer", "skip", "items_done", "remove_last_item",
  "complete", "complete_blank", "fill_missing", "reopen", "move_stage", "keep_stage",
]);

/** Assistant 입력: { message } 또는 { action, value } */
export function parseDocChatInput(body: unknown):
  { ok: true; data: { message: string; action: DocAction | null; value: string } } | { ok: false; error: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (message.length > MAX_CHAT_CHARS) return { ok: false, error: `메시지는 ${MAX_CHAT_CHARS}자 이하로 입력하세요` };
  const action = DOC_ACTIONS.has(b.action as string) ? (b.action as DocAction) : null;
  if (b.action !== undefined && !action) return { ok: false, error: "잘못된 요청입니다" };
  if (!message && !action) return { ok: false, error: "답변을 입력하세요" };
  return { ok: true, data: { message, action, value: typeof b.value === "string" ? b.value.trim().slice(0, 500) : "" } };
}

/** 문서 직접 수정: { values?, lineItems?, title? } */
export function parseDocPatch(body: unknown):
  { ok: true; data: { values?: Record<string, string>; lineItems?: LineItem[]; title?: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "잘못된 요청입니다" };
  const b = body as Record<string, unknown>;
  const data: { values?: Record<string, string>; lineItems?: LineItem[]; title?: string } = {};
  if (b.values !== undefined) {
    if (!b.values || typeof b.values !== "object" || Array.isArray(b.values)) return { ok: false, error: "잘못된 요청입니다" };
    const entries = Object.entries(b.values as Record<string, unknown>);
    if (entries.length > TEMPLATE_LIMITS.fields) return { ok: false, error: "잘못된 요청입니다" };
    data.values = {};
    for (const [k, v] of entries) {
      if (typeof v !== "string") return { ok: false, error: "잘못된 요청입니다" };
      data.values[k.slice(0, TEMPLATE_LIMITS.key)] = v.slice(0, 2000);
    }
  }
  if (b.lineItems !== undefined) {
    if (!Array.isArray(b.lineItems) || b.lineItems.length > ITEM_LIMITS.count) return { ok: false, error: `품목은 ${ITEM_LIMITS.count}개 이하로 입력하세요` };
    const items = b.lineItems.map(cleanItem);
    if (items.some((i) => i === null)) return { ok: false, error: "품목 이름·수량·단가를 확인하세요" };
    data.lineItems = items as LineItem[];
  }
  if (b.title !== undefined) {
    const title = oneLine(b.title, 200);
    if (!title) return { ok: false, error: "문서 제목을 입력하세요" };
    data.title = title;
  }
  return { ok: true, data };
}

/** 메일 주소 (헤더에 그대로 들어가므로 엄격하게) */
const MAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
export const isMailAddress = (v: string) => v.length <= 254 && MAIL_RE.test(v);

function addressList(v: unknown): string[] | null {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\s]+/) : [];
  const list = [...new Set(raw.map((x) => (typeof x === "string" ? x.trim().toLowerCase() : "")).filter(Boolean))];
  return list.every(isMailAddress) ? list : null;
}

/** 메일 제목(한 줄, 200자)·본문(10,000자) */
export function parseMailText(b: Record<string, unknown>): { ok: true; data: { subject: string; body: string } } | { ok: false; error: string } {
  const subject = oneLine(b.subject, 200);
  if (!subject) return { ok: false, error: "메일 제목을 입력하세요" };
  return { ok: true, data: { subject, body: longText(b.body, 10_000) } };
}

/** 문서 메일 발송: { to[], cc[], subject, body, fileName } */
export function parseSendInput(body: unknown):
  { ok: true; data: { to: string[]; cc: string[]; subject: string; body: string; fileName: string } } | { ok: false; error: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const to = addressList(b.to);
  const cc = addressList(b.cc ?? []);
  if (!to || !cc) return { ok: false, error: "이메일 주소 형식을 확인하세요" };
  if (to.length === 0) return { ok: false, error: "받는 사람을 입력하세요" };
  if (to.length + cc.length > 20) return { ok: false, error: "받는 사람·참조는 합쳐서 20명 이하로 입력하세요" };
  const t = parseMailText(b);
  if (!t.ok) return t;
  const { subject, body: text } = t.data;
  let fileName = oneLine(b.fileName, 120).replace(/[\\/:*?"<>|]+/g, "_");
  if (!fileName) return { ok: false, error: "파일 이름을 입력하세요" };
  if (!/\.pdf$/i.test(fileName)) fileName += ".pdf";
  return { ok: true, data: { to, cc, subject, body: text, fileName } };
}

/* ───────── 명함 (AIC-10) ───────── */

/** 이미지 형식은 확장자·Content-Type이 아니라 파일 앞부분(매직 바이트)으로 판단한다. 지원: JPEG·PNG·WebP */
export function sniffImage(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => bytes[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/**
 * 명함 저장 요청: { companyId } 또는 { company: 새 회사 } (둘 다 없으면 회사 없이), { contact }.
 * 회사·연락처 값은 기존 회사·연락처 검증을 그대로 쓴다. 연락처의 companyId는 서버가 정한다.
 */
export function parseBusinessCardSave(
  body: unknown
): { ok: true; data: { companyId: string | null; company: CompanyInput | null; contact: ContactInput } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "잘못된 요청입니다" };
  const b = body as Record<string, unknown>;

  const companyId = optionalId(b.companyId);
  if (companyId === false) return { ok: false, error: "회사가 올바르지 않습니다" };
  let company: CompanyInput | null = null;
  if (!companyId && b.company !== null && b.company !== undefined) {
    const c = parseCompanyInput(b.company);
    if (!c.ok) return c;
    company = c.data;
  }

  if (!b.contact || typeof b.contact !== "object") return { ok: false, error: "연락처 정보가 없습니다" };
  const contact = parseContactInput({ ...(b.contact as Record<string, unknown>), companyId: null });
  if (!contact.ok) return contact;
  return { ok: true, data: { companyId, company, contact: contact.data } };
}
