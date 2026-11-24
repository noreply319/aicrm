import "server-only";

/**
 * OpenAI 호출 공통 모듈 (SDK 없이 fetch 사용)
 *  - 채팅: AI Assistant 답변, 미팅 노트 요약
 *  - 전사: 미팅 녹음 → 텍스트 (GPT transcribe)
 */

const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
// 빠르고 저렴한 기본 모델. OPENAI_MODEL 환경 변수로 변경 가능
const DEFAULT_CHAT_MODEL = "gpt-6-luna";
// 음성 전사 기본 모델. OPENAI_TRANSCRIBE_MODEL 환경 변수로 변경 가능
const DEFAULT_TRANSCRIBE_MODEL = "gpt-transcribe";

/** 사용자에게 보여줄 한국어 메시지 + HTTP 상태 코드 */
export class AiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 국내 휴대폰·유선 번호 (010-1234-5678, 02 123 4567, 01012345678 등)
const PHONE_RE = /(?<!\d)(?:\+?82[-\s.]?)?0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)/g;

/** 이메일·전화번호는 외부 API로 보내지 않는다 (개인정보 최소화) */
export function maskPii(text: string): string {
  return text.replace(EMAIL_RE, "[이메일]").replace(PHONE_RE, "[전화번호]");
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new AiError("OPENAI_API_KEY가 설정되지 않았습니다", 503);
  return key;
}

async function send(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch((e: unknown) => {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new AiError(timeout ? "AI 응답 시간이 초과되었습니다" : "OpenAI에 연결할 수 없습니다", 502);
  });

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("[openai] error", res.status, JSON.stringify(body).slice(0, 500));
    if (res.status === 401) throw new AiError("OpenAI API 키가 올바르지 않습니다", 502);
    if (res.status === 429) throw new AiError("OpenAI 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요", 429);
    throw new AiError("AI 요청을 처리하지 못했습니다", 502);
  }
  return body;
}

export type ChatMessageParam = { role: "system" | "user" | "assistant"; content: string };

/** 채팅 완성 호출. json=true면 JSON 객체 응답을 강제한다. */
export async function chatCompletion(
  messages: ChatMessageParam[],
  opts: { maxTokens: number; json?: boolean; timeoutMs?: number }
): Promise<string> {
  const model = process.env.OPENAI_MODEL || DEFAULT_CHAT_MODEL;
  // reasoning 모델은 "none"이 가장 빠름. reasoning 미지원 모델로 바꾸면 OPENAI_REASONING_EFFORT=off
  const effort = process.env.OPENAI_REASONING_EFFORT ?? "none";

  const body = await send(
    CHAT_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: opts.maxTokens,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        ...(effort && effort !== "off" ? { reasoning_effort: effort } : {}),
      }),
    },
    opts.timeoutMs ?? 30_000
  );

  const content = extractChatContent(body);
  if (!content) throw new AiError("AI 답변이 비어 있습니다", 502);
  return content;
}

// 응답 형식: { choices: [{ message: { content } }] }
function extractChatContent(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("choices" in body) || !Array.isArray(body.choices)) return null;
  const msg: unknown = body.choices[0]?.message;
  if (!msg || typeof msg !== "object" || !("content" in msg) || typeof msg.content !== "string") return null;
  return msg.content.trim() || null;
}

/** 음성 파일 1개를 한국어 텍스트로 전사한다 */
export async function transcribeAudio(audio: File): Promise<string> {
  const form = new FormData();
  form.append("file", audio, audio.name || "audio.webm");
  form.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL);
  form.append("language", "ko");
  form.append("response_format", "json");

  // multipart 경계는 fetch가 직접 붙이므로 Content-Type을 지정하지 않는다
  const body = await send(
    TRANSCRIBE_URL,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey()}` }, body: form },
    55_000
  );

  // 응답 형식: { text }
  if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") {
    throw new AiError("전사 결과를 읽지 못했습니다", 502);
  }
  return body.text.trim();
}
