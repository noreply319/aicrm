export type StageId =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost";

export type Priority = "high" | "mid" | "low";

export interface Lead {
  id: string;
  company: string;
  contact: string;
  title: string;
  email: string;
  phone: string;
  value: number;
  closeDate: string; // YYYY-MM-DD
  stage: StageId;
  priority: Priority;
  notes: string;
  createdAt: number;
}

export type LeadInput = Omit<Lead, "id" | "createdAt">;

/** AI Assistant 대화 메시지 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** 미팅 노트 입력 방식: 직접 입력/붙여넣기, 녹음 전사, 둘 다 */
export type NoteSource = "manual" | "recording" | "mixed";

/** 미팅 노트 (목록용: 본문은 미리보기만) */
export interface MeetingNoteSummary {
  id: string;
  /** 연결된 리드. null이면 리드 미지정 (녹음 후 자동 저장된 노트 등) */
  leadId: string | null;
  title: string;
  metAt: string; // ISO
  source: NoteSource;
  preview: string; // 본문 앞부분
  summary: string;
  nextActions: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** 미팅 노트 전체 (상세/수정용) */
export interface MeetingNote extends Omit<MeetingNoteSummary, "preview"> {
  body: string;
}

export type MeetingNoteInput = Pick<
  MeetingNote,
  "leadId" | "title" | "metAt" | "body" | "source" | "summary" | "nextActions"
>;

/** AI 요약 결과 */
export interface NoteSummaryResult {
  summary: string;
  nextActions: string;
}

/** 로그인 사용자 + 캘린더 연동 상태 (/api/me) */
export interface Me {
  id: string;
  email: string;
  name: string;
  picture: string;
  calendar: {
    /** connected: 사용 가능, expired: 토큰 만료·폐기(재연동 필요), none: 미연동 */
    state: "connected" | "expired" | "none";
    calendarId: string;
  };
  gmail: {
    /** connected: 사용 가능, expired: 토큰 만료·폐기(재연동 필요), none: 미연동 */
    state: "connected" | "expired" | "none";
    /** 메일 발송 권한(gmail.send)까지 받았는지 */
    canSend: boolean;
  };
}

/** Gmail 메일 목록 항목 (리드 이메일 주소로 검색한 결과) */
export interface EmailSummary {
  id: string;
  threadId: string;
  subject: string;
  /** 헤더 원문 ("이름 <주소>") */
  from: string;
  to: string;
  cc: string;
  date: string; // ISO
  snippet: string;
  /** sent: 내가 보낸 메일, received: 받은 메일 */
  direction: "sent" | "received";
  unread: boolean;
  hasAttachments: boolean;
  /** 담당자 본인이 아니라 같은 회사 도메인의 다른 사람과 주고받은 메일 */
  viaDomain?: boolean;
}

export interface EmailDetail extends EmailSummary {
  /** 본문 텍스트 (HTML 메일은 텍스트로 변환) */
  body: string;
  attachments: string[];
}

/** DB에 저장된 리드 메일: 제목·헤더 + AI 요약 (본문은 저장하지 않음) */
export interface StoredEmail extends EmailSummary {
  /** 1~2문장 AI 요약. 요약 전이면 빈 문자열 */
  summary: string;
  summaryStatus: "pending" | "done" | "failed";
}

export interface LeadEmails {
  /** 검색한 리드 이메일 주소 */
  address: string;
  /** 함께 검색한 회사 도메인 (무료 메일·사내 도메인이면 null) */
  domain: string | null;
  /** 저장된 메일 (최신순) */
  messages: StoredEmail[];
  /** Gmail에서 더 이전 메일을 가져올 페이지 토큰 (동기화 응답에만) */
  nextPageToken: string | null;
  /** 이번 동기화로 새로 저장한 메일 수 */
  added?: number;
  /** 아직 요약하지 않은 메일 수 */
  pending: number;
}

/** 구글 캘린더 목록 항목 (쓰기 가능한 캘린더) */
export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  color: string;
}

/** CRM에 연결된 일정 정보 */
export interface CrmLink {
  scheduleId: string;
  leadId: string | null;
  company: string | null;
  noteId: string | null;
}

/** 캘린더 화면용 일정 (구글 이벤트에서 필요한 값만) */
export interface CalendarEvent {
  id: string;
  title: string;
  /** 종일이면 'YYYY-MM-DD', 아니면 ISO */
  start: string;
  /** 종일이면 마지막 날 'YYYY-MM-DD'(포함), 아니면 ISO */
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  htmlLink: string;
  /** CRM에서 만든 일정이면 수정·삭제 가능 */
  crm: CrmLink | null;
}

/** 일정 등록/수정 입력 */
export interface CalendarEventInput {
  title: string;
  allDay: boolean;
  /** 종일이면 'YYYY-MM-DD', 아니면 ISO */
  start: string;
  end: string;
  location: string;
  description: string;
  leadId: string | null;
  noteId: string | null;
  /** 확정할 후보 id (미팅 노트에서 찾은 일정) */
  scheduleId: string | null;
  /** 리드 담당자에게 초대 메일 발송 */
  invite: boolean;
}

export type ScheduleStatus = "candidate" | "scheduled" | "canceled" | "dismissed";

/** 다음 미팅 일정: 노트에서 찾은 후보 + 캘린더에 등록한 일정 */
export interface ScheduledMeeting {
  id: string;
  leadId: string | null;
  noteId: string | null;
  userId: string | null;
  /** 등록자 이름 (다른 팀원 일정 표시용) */
  ownerName: string;
  status: ScheduleStatus;
  /** tentative: 시간 미정 등 확인 필요 */
  certainty: "confirmed" | "tentative";
  title: string;
  startsAt: string; // ISO
  endsAt: string; // ISO
  allDay: boolean;
  location: string;
  evidence: string;
  /** 사용자가 쓴 일정 메모 */
  memo: string;
  googleEventId: string | null;
  htmlLink: string;
  createdAt: string; // ISO
}

/** 노트 저장 후 다음 미팅 찾기 결과 */
export interface ExtractResult {
  /** 확인 없이 캘린더에 자동 등록한 일정 */
  registered: ScheduledMeeting[];
  /** 시간 미정이거나 캘린더를 쓸 수 없어 확인이 필요한 후보 */
  candidates: ScheduledMeeting[];
  /** 캘린더 미연동·만료·오류로 자동 등록하지 못한 이유 */
  calendarError?: string;
}

// ───────────────────────── 계약서·견적서 ─────────────────────────

export type DocKind = "contract" | "quote";

/** 템플릿 항목 유형 */
export type FieldType = "text" | "multiline" | "number" | "money" | "date" | "period" | "email" | "phone" | "choice";

/** 리드에서 자동으로 채울 값 */
export type LeadSource = "" | "company" | "contact" | "email" | "phone" | "value";

/** 템플릿에서 문서마다 바뀌는 부분 ({{key}}) */
export interface TemplateField {
  /** 본문의 {{key}}와 같은 이름 (예: "회사명") */
  key: string;
  type: FieldType;
  /** Assistant 질문 문구 (비우면 자동) */
  question: string;
  /** 예시·설명 */
  hint: string;
  required: boolean;
  defaultValue: string;
  leadSource: LeadSource;
  /** 선택지 유형의 보기 */
  options: string[];
}

/** 견적서 품목 표 설정 */
export interface LineItemsConfig {
  /** 규격 열 표시 */
  spec: boolean;
  /** excluded: 부가세 별도 10%, included: 단가에 부가세 포함, none: 부가세 없음 */
  vat: "excluded" | "included" | "none";
}

export interface LineItem {
  name: string;
  spec: string;
  qty: number;
  unitPrice: number;
}

export interface DocTemplateInput {
  kind: DocKind;
  name: string;
  description: string;
  body: string;
  fields: TemplateField[];
  lineItems: LineItemsConfig | null;
  emailSubject: string;
  emailBody: string;
}

export interface DocTemplate extends DocTemplateInput {
  id: string;
  archived: boolean;
  updatedAt: string; // ISO
  updatedByName: string;
  /** 이 템플릿으로 만든 문서 수 */
  documentCount: number;
}

export type DocStatus = "draft" | "completed" | "sent";

/** Assistant 빠른 답변 버튼 */
export interface QuickReply {
  label: string;
  action: DocAction;
  value?: string;
}

export type DocAction =
  | "select_lead" | "no_lead" | "answer" | "skip" | "items_done" | "remove_last_item"
  | "complete" | "complete_blank" | "fill_missing" | "reopen" | "move_stage" | "keep_stage";

export interface DocMessage {
  role: "assistant" | "user";
  text: string;
  at: string; // ISO
  /** filled: 값 반영 안내, result: 완성 카드, sent: 발송 완료 */
  kind?: "question" | "filled" | "info" | "result" | "sent" | "error";
  quick?: QuickReply[];
  /** 질문 메시지가 묻는 항목 (빠른 입력 표시용) */
  fieldKey?: string;
  /** sent: Gmail에서 보기 링크 */
  link?: string;
}

/** Assistant가 기다리는 입력 */
export type DocStep =
  | { type: "lead" }
  | { type: "items" }
  | { type: "field"; key: string }
  | { type: "review" }
  | { type: "confirm_complete"; missing: string[] }
  | { type: "done" };

/** 문서 목록 항목 */
export interface DocumentSummary {
  id: string;
  templateId: string | null;
  kind: DocKind;
  title: string;
  docNumber: string;
  leadId: string | null;
  company: string;
  status: DocStatus;
  createdBy: string | null;
  createdByName: string;
  /** 작성자 이메일 ({{작성자_이메일}}) */
  createdByEmail: string;
  updatedAt: string; // ISO
  sentAt: string | null;
  sendCount: number;
  /** 필수 항목 채움 현황 */
  progress: { filled: number; total: number };
}

export interface DocumentRecord extends DocumentSummary {
  body: string;
  fields: TemplateField[];
  lineItemsConfig: LineItemsConfig | null;
  emailSubject: string;
  emailBody: string;
  values: Record<string, string>;
  lineItems: LineItem[];
  skipped: string[];
  messages: DocMessage[];
  step: DocStep;
  createdAt: string;
  completedAt: string | null;
}

/** Assistant 응답: 갱신된 문서 + 이번에 바뀐 항목(화면 강조용) */
export interface DocChatResult {
  document: DocumentRecord;
  changed: string[];
  /** 리드 단계가 바뀌었으면 true (파이프라인 다시 불러오기) */
  leadChanged?: boolean;
}

/** 메일 작성 기본값 */
export interface DocEmailDraft {
  from: string;
  to: string[];
  subject: string;
  body: string;
  fileName: string;
  size: number;
  pages: number;
}
