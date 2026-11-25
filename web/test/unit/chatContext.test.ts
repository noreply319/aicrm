import { describe, expect, it } from "vitest";
import { focusText, HISTORY_MAX_CHARS, keywords, RECENT_MESSAGES, selectHistory } from "@/lib/chatContext";
import type { ChatMessage } from "@/lib/types";

/** n번째 질문·답변 쌍 */
const turn = (q: string, a: string): ChatMessage[] => [{ role: "user", content: q }, { role: "assistant", content: a }];
const filler = (n: number) => Array.from({ length: n }, (_, i) => turn(`일반 질문 ${i}`, `일반 답변 ${i}`)).flat();

describe("selectHistory", () => {
  it("짧은 대화는 전부 + 이번 질문", () => {
    const h = turn("파이프라인 합계는?", "₩0입니다");
    expect(selectHistory(h, "이번 주는?")).toEqual([...h, { role: "user", content: "이번 주는?" }]);
  });

  it("긴 대화: 최근 메시지 + 이번 질문과 관련된 이전 대화만, 시간 순서 유지", () => {
    const ocean = turn("오션핀테크 리드 금액은?", "오션핀테크는 5천만 원입니다");
    const ace = turn("에이스상사 단계는?", "에이스상사는 협상입니다");
    const history = [...ace, ...ocean, ...filler(10)];
    const out = selectHistory(history, "오션핀테크의 다음 미팅은?");
    expect(out.slice(0, 2)).toEqual(ocean); // 관련 이전 대화 (조사 '의'가 붙어도 찾는다)
    expect(out).not.toContainEqual(ace[0]); // 관련 없는 이전 대화는 뺀다
    expect(out.slice(2, -1)).toEqual(history.slice(-RECENT_MESSAGES));
    expect(out.at(-1)).toEqual({ role: "user", content: "오션핀테크의 다음 미팅은?" });
  });

  it("글자 수 상한을 넘으면 오래된 것부터 빼고, 질문부터 시작한다", () => {
    const big = "가".repeat(HISTORY_MAX_CHARS / 4);
    const history = [...turn("q1", big), ...turn("q2", big), ...turn("q3", big)];
    const out = selectHistory(history, "q4");
    expect(out.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(out[0].role).toBe("user");
    expect(out.at(-1)?.content).toBe("q4");
  });
});

describe("keywords·focusText", () => {
  it("흔한 말·한 글자는 빼고, 조사를 뗀 형태도 포함", () => {
    expect(keywords("오션핀테크의 리드 알려줘")).toEqual(expect.arrayContaining(["오션핀테크의", "오션핀테크"]));
    expect(keywords("리드 알려줘 a")).toEqual([]);
  });

  it("관련 기록을 찾을 글은 최근 질문 3개", () => {
    const msgs = [...turn("1", "a"), ...turn("2", "b"), ...turn("3", "c"), { role: "user" as const, content: "4" }];
    expect(focusText(msgs)).toBe("2\n3\n4");
  });
});
