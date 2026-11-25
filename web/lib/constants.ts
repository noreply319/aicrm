import type { CompanySize, CompanyTier, ContactRole, NoteSource, Priority, StageId } from "./types";

// 단계 색: 디자인 시스템 데이터 팔레트 (docs/design-system/design-system.html)
export const STAGES: { id: StageId; name: string; color: string }[] = [
  { id: "new", name: "신규 리드", color: "#7b8a84" },
  { id: "contacted", name: "첫 컨택", color: "#3574d6" },
  { id: "qualified", name: "니즈 확인", color: "#24a47f" },
  { id: "proposal", name: "제안/견적", color: "#7a6fd6" },
  { id: "negotiation", name: "협상", color: "#e5731f" },
  { id: "won", name: "수주", color: "#008561" },
  { id: "lost", name: "실주", color: "#d8372a" },
];

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "높음",
  mid: "보통",
  low: "낮음",
};

/** 우선순위 → Badge tone */
export const PRIORITY_TONE: Record<Priority, "danger" | "warning" | "success"> = {
  high: "danger",
  mid: "warning",
  low: "success",
};

export const AVATAR_COLORS = [
  "#008561",
  "#15372c",
  "#3574d6",
  "#e5731f",
  "#7a6fd6",
  "#24a47f",
  "#b5482e",
];

export const THEME_KEY = "crm.theme";
/** 왼쪽 메뉴 접힘("collapsed") · AI Assistant 열림("open"/"closed") 저장 키 */
export const SIDEBAR_KEY = "crm.sidebar";
export const ASSISTANT_KEY = "crm.assistant";
/** 이 너비 이하에서는 메뉴가 자동으로 아이콘 레일 (globals.css와 같게) */
export const SIDEBAR_AUTO_RAIL_QUERY = "(max-width: 1024px)";
/** 모바일 레이아웃(globals.css의 640px 이하): 햄버거 메뉴, AI 채팅 전체 화면 */
export const MOBILE_QUERY = "(max-width: 640px)";

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

/**
 * 개인 무료 메일 도메인: 리드 이메일이 이 도메인이면 "같은 회사 도메인" 메일 검색을 하지 않는다
 * (gmail.com 전체가 검색되는 것을 막기 위해)
 */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com", "nate.com",
  "hotmail.com", "outlook.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.kr", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com", "korea.com", "dreamwiz.com",
]);

// ───────── 회사 ─────────
/** 회사 규모(직원 수). 바꾸면 db/schema.sql의 companies.size CHECK도 함께 */
export const COMPANY_SIZES: CompanySize[] = ["1-10", "11-50", "51-200", "201-1000", "1000+"];
/** 회사 등급. 바꾸면 companies.tier CHECK도 함께 */
export const COMPANY_TIERS: CompanyTier[] = ["A", "B", "C"];
export const COMPANY_NAME_MAX = 100;
export const COMPANY_TAG_MAX = 10;
export const COMPANY_TAG_LEN = 20;
export const COMPANY_NOTES_MAX = 5000;
/** 리드 모달 회사 검색 결과 최대 개수 */
export const COMPANY_SEARCH_LIMIT = 8;

// ───────── 연락처 ─────────
/** 연락처 역할. 바꾸면 db/schema.sql의 contacts.role CHECK도 함께 */
export const CONTACT_ROLES: { id: ContactRole; label: string }[] = [
  { id: "decision_maker", label: "의사결정자" },
  { id: "influencer", label: "영향력자" },
  { id: "practitioner", label: "실무자" },
];
export const CONTACT_ROLE_LABEL = Object.fromEntries(CONTACT_ROLES.map((r) => [r.id, r.label])) as Record<ContactRole, string>;
export const CONTACT_NAME_MAX = 50;
export const CONTACT_NOTES_MAX = 5000;
/** 리드 모달 담당자 검색 결과 최대 개수 */
export const CONTACT_SEARCH_LIMIT = 8;
