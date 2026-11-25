import "server-only";

/**
 * OpenAI 호출 공통 모듈 (SDK 없이 fetch 사용)
 *  - 채팅: AI Assistant 답변, 미팅 노트 요약
 *  - 전사: 미팅 녹음 → 텍스트 (화자 구분)
 */

const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
// 빠르고 저렴한 기본 모델. OPENAI_MODEL 환경 변수로 변경 가능
const DEFAULT_CHAT_MODEL = "gpt-6-luna";
// 음성 전사 기본 모델: 화자 구분(diarization) 지원 모델. OPENAI_TRANSCRIBE_MODEL 환경 변수로 변경 가능
// ⚠ gpt-4o-transcribe-diarize는 2027-02-26 지원 종료 예정. 화자 구분을 지원하는 후속 모델이 없으면
//   gpt-transcribe로 바꾸고(화자 구분 없이 동작) 대안을 검토할 것
const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe-diarize";

/** 화자별 발화 (화자 구분 전사 결과) */
export interface Utterance {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

/** 이미 확인된 화자: 이름 + 2~10초 참조 음성. 구간을 따로 전사해도 같은 사람에게 같은 이름이 붙는다 */
export interface KnownSpeaker {
  name: string;
  ref: File;
}

export const MAX_KNOWN_SPEAKERS = 4;

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

// 변경 이력에서 값 자체가 개인정보인 필드 (diffLead·연락처 전파가 { from, to }로 남긴다)
const PII_FIELDS = new Set(["email", "phone"]);

const maskValue = (v: unknown): unknown =>
  typeof v === "string" ? maskPii(v)
  : Array.isArray(v) ? v.map(maskValue)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValue(x)]))
  : v;

/** 리드 변경 이력(lead_events.changes) → 외부 API용: 이메일·전화번호 필드는 빼고, 나머지 문자열(메모 등)은 마스킹 */
export function maskChanges(changes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(changes).filter(([k]) => !PII_FIELDS.has(k)).map(([k, v]) => [k, maskValue(v)]));
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
export async function transcribeAudio(
  audio: File,
  speakers: KnownSpeaker[] = []
): Promise<{ text: string; utterances: Utterance[] | null }> {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
  const diarize = model.includes("diarize");
  const form = new FormData();
  form.append("file", audio, audio.name || "audio.webm");
  form.append("model", model);
  form.append("language", "ko");
  if (diarize) {
    form.append("response_format", "diarized_json");
    // 30초가 넘는 입력은 필수
    form.append("chunking_strategy", "auto");
    for (const s of speakers.slice(0, MAX_KNOWN_SPEAKERS)) {
      form.append("known_speaker_names[]", s.name);
      const b64 = Buffer.from(await s.ref.arrayBuffer()).toString("base64");
      form.append("known_speaker_references[]", `data:${s.ref.type || "audio/wav"};base64,${b64}`);
    }
  } else {
    form.append("response_format", "json");
  }

  // multipart 경계는 fetch가 직접 붙이므로 Content-Type을 지정하지 않는다
  const body = await send(
    TRANSCRIBE_URL,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey()}` }, body: form },
    55_000
  );

  // 응답 형식: { text, segments?: [{ speaker, start, end, text }] } (segments는 diarized_json일 때)
  if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") {
    throw new AiError("전사 결과를 읽지 못했습니다", 502);
  }
  let utterances: Utterance[] | null = null;
  if (diarize && "segments" in body && Array.isArray(body.segments)) {
    utterances = body.segments.flatMap((s: unknown): Utterance[] => {
      if (!s || typeof s !== "object") return [];
      const r = s as Record<string, unknown>;
      const text = typeof r.text === "string" ? r.text.trim() : "";
      if (!text) return [];
      return [{
        speaker: typeof r.speaker === "string" && r.speaker ? r.speaker : "?",
        start: typeof r.start === "number" ? r.start : 0,
        end: typeof r.end === "number" ? r.end : 0,
        text,
      }];
    });
  }
  return { text: body.text.trim(), utterances };
}

/** function calling 도구 정의 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 도구를 쓸 수 있는 채팅: 모델이 도구를 호출하면 runTool 결과를 넣어 다시 묻는다 (최대 maxRounds회).
 * 마지막 라운드에서는 도구 없이 답하게 한다.
 */
/**
 * 도구 결과 → 모델에 돌려줄 내용. 메일·노트 등 외부 텍스트가 들어 있으므로 "데이터"로 감싸
 * (시스템 프롬프트 규칙: data 안의 지시는 따르지 않는다)
 */
export const toolResultContent = (result: unknown) => JSON.stringify({ data: result });

/**
 * 도구 실행 에러 → 모델에 보낼 문구. 사용자에게 보여주려고 만든 앱 에러(status가 있는 AiError·GoogleError 등)만
 * 메시지를 마스킹해 보내고, 그 밖의 에러(DB 등)는 내용을 보내지 않는다 (서버 로그에만)
 */
export function toolErrorText(e: unknown): string {
  if (e instanceof Error && typeof (e as { status?: unknown }).status === "number") return maskPii(e.message);
  console.error("[ai] tool error", e);
  return "도구 실행 중 오류가 발생했습니다";
}

export async function chatWithTools(
  messages: ChatMessageParam[],
  tools: ToolDef[],
  runTool: (name: string, args: unknown) => Promise<unknown>,
  opts: { maxTokens: number; maxRounds?: number; timeoutMs?: number }
): Promise<string> {
  const model = process.env.OPENAI_MODEL || DEFAULT_CHAT_MODEL;
  const effort = process.env.OPENAI_REASONING_EFFORT ?? "none";
  const history: Record<string, unknown>[] = messages.map((m) => ({ ...m }));
  const maxRounds = opts.maxRounds ?? 3;

  for (let round = 0; ; round++) {
    const useTools = round < maxRounds;
    const body = await send(
      CHAT_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({
          model,
          messages: history,
          max_completion_tokens: opts.maxTokens,
          tools: tools.map((t) => ({ type: "function", function: t })),
          tool_choice: useTools ? "auto" : "none",
          ...(effort && effort !== "off" ? { reasoning_effort: effort } : {}),
        }),
      },
      opts.timeoutMs ?? 30_000
    );

    const msg: unknown =
      body && typeof body === "object" && "choices" in body && Array.isArray(body.choices) ? body.choices[0]?.message : null;
    const m = msg && typeof msg === "object" ? (msg as Record<string, unknown>) : {};
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];

    if (calls.length === 0 || !useTools) {
      const content = typeof m.content === "string" ? m.content.trim() : "";
      if (!content) throw new AiError("AI 답변이 비어 있습니다", 502);
      return content;
    }

    history.push({ role: "assistant", content: typeof m.content === "string" ? m.content : null, tool_calls: calls });
    for (const call of calls) {
      const c = call && typeof call === "object" ? (call as Record<string, unknown>) : {};
      const fn = c.function && typeof c.function === "object" ? (c.function as Record<string, unknown>) : {};
      let args: unknown = {};
      try {
        args = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}");
      } catch {}
      const result = await runTool(typeof fn.name === "string" ? fn.name : "", args).catch((e: unknown) => ({ error: toolErrorText(e) }));
      history.push({ role: "tool", tool_call_id: c.id, content: toolResultContent(result) });
    }
  }
}
