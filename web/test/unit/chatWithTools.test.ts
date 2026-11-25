import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError, chatWithTools, type ToolDef } from "@/lib/openai";

/** OpenAI 응답을 차례로 흉내 (요청 본문은 calls로 확인) */
function fakeOpenAi(replies: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const message = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }));
  return calls;
}
const toolCall = (id: string, name: string, args: unknown) => ({
  content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const TOOLS: ToolDef[] = [{ name: "search_leads", description: "", parameters: { type: "object", properties: {} } }];

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
});
afterEach(() => vi.unstubAllGlobals());

describe("chatWithTools (function calling 루프)", () => {
  it("도구 호출 → 결과를 data로 감싸 다시 보내고 → 최종 답변", async () => {
    const calls = fakeOpenAi([toolCall("c1", "search_leads", { query: "에이스" }), { content: "에이스상사 리드 1건입니다" }]);
    const runTool = vi.fn(async () => ({ count: 1 }));
    const reply = await chatWithTools([{ role: "user", content: "에이스 리드?" }], TOOLS, runTool, { maxTokens: 100 });

    expect(reply).toBe("에이스상사 리드 1건입니다");
    expect(runTool).toHaveBeenCalledWith("search_leads", { query: "에이스" });
    const history = calls[1].messages as { role: string; content: string | null; tool_call_id?: string }[];
    expect(history.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: JSON.stringify({ data: { count: 1 } }) });
  });

  it("마지막 라운드는 도구 없이(tool_choice: none) 답하게 한다", async () => {
    const calls = fakeOpenAi([toolCall("c1", "search_leads", {}), toolCall("c2", "search_leads", {}), { content: "끝" }]);
    await chatWithTools([{ role: "user", content: "?" }], TOOLS, async () => ({}), { maxTokens: 100, maxRounds: 2 });
    expect(calls.map((c) => c.tool_choice)).toEqual(["auto", "auto", "none"]);
  });

  it("도구 오류: 앱 오류는 마스킹한 메시지, 그 밖의 오류는 일반 문구만 모델에 보낸다", async () => {
    const calls = fakeOpenAi([
      { content: null, tool_calls: [
        { id: "a", type: "function", function: { name: "search_leads", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "search_leads", arguments: "{깨진 json" } },
      ] },
      { content: "확인했습니다" },
    ]);
    let n = 0;
    const runTool = vi.fn(async (_name: string, args: unknown) => {
      n++;
      if (n === 1) throw new AiError("kim@a.com 조회 실패", 502);
      expect(args).toEqual({}); // 깨진 인자는 빈 객체로
      throw new Error("password authentication failed for user crm_app");
    });
    await chatWithTools([{ role: "user", content: "?" }], TOOLS, runTool, { maxTokens: 100 });
    const tools = (calls[1].messages as { role: string; content: string }[]).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
    expect(tools).toEqual([{ data: { error: "[이메일] 조회 실패" } }, { data: { error: "도구 실행 중 오류가 발생했습니다" } }]);
  });
});
