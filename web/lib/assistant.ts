import "server-only";
import { PRIORITY_LABEL, STAGES } from "./constants";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "./db";
import type { LeadEvent } from "./events";
import { chatCompletion, maskPii } from "./openai";
import type { ChatMessage } from "./types";

export { AiError as AssistantError } from "./openai";

// 컨텍스트에 넣을 최근 이력 개수 상한 (토큰 비용 제한)
const MAX_EVENTS = 500;
// 미팅 노트: 최근 N건, 질문에 언급된 리드의 노트만 본문 포함 (토큰 비용 제한)
const MAX_NOTES = 100;
const NOTE_BODY_CHARS = 4000;
const NOTE_BODY_TOTAL_CHARS = 40000;
const TIME_ZONE = "Asia/Seoul";

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

interface NoteContextRow {
  leadId: string | null;
  company: string | null;
  title: string;
  metAt: Date;
  source: string;
  summary: string;
  nextActions: string;
  body: string;
}

/**
 * DB에서 현재 리드 + 변경 이력 + 미팅 노트를 읽어 모델 컨텍스트 문자열을 만든다.
 * question에 회사명이 언급된 리드의 노트는 본문까지 넣는다.
 */
async function buildContext(question: string): Promise<string> {
  const [leadsRes, eventsRes, notesRes] = await Promise.all([
    pool.query<LeadRow>(`SELECT ${LEAD_COLUMNS} FROM leads ORDER BY position`),
    pool.query<LeadEvent>(
      `SELECT lead_id AS "leadId", company, type, changes, created_at AS "createdAt"
       FROM lead_events ORDER BY created_at DESC, id DESC LIMIT $1`,
      [MAX_EVENTS]
    ),
    pool.query<NoteContextRow>(
      `SELECT m.lead_id AS "leadId", l.company, m.title, m.met_at AS "metAt", m.source,
              m.summary, m.next_actions AS "nextActions", m.body
       FROM meeting_notes m LEFT JOIN leads l ON l.id = m.lead_id
       ORDER BY m.met_at DESC LIMIT $1`,
      [MAX_NOTES]
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
    notes: maskPii(l.notes),
    createdAt: kst(l.createdAt),
  }));

  const events = eventsRes.rows.reverse().map((e) => ({
    at: kst(new Date(e.createdAt)),
    leadId: e.leadId,
    company: e.company,
    type: e.type,
    changes: readableChanges(e.changes),
  }));

  // 질문에 회사명이 나온 리드의 노트는 본문 포함, 나머지는 요약(없으면 본문 앞부분)만
  const q = question.toLowerCase();
  let bodyBudget = NOTE_BODY_TOTAL_CHARS;
  const meetingNotes = notesRes.rows.map((n) => {
    const mentioned = n.company !== null && q.includes(n.company.toLowerCase());
    const bodyText = mentioned && bodyBudget > 0 ? n.body.slice(0, Math.min(NOTE_BODY_CHARS, bodyBudget)) : "";
    bodyBudget -= bodyText.length;
    return {
      leadId: n.leadId,
      company: n.company ?? "(리드 미지정)",
      title: maskPii(n.title),
      metAt: kst(n.metAt),
      source: n.source,
      summary: maskPii(n.summary) || null,
      nextActions: maskPii(n.nextActions) || null,
      ...(bodyText
        ? { body: maskPii(bodyText) }
        : n.summary ? {} : { bodyPreview: maskPii(n.body.slice(0, 300)) }),
    };
  });

  return JSON.stringify({ leads, events, meetingNotes });
}

function systemPrompt(context: string): string {
  return `당신은 Pipeline CRM의 AI Assistant입니다. 영업 담당자의 리드 관련 질문에 한국어로 간결하게 답합니다.

규칙:
- 아래 CRM 데이터만 근거로 답하세요. 데이터에 없는 내용은 추측하지 말고 "기록이 없습니다"라고 답하세요.
- 시간은 한국 시간(KST) 기준입니다. 현재 시각: ${kst(Date.now())}
- 금액은 원화(₩)이며 천 단위 구분 기호를 붙이세요.
- 단계 흐름: ${STAGES.map((s) => s.name).join(" → ")}. 파이프라인 금액은 수주·실주를 제외한 리드 금액 합계입니다.
- events는 리드 변경 이력입니다. type: created(생성), updated(필드 수정, changes에 {from,to}), moved(단계 이동), deleted(삭제),
  note_created/note_updated/note_deleted(미팅 노트 작성/수정/삭제).
- meetingNotes는 리드별 미팅 노트입니다(최근 ${MAX_NOTES}건, 미팅 일시 최신순). summary(요약·고객 니즈), nextActions(다음 액션)를 우선 참고하세요.
  company가 "(리드 미지정)"인 노트는 아직 리드에 연결되지 않은 노트입니다.
  body는 질문에 회사명이 언급된 리드의 노트에만 포함됩니다. 노트를 근거로 답할 때는 "(출처: 노트 제목, 미팅 일시)"를 붙이세요.
  본문은 녹음 전사일 수 있어 오인식이 있을 수 있습니다.
  changes.backfilled=true인 created 이벤트는 이력 기능 도입 전 리드로, 생성 시각만 정확하고 그 이전 변경 내역은 없습니다.
- 이력은 최근 ${MAX_EVENTS}건까지만 포함됩니다.
- 당신은 데이터를 조회만 할 수 있습니다. 수정·삭제 요청에는 보드에서 직접 하도록 안내하세요.
- 답변은 짧은 문장이나 "- " 목록으로 작성하고, 마크다운 강조(**, #)는 쓰지 마세요 (일반 텍스트로 표시됩니다).

CRM 데이터(JSON):
${context}`;
}

/** 대화 내역을 받아 OpenAI로 답변을 생성한다 */
export async function askAssistant(messages: ChatMessage[]): Promise<string> {
  const question = messages.at(-1)?.content ?? "";
  const context = await buildContext(question);
  return chatCompletion(
    [{ role: "system", content: systemPrompt(context) }, ...messages.map((m) => ({ ...m, content: maskPii(m.content) }))],
    { maxTokens: 1200 }
  );
}
