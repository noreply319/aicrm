import "server-only";
import { NOTE_SUMMARY_MAX } from "./constants";
import { chatCompletion, AiError, maskPii } from "./openai";
import type { MeetingNote, MeetingNoteInput, MeetingNoteSummary, NoteSummaryResult } from "./types";

const PREVIEW_CHARS = 200;

const BASE_COLUMNS = `
  id, lead_id AS "leadId", title, met_at AS "metAt", source,
  summary, next_actions AS "nextActions", created_at AS "createdAt", updated_at AS "updatedAt"`;

/** 목록용 컬럼: 본문 대신 앞부분 미리보기 */
export const NOTE_SUMMARY_COLUMNS = `${BASE_COLUMNS}, left(body, ${PREVIEW_CHARS}) AS preview`;
/** 상세용 컬럼: 본문 전체 */
export const NOTE_COLUMNS = `${BASE_COLUMNS}, body`;

type DateFields = "metAt" | "createdAt" | "updatedAt";
export type NoteRow = Omit<MeetingNote, DateFields> & Record<DateFields, Date>;
export type NoteSummaryRow = Omit<MeetingNoteSummary, DateFields> & Record<DateFields, Date>;

const iso = <T extends Record<DateFields, Date>>(r: T) => ({
  ...r,
  metAt: r.metAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toNote = (r: NoteRow): MeetingNote => iso(r);
export const toNoteSummary = (r: NoteSummaryRow): MeetingNoteSummary => iso(r);

// 이력에 남길 비교 대상 필드 (본문은 길어서 변경 여부만 기록)
const TRACKED = ["title", "metAt", "source", "leadId"] as const;

/** 노트 수정 전/후 비교 → lead_events.changes */
export function diffNote(before: MeetingNote, after: MeetingNoteInput): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const f of TRACKED) {
    if (before[f] !== after[f]) changes[f] = { from: before[f], to: after[f] };
  }
  if (before.body !== after.body) changes.body = "changed";
  if (before.summary !== after.summary || before.nextActions !== after.nextActions) changes.summary = "changed";
  return changes;
}

/** 노트 이벤트 스냅샷: 본문은 넣지 않는다 */
export const noteSnapshot = (n: Pick<MeetingNote, "id" | "title" | "metAt" | "source">) => ({
  noteId: n.id, title: n.title, metAt: n.metAt, source: n.source,
});

const SUMMARY_PROMPT = `당신은 B2B 영업 담당자의 미팅 노트를 정리하는 비서입니다.
미팅 노트(회의록 또는 녹음 전사)를 읽고 한국어로 다음 JSON 객체만 출력하세요:
{"summary": string, "needs": string[], "nextActions": string[]}

- summary: 미팅 핵심 요약 3~5문장
- needs: 고객 니즈·이슈·우려 사항 (각 항목 한 줄, 최대 6개)
- nextActions: 우리 쪽이 해야 할 다음 액션 (각 항목 한 줄, 담당자나 기한이 언급되면 "— 11/26까지"처럼 포함, 최대 6개)
- 노트에 없는 내용은 만들지 마세요. 해당 내용이 없으면 빈 배열로 두세요.
- 전사 텍스트에는 오인식이 있을 수 있으니 문맥에 맞게 해석하세요.`;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];

/** 미팅 노트 본문 → 요약·다음 액션 */
export async function summarizeNote(title: string, body: string): Promise<NoteSummaryResult> {
  const content = await chatCompletion(
    [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: `제목: ${maskPii(title)}\n\n본문:\n${maskPii(body)}` },
    ],
    { maxTokens: 1500, json: true, timeoutMs: 45_000 }
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AiError("AI 요약 결과를 읽지 못했습니다", 502);
  }
  const r = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const summaryText = typeof r.summary === "string" ? r.summary.trim() : "";
  const needs = strings(r.needs);
  const actions = strings(r.nextActions);

  const summary = [summaryText, needs.length ? `고객 니즈/이슈\n${needs.map((n) => `- ${n}`).join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  if (!summary && actions.length === 0) throw new AiError("AI 요약 결과가 비어 있습니다", 502);

  return {
    summary: summary.slice(0, NOTE_SUMMARY_MAX),
    nextActions: actions.join("\n").slice(0, NOTE_SUMMARY_MAX),
  };
}
