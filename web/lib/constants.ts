import type { NoteSource, Priority, StageId } from "./types";

export const STAGES: { id: StageId; name: string; color: string }[] = [
  { id: "new", name: "신규 리드", color: "#8a90a2" },
  { id: "contacted", name: "첫 컨택", color: "#3b9eff" },
  { id: "qualified", name: "니즈 확인", color: "#00b8a9" },
  { id: "proposal", name: "제안/견적", color: "#a46bff" },
  { id: "negotiation", name: "협상", color: "#f5a524" },
  { id: "won", name: "수주", color: "#2fb164" },
  { id: "lost", name: "실주", color: "#e5484d" },
];

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "높음",
  mid: "보통",
  low: "낮음",
};

export const AVATAR_COLORS = [
  "#5b5bf7",
  "#00b8a9",
  "#f5a524",
  "#e5484d",
  "#a46bff",
  "#3b9eff",
  "#2fb164",
];

export const THEME_KEY = "crm.theme";

/** 미팅 노트 제한 (서버 검증·DB CHECK와 동일하게 유지) */
export const NOTE_BODY_MAX = 50000;
export const NOTE_TITLE_MAX = 200;
export const NOTE_SUMMARY_MAX = 5000;

/** 녹음: 5분 구간마다 전사, 최대 60분 */
export const RECORD_SEGMENT_SEC = 5 * 60;
export const RECORD_MAX_SEC = 60 * 60;
export const RECORD_WARN_SEC = 55 * 60;
/** 전사 업로드 1건 최대 크기 (Vercel 요청 본문 한도 4.5MB보다 작게) */
export const AUDIO_MAX_BYTES = 4 * 1024 * 1024;

export const NOTE_SOURCE_LABEL: Record<NoteSource, string> = {
  manual: "붙여넣기",
  recording: "녹음",
  mixed: "녹음+붙여넣기",
};

/** CRM이 구글 일정 설명에 붙이는 구분선 (앞부분 = 사용자 메모) */
export const CRM_DESCRIPTION_MARK = "— Pipeline CRM에서 등록";

/** CRM에서 만든 구글 캘린더 일정 제목 앞에 붙이는 표시 (DB에는 붙이지 않은 제목을 저장) */
export const CRM_TITLE_PREFIX = "[AI CRM]";
/** 제목에서 CRM 표시를 뗀다 */
export const stripCrmPrefix = (title: string) =>
  title.startsWith(CRM_TITLE_PREFIX) ? title.slice(CRM_TITLE_PREFIX.length).trim() : title;
