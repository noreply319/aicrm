import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeNote } from "@/lib/meetings";
import { AiError, chatCompletion, maskPii, transcribeAudio } from "@/lib/openai";

/** OpenAI 응답 흉내 */
const respond = (status: number, body: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.OPENAI_TRANSCRIBE_MODEL;
});
afterEach(() => vi.unstubAllGlobals());

describe("maskPii (외부 API로 보내기 전 개인정보 가리기)", () => {
  it("이메일과 국내 전화번호를 가린다", () => {
    expect(maskPii("연락처 kim.min@corp.co.kr / 010-1234-5678 / 02 123 4567 / 01098765432")).toBe(
      "연락처 [이메일] / [전화번호] / [전화번호] / [전화번호]"
    );
  });

  it("금액·날짜 같은 숫자는 그대로 둔다", () => {
    expect(maskPii("50석, 45,000,000원, 2026-12-31 마감")).toBe("50석, 45,000,000원, 2026-12-31 마감");
  });
});

describe("chatCompletion 오류 처리", () => {
  it("키가 없으면 503", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(chatCompletion([], { maxTokens: 10 })).rejects.toMatchObject({ status: 503 });
  });

  it("401은 키 오류, 429는 한도 초과로 바꿔 알린다", async () => {
    vi.stubGlobal("fetch", respond(401, { error: {} }));
    await expect(chatCompletion([], { maxTokens: 10 })).rejects.toMatchObject({
      status: 502,
      message: "OpenAI API 키가 올바르지 않습니다",
    });
    vi.stubGlobal("fetch", respond(429, { error: {} }));
    await expect(chatCompletion([], { maxTokens: 10 })).rejects.toMatchObject({ status: 429 });
  });
});

describe("summarizeNote", () => {
  it("요약·니즈·다음 액션 JSON을 텍스트로 정리하고, 보낼 때 개인정보를 가린다", async () => {
    const fetchMock = respond(200, {
      choices: [{ message: { content: JSON.stringify({
        summary: "50석 견적 요청.",
        needs: ["보안 심사 서류"],
        nextActions: ["견적서 발송 — 11/26까지", "  "],
      }) } }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await summarizeNote("한빛 미팅", "담당자 kim@a.com 010-1111-2222 견적 요청");
    expect(r).toEqual({
      summary: "50석 견적 요청.\n\n고객 니즈/이슈\n- 보안 심사 서류",
      nextActions: "견적서 발송 — 11/26까지",
    });
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[1].content).not.toMatch(/kim@a\.com|010-1111-2222/);
  });

  it("JSON이 아니면 AiError", async () => {
    vi.stubGlobal("fetch", respond(200, { choices: [{ message: { content: "요약입니다" } }] }));
    await expect(summarizeNote("t", "b")).rejects.toBeInstanceOf(AiError);
  });
});

describe("transcribeAudio (화자 구분 전사)", () => {
  const audio = () => new File([new Uint8Array([1, 2, 3])], "seg.webm", { type: "audio/webm" });

  it("diarize 모델: diarized_json·chunking_strategy·참조 화자를 보내고 발화 목록을 돌려준다", async () => {
    const fetchMock = respond(200, {
      text: "안녕하세요 네",
      segments: [
        { speaker: "화자 1", start: 0, end: 1.2, text: " 안녕하세요 " },
        { speaker: "A", start: 1.5, end: 2, text: "네" },
        { speaker: "B", start: 2, end: 2.1, text: "   " },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const ref = new File([new Uint8Array([9])], "ref.wav", { type: "audio/wav" });
    const r = await transcribeAudio(audio(), [{ name: "화자 1", ref }]);

    expect(r.utterances).toEqual([
      { speaker: "화자 1", start: 0, end: 1.2, text: "안녕하세요" },
      { speaker: "A", start: 1.5, end: 2, text: "네" },
    ]);
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(form.get("response_format")).toBe("diarized_json");
    expect(form.get("chunking_strategy")).toBe("auto");
    expect(form.getAll("known_speaker_names[]")).toEqual(["화자 1"]);
    expect(String(form.get("known_speaker_references[]"))).toMatch(/^data:audio\/wav;base64,/);
  });

  it("diarize가 아닌 모델로 바꾸면 화자 구분 없이 텍스트만 돌려준다", async () => {
    process.env.OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";
    const fetchMock = respond(200, { text: " 안녕하세요 " });
    vi.stubGlobal("fetch", fetchMock);
    const r = await transcribeAudio(audio());
    expect(r).toEqual({ text: "안녕하세요", utterances: null });
    expect((fetchMock.mock.calls[0][1]?.body as FormData).get("response_format")).toBe("json");
  });
});
