import "server-only";
import { PRIORITY_LABEL, STAGES } from "./constants";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "./db";
import type { LeadEvent } from "./events";
import type { ChatMessage } from "./types";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// 빠르고 저렴한 기본 모델. OPENAI_MODEL 환경 변수로 변경 가능
const DEFAULT_MODEL = "gpt-6-luna";
// 컨텍스트에 넣을 최근 이력 개수 상한 (토큰 비용 제한)
const MAX_EVENTS = 500;
const TIME_ZONE = "Asia/Seoul";

export class AssistantError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const stageName = (id: unknown) => STAGES.find((s) => s.id === id)?.name ?? String(id);

// 'YYYY-MM-DD HH:mm' (한국 시간)
const kst = (d: Date | number) =>
  new Date(d).toLocaleString("sv-SE", { timeZone: TIME_ZONE }).slice(0, 16);

/** 단계 id를 한국어 이름으로 바꿔 모델이 읽기 쉽게 만든다 */
function readableChanges(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (k === "stage" && v && typeof v === "object" && "from" in v && "to" in v) {
      out[k] = { from: stageName(v.from), to: stageName(v.to) };
    } else if (k === "stage") {
      out[k] = stageName(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** DB에서 현재 리드 + 변경 이력을 읽어 모델 컨텍스트 문자열을 만든다 */
async function buildContext(): Promise<string> {
  const [leadsRes, eventsRes] = await Promise.all([
    pool.query<LeadRow>(`SELECT ${LEAD_COLUMNS} FROM leads ORDER BY position`),
    pool.query<LeadEvent>(
      `SELECT lead_id AS "leadId", company, type, changes, created_at AS "createdAt"
       FROM lead_events ORDER BY created_at DESC, id DESC LIMIT $1`,
      [MAX_EVENTS]
    ),
  ]);

  // 이메일·전화번호는 외부 API로 보내지 않는다 (개인정보 최소화)
  const leads = leadsRes.rows.map(toLead).map((l) => ({
    id: l.id,
    company: l.company,
    contact: l.contact,
    title: l.title,
    value: l.value,
    closeDate: l.closeDate || null,
    stage: stageName(l.stage),
    priority: PRIORITY_LABEL[l.priority],
    notes: l.notes,
    createdAt: kst(l.createdAt),
  }));

  const events = eventsRes.rows.reverse().map((e) => ({
    at: kst(new Date(e.createdAt)),
    leadId: e.leadId,
    company: e.company,
    type: e.type,
    changes: readableChanges(e.changes),
  }));

  return JSON.stringify({ leads, events });
}

function systemPrompt(context: string): string {
  return `당신은 Pipeline CRM의 AI Assistant입니다. 영업 담당자의 리드 관련 질문에 한국어로 간결하게 답합니다.

규칙:
- 아래 CRM 데이터만 근거로 답하세요. 데이터에 없는 내용은 추측하지 말고 "기록이 없습니다"라고 답하세요.
- 시간은 한국 시간(KST) 기준입니다. 현재 시각: ${kst(Date.now())}
- 금액은 원화(₩)이며 천 단위 구분 기호를 붙이세요.
- 단계 흐름: ${STAGES.map((s) => s.name).join(" → ")}. 파이프라인 금액은 수주·실주를 제외한 리드 금액 합계입니다.
- events는 리드 변경 이력입니다. type: created(생성), updated(필드 수정, changes에 {from,to}), moved(단계 이동), deleted(삭제).
  changes.backfilled=true인 created 이벤트는 이력 기능 도입 전 리드로, 생성 시각만 정확하고 그 이전 변경 내역은 없습니다.
- 이력은 최근 ${MAX_EVENTS}건까지만 포함됩니다.
- 당신은 데이터를 조회만 할 수 있습니다. 수정·삭제 요청에는 보드에서 직접 하도록 안내하세요.
- 답변은 짧은 문장이나 "- " 목록으로 작성하고, 마크다운 강조(**, #)는 쓰지 마세요 (일반 텍스트로 표시됩니다).

CRM 데이터(JSON):
${context}`;
}

/** 대화 내역을 받아 OpenAI로 답변을 생성한다 */
export async function askAssistant(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new AssistantError("OPENAI_API_KEY가 설정되지 않았습니다", 503);

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  // reasoning 모델은 "none"이 가장 빠름. reasoning 미지원 모델로 바꾸면 OPENAI_REASONING_EFFORT=off
  const effort = process.env.OPENAI_REASONING_EFFORT ?? "none";

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt(await buildContext()) }, ...messages],
      max_completion_tokens: 1200,
      ...(effort && effort !== "off" ? { reasoning_effort: effort } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e: unknown) => {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new AssistantError(timeout ? "AI 응답 시간이 초과되었습니다" : "OpenAI에 연결할 수 없습니다", 502);
  });

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("[assistant] OpenAI error", res.status, JSON.stringify(body).slice(0, 500));
    if (res.status === 401) throw new AssistantError("OpenAI API 키가 올바르지 않습니다", 502);
    if (res.status === 429) throw new AssistantError("OpenAI 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요", 429);
    throw new AssistantError("AI 답변을 생성하지 못했습니다", 502);
  }

  const content = extractContent(body);
  if (!content) throw new AssistantError("AI 답변이 비어 있습니다", 502);
  return content;
}

// 응답 형식: { choices: [{ message: { content } }] }
function extractContent(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("choices" in body) || !Array.isArray(body.choices)) return null;
  const msg: unknown = body.choices[0]?.message;
  if (!msg || typeof msg !== "object" || !("content" in msg) || typeof msg.content !== "string") return null;
  return msg.content.trim() || null;
}
