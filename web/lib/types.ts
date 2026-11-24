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
  /** 연결된 회사. 회사 기능 도입 전 리드는 마이그레이션으로 연결된다 */
  companyId: string | null;
  /** 회사명 사본 (회사명을 바꾸면 서버가 함께 갱신) */
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

export type CompanySize = "1-10" | "11-50" | "51-200" | "201-1000" | "1000+";
export type CompanyTier = "A" | "B" | "C";

/** 회사 (팀 공유) */
export interface Company {
  id: string;
  name: string;
  website: string;
  /** 회사 메일 도메인 (소문자). 없으면 null */
  emailDomain: string | null;
  industry: string;
  size: CompanySize | null;
  phone: string;
  address: string;
  /** 사업자등록번호 숫자 10자리 (하이픈 없이) */
  businessNumber: string;
  ceoName: string;
  /** 담당 영업 (users.id) */
  ownerId: string | null;
  tier: CompanyTier | null;
  tags: string[];
  notes: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export type CompanyInput = Omit<Company, "id" | "createdAt" | "updatedAt">;

/** 담당 영업 선택용 팀원 */
export interface TeamMember {
  id: string;
  name: string;
}

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
