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
