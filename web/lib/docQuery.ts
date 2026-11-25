import type { DocKind } from "./types";

/**
 * 문서 탭(AI Assistant) 대화에서 "작성한 문서를 보여 달라"는 요청 읽기 (클라이언트·테스트 공용 순수 함수).
 * 예: "작성한 문서 보여줘", "견적서 목록", "엔에스 계약서 찾아줘", "최근 견적서"
 * "견적서"처럼 종류만 말하면 새 문서 템플릿 고르기로 두고(null), 목록을 원하는 말이 있을 때만 목록으로 본다.
 */
export interface DocListQuery {
  kind: DocKind | null;
  /** 회사명·문서 제목에서 찾을 말 (없으면 전체) */
  q: string;
}

/** 목록을 원하는 말 ("작성"만으로는 새로 작성하려는 뜻일 수 있어 "작성한"부터) */
const LIST_INTENT = /(작성한|작성했던|만든|만들었던|최근|지난|이전|목록|리스트|불러|찾아|찾기|열어|보여|있는|있어|뭐\s*있)/;

/** 검색어에서 뺄 말 (요청·종류를 나타내는 말과 조사) */
const NOISE = new Set([
  "작성한", "작성했던", "만든", "만들었던", "최근", "지난", "이전", "목록", "리스트", "문서", "문서들", "전체", "모든", "모두",
  "견적서", "견적", "계약서", "계약", "보여줘", "보여주세요", "보여", "불러와", "불러와줘", "불러줘", "찾아줘", "찾아", "찾기",
  "열어줘", "열어", "있는", "있어", "있어?", "뭐", "뭐있어", "주세요", "줘", "좀", "의", "중", "것", "거",
]);

export function docListQuery(text: string): DocListQuery | null {
  const t = text.trim();
  if (!t || !LIST_INTENT.test(t)) return null;
  const kind: DocKind | null = /견적|인보이스|invoice/i.test(t) ? "quote" : /계약/.test(t) ? "contract" : null;
  const words = t
    .replace(/[?!.,]/g, " ")
    .split(/\s+/)
    // 조사가 붙은 말("엔에스의", "견적서를")은 끝 조사를 뗀다
    .map((w) => w.replace(/(의|을|를|은|는|이|가|에|로|으로|들)$/u, ""))
    .filter((w) => w.length >= 2 && !NOISE.has(w) && !/^(견적|계약)/.test(w));
  return { kind, q: words.join(" ") };
}
