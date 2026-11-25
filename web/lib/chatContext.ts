import type { ChatMessage } from "./types";

/**
 * AI에 보낼 대화 기록 고르기 (서버·테스트 공용 순수 함수).
 * 저장된 대화는 길어질 수 있으므로 전부 보내지 않는다:
 *  - 최근 RECENT_MESSAGES개는 항상 (이어지는 질문의 맥락)
 *  - 그 이전 대화에서는 이번 질문과 관련된(낱말이 겹치는) 질문·답변 쌍을 최대 RELATED_TURNS개
 *  - 전체 글자 수 상한을 넘으면 오래된 것부터 뺀다
 */

export const RECENT_MESSAGES = 12;
export const RELATED_TURNS = 3;
export const HISTORY_MAX_CHARS = 12_000;

/** 관련도 계산에서 뺄 흔한 말 */
const STOPWORDS = new Set([
  "알려줘", "보여줘", "해줘", "주세요", "있어", "없어", "어떻게", "얼마", "얼마야", "뭐야", "그리고", "지금", "이번", "다음",
  "리드", "회사", "연락처", "대해", "관련", "정리", "the", "and",
]);

/** 낱말 (2글자 이상, 소문자). 조사가 붙은 말도 찾도록 3글자 이상이면 끝 한 글자를 뗀 형태도 함께 */
export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(w);
    if (w.length >= 3) out.add(w.slice(0, -1));
  }
  return [...out];
}

/** 이번 질문 낱말이 text에 몇 개 나오는지 */
export function relevance(text: string, words: string[]): number {
  const t = text.toLowerCase();
  return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
}

/**
 * history(이번 질문 전까지, 오래된 순) → AI에 보낼 기록 + 이번 질문.
 * 고른 이전 대화는 시간 순서를 유지한다.
 */
export function selectHistory(history: ChatMessage[], question: string): ChatMessage[] {
  const recentStart = Math.max(0, history.length - RECENT_MESSAGES);
  const older = history.slice(0, recentStart);
  const recent = history.slice(recentStart);

  // 이전 대화를 질문·답변 쌍으로 묶어 관련도 순으로 고른다
  const words = keywords(question);
  const turns: { start: number; messages: ChatMessage[]; score: number }[] = [];
  for (let i = 0; i < older.length; i++) {
    if (older[i].role !== "user") continue;
    const pair = older[i + 1]?.role === "assistant" ? [older[i], older[i + 1]] : [older[i]];
    turns.push({ start: i, messages: pair, score: relevance(pair.map((m) => m.content).join("\n"), words) });
  }
  const related = turns
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || b.start - a.start)
    .slice(0, RELATED_TURNS)
    .sort((a, b) => a.start - b.start)
    .flatMap((t) => t.messages);

  // 글자 수 상한: 오래된 것부터 뺀다 (이번 질문은 항상 포함)
  const picked = [...related, ...recent];
  let total = question.length;
  const kept: ChatMessage[] = [];
  for (let i = picked.length - 1; i >= 0; i--) {
    total += picked[i].content.length;
    if (total > HISTORY_MAX_CHARS) break;
    kept.unshift(picked[i]);
  }
  // 답변으로 시작하면 앞의 질문이 잘린 것 → 빼서 질문부터 시작
  while (kept[0]?.role === "assistant") kept.shift();
  return [...kept, { role: "user", content: question }];
}

/** CRM 데이터에서 관련 기록을 찾을 때 볼 글: 이번 질문 + 최근 사용자 질문 몇 개 ("그 회사", "거기" 같은 이어지는 질문용) */
export function focusText(messages: ChatMessage[], recentQuestions = 3): string {
  return messages
    .filter((m) => m.role === "user")
    .slice(-recentQuestions)
    .map((m) => m.content)
    .join("\n");
}
