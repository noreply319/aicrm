import "server-only";
import type { PoolClient } from "pg";
import { STAGES } from "./constants";
import { pool } from "./db";
import {
  cleanItem, computeTotals, deriveEndDate, displayValue, formatNumber, hasItemsTable, ITEM_LIMITS, ITEMS_KEY, KIND_LABEL,
  leadValue, lineAmount, missingRequired, normalizeStored, parseAmount, parseDate, parseFieldValue, questionFor, todayKst,
} from "./docTemplate";
import { getDocument, nextDocNumber, publicDocument, saveState, stateOf, type DocState, type LoadedDocument } from "./documents";
import { recordEvent, withTransaction } from "./events";
import { AiError, chatCompletion, maskPii } from "./openai";
import type {
  DocAction, DocChatResult, DocKind, DocMessage, DocTemplate, Lead, LineItem, QuickReply, StageId, TemplateField,
} from "./types";
import { isStage, UUID_RE } from "./validate";

/**
 * 문서 작성 Assistant
 *  - 다음 질문은 서버가 정한다: 리드 → (견적서) 품목 → 비어 있는 항목을 질문 순서대로 하나씩 → 완성
 *  - 답변은 먼저 규칙으로 해석(날짜·금액·기간·선택지·이메일·전화번호)하고, 안 되면 AI로 해석한다.
 *  - AI에는 항목 이름·유형·보기, 품목 목록, 사용자의 이번 답변(이메일·전화번호 가림)만 보낸다.
 *    문서 본문·다른 항목 값·리드 연락처는 보내지 않는다. 이메일·전화번호 항목은 AI로 해석하지 않는다.
 */

export class DocError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Route Handler 공통: 문서·AI 에러 → { error } 응답, 그 외 예외는 다시 던진다 */
export function docErrorResponse(e: unknown): Response {
  if (e instanceof DocError || e instanceof AiError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}

type DocShape = Pick<LoadedDocument, "kind" | "body" | "fields" | "lineItemsConfig" | "status">;

const now = () => new Date().toISOString();
const say = (s: DocState, text: string, extra: Partial<DocMessage> = {}) =>
  s.messages.push({ role: "assistant", text, at: now(), ...extra });
const userSaid = (s: DocState, text: string) => s.messages.push({ role: "user", text, at: now() });

const itemsEnabled = (d: DocShape) => d.kind === "quote" && hasItemsTable(d.body);
const stageName = (id: StageId) => STAGES.find((x) => x.id === id)?.name ?? id;
/** AI로 해석하지 않는 항목 (개인정보) */
const isPrivate = (f: TemplateField) => f.type === "email" || f.type === "phone";

const COMPLETE_RE = /^(완료|완성|끝|다\s*됐|다\s*했|이제\s*됐|이대로\s*완성|됐어|마무리)/;
const ITEMS_DONE_RE = /^(끝|없어|없음|없습니다|완료|다\s*했|그만|이게\s*다|품목\s*추가\s*완료)/;
const SKIP_RE = /^(건너뛰|스킵|패스|넘어가|다음에|나중에|없음$|없어요?$|없습니다$|모름|몰라)/;
const NO_LEAD_RE = /(리드\s*없이|없이\s*작성|리드\s*없음)/;
const EDIT_RE = /(바꿔|바꾸|변경|수정|고쳐|정정|으로\s*해|로\s*해|로\s*하자|빼\s*줘|지워|삭제|추가해)/;

// ───────── 빠른 답변 ─────────

function quickFor(f: TemplateField, today: string): QuickReply[] {
  const q: QuickReply[] = [];
  if (f.defaultValue) q.push({ label: f.defaultValue, action: "answer", value: f.defaultValue });
  if (f.type === "choice") q.push(...f.options.map((o) => ({ label: o, action: "answer" as const, value: o })));
  if (f.type === "date") {
    const next = parseDate("다음 달 1일", today)!;
    q.push(
      { label: `오늘 (${today.slice(5).replace("-", "/")})`, action: "answer", value: today },
      { label: `다음 달 1일 (${next.slice(5).replace("-", "/")})`, action: "answer", value: next }
    );
  }
  if (f.type === "period") q.push(...["6개월", "1년", "2년"].map((v) => ({ label: v, action: "answer" as const, value: v })));
  if (!f.required) q.push({ label: "건너뛰기", action: "skip" });
  return q.filter((x, i, a) => a.findIndex((y) => y.action === x.action && y.value === x.value) === i);
}

async function recentLeadQuick(): Promise<QuickReply[]> {
  const { rows } = await pool.query<{ id: string; company: string; contact: string }>(
    `SELECT id, company, contact FROM leads WHERE stage NOT IN ('won','lost') ORDER BY updated_at DESC LIMIT 5`
  );
  return rows.map((r) => ({ label: r.contact ? `${r.company} · ${r.contact}` : r.company, action: "select_lead" as const, value: r.id }));
}

// ───────── 다음 질문 ─────────

/** 다음에 물을 것을 정하고 질문 메시지를 남긴다 */
function ask(d: DocShape, s: DocState) {
  if (s.status === "sent") {
    s.step = { type: "done" };
    return;
  }
  if (s.status === "completed") {
    s.step = { type: "done" };
    return;
  }
  if (itemsEnabled(d) && !s.skipped.includes(ITEMS_KEY)) {
    s.step = { type: "items" };
    say(
      s,
      s.lineItems.length
        ? "더 추가할 품목이 있나요? 없으면 ‘품목 추가 완료’를 눌러 주세요."
        : "품목을 알려주세요. 예: ‘CRM 라이선스 10개 단가 5만원’, ‘초기 세팅 1식 150만원’",
      {
        kind: "question",
        quick: s.lineItems.length
          ? [{ label: "품목 추가 완료", action: "items_done" }, { label: "마지막 품목 삭제", action: "remove_last_item" }]
          : [],
      }
    );
    return;
  }
  const next = d.fields.find((f) => !s.values[f.key]?.trim() && !s.skipped.includes(f.key));
  if (next) {
    s.step = { type: "field", key: next.key };
    say(s, questionFor(next) + (next.hint ? `\n(${next.hint})` : ""), {
      kind: "question", fieldKey: next.key, quick: quickFor(next, todayKst()),
    });
    return;
  }
  const missing = missingList(d, s);
  s.step = { type: "review" };
  say(
    s,
    missing.length
      ? `질문을 모두 마쳤어요. 필수 항목 ${missing.length}개(${missing.join(", ")})가 비어 있어요.`
      : "모든 항목을 채웠어요. 오른쪽 문서를 확인하고 완성해 주세요.",
    {
      kind: "question",
      quick: [{ label: "완성하기", action: "complete" }, ...(missing.length ? [{ label: "빈 항목 채우기", action: "fill_missing" as const }] : [])],
    }
  );
}

/** 비어 있는 필수 항목 (견적서는 품목 없음 포함) */
function missingList(d: DocShape, s: DocState): string[] {
  const missing = missingRequired(d.fields, s.values);
  return itemsEnabled(d) && s.lineItems.length === 0 ? ["품목", ...missing] : missing;
}

function complete(d: DocShape, s: DocState, allowBlank: boolean) {
  const missing = missingList(d, s);
  if (missing.length && !allowBlank) {
    s.step = { type: "confirm_complete", missing };
    say(s, `필수 항목 ${missing.length}개(${missing.join(", ")})가 비어 있어요. 그래도 완성할까요?`, {
      kind: "question",
      quick: [{ label: "빈 항목 채우기", action: "fill_missing" }, { label: "빈칸으로 완성", action: "complete_blank" }],
    });
    return;
  }
  s.status = "completed";
  s.step = { type: "done" };
  say(s, "문서를 완성했어요. PDF로 내려받거나 메일로 보낼 수 있어요.", { kind: "result" });
}

// ───────── 값 반영 ─────────

/** 항목 값 반영(유형에 맞는 값만) + 종료일 자동 계산. 바뀐 항목 이름 반환 */
export function applyValues(d: DocShape, s: DocState, updates: Record<string, string>, allowPrivate = true): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const f = d.fields.find((x) => x.key === key);
    if (!f || (!allowPrivate && isPrivate(f))) continue;
    const n = normalizeStored(f, value);
    if (!n.ok) continue;
    if ((s.values[key] ?? "") === n.value) continue;
    s.values[key] = n.value;
    s.skipped = s.skipped.filter((k) => k !== key);
    changed.push(key);
  }
  const derived = deriveEndDate(d.fields, s.values);
  if (derived && changed.some((k) => derived.sources.includes(k)) && !changed.includes(derived.key) && s.values[derived.key] !== derived.value) {
    s.values[derived.key] = derived.value;
    s.skipped = s.skipped.filter((k) => k !== derived.key);
    changed.push(derived.key);
  }
  return changed;
}

const filledText = (d: DocShape, s: DocState, keys: string[], prefix = "✓") =>
  `${prefix} ${keys
    .map((k) => `${k} ${displayValue(d.fields.find((f) => f.key === k), s.values[k] ?? "") || "(빈칸)"}`)
    .join(", ")} 입력`;

function itemText(it: LineItem) {
  return `${it.name}${it.spec ? `(${it.spec})` : ""} · ${formatNumber(it.qty)} × ${formatNumber(it.unitPrice)} = ${formatNumber(lineAmount(it))}`;
}

function totalsText(d: DocShape, items: LineItem[]) {
  const t = computeTotals(items, d.lineItemsConfig);
  const vat = d.lineItemsConfig?.vat ?? "excluded";
  return `합계 ${formatNumber(t.total)}원${vat === "excluded" ? " (부가세 포함)" : vat === "included" ? " (부가세 포함 단가)" : ""}`;
}

/** "CRM 라이선스 10개 단가 5만원" 같은 단순한 품목 문장 (AI 없이) */
export function parseItemText(text: string): LineItem | null {
  const m = /^(.+?)\s+(\d[\d,]*)\s*(개|식|명|ea|석|건|대|set|copy|권|박스|box|seat|좌석)\s*,?\s*(?:단가|개당|각|@)?\s*([0-9][0-9,.]*\s*(?:억|만|천)?\s*(?:만)?\s*원?)$/i.exec(text.trim());
  if (!m) return null;
  return cleanItem({ name: m[1], spec: m[3] === "식" ? "1식" : "", qty: parseAmount(m[2]), unitPrice: parseAmount(m[4]) });
}

// ───────── AI 해석 ─────────

interface Interpretation {
  intent: string;
  updates: Record<string, string>;
  addItems: LineItem[];
  updateItems: { index: number; patch: Record<string, unknown> }[];
  removeItems: number[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function parseInterpretation(content: string): Interpretation {
  let raw: Record<string, unknown> = {};
  try {
    raw = obj(JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "")));
  } catch {}
  const updates: Record<string, string> = {};
  for (const u of Array.isArray(raw.updates) ? raw.updates : []) {
    const r = obj(u);
    if (typeof r.key === "string" && (typeof r.value === "string" || typeof r.value === "number")) updates[r.key] = String(r.value);
  }
  const addItems = (Array.isArray(raw.addItems) ? raw.addItems : []).map(cleanItem).filter((x): x is LineItem => x !== null);
  const updateItems = (Array.isArray(raw.updateItems) ? raw.updateItems : []).flatMap((u) => {
    const r = obj(u);
    return typeof r.index === "number" ? [{ index: Math.round(r.index), patch: r }] : [];
  });
  const removeItems = (Array.isArray(raw.removeItems) ? raw.removeItems : []).filter((n): n is number => typeof n === "number").map(Math.round);
  return { intent: typeof raw.intent === "string" ? raw.intent : "unclear", updates, addItems, updateItems, removeItems };
}

async function interpret(d: LoadedDocument, s: DocState, message: string, current: string): Promise<Interpretation> {
  const fields = d.fields
    .filter((f) => !isPrivate(f))
    .map((f) => ({ key: f.key, type: f.type, ...(f.options.length ? { options: f.options } : {}) }));
  const items = itemsEnabled(d)
    ? s.lineItems.map((it, i) => ({ index: i + 1, name: it.name, spec: it.spec, qty: it.qty, unitPrice: it.unitPrice }))
    : null;
  const system = `당신은 ${KIND_LABEL[d.kind]} 작성 도우미가 받은 사용자 답변을 구조화하는 해석기입니다. JSON 객체만 출력하세요.
오늘: ${todayKst()} (한국 시간)
지금 묻는 것: ${current}
항목 목록: ${JSON.stringify(fields)}
${items ? `현재 품목: ${JSON.stringify(items)}\n` : ""}
출력 형식:
{"intent": "answer|edit|items|complete|skip|off_topic|unclear",
 "updates": [{"key": "항목 이름", "value": "값"}],
 "addItems": [{"name": "품목명", "spec": "규격", "qty": 1, "unitPrice": 0}],
 "updateItems": [{"index": 1, "name": "…", "spec": "…", "qty": 0, "unitPrice": 0}],
 "removeItems": [1]}

규칙:
- key는 항목 목록의 이름과 정확히 같아야 합니다. 목록에 없는 항목은 만들지 마세요.
- 값 형식: 날짜 YYYY-MM-DD, 금액·숫자는 정수(원 단위, 쉼표 없이), 기간은 "1년"/"6개월"/"1년 6개월"/"30일", 선택지는 보기 중 하나를 그대로, 텍스트는 값만(조사·존댓말 제외).
- "다음 달 1일"처럼 상대적인 날짜는 오늘 기준으로 계산하세요.
- 지금 묻는 항목에 대한 답이면 intent=answer, 다른 항목을 바꾸라는 요청이면 edit, 품목 추가·수정·삭제면 items.
- 품목: 단가는 1개 가격(원). "월 5만원 20개 12개월"이면 단가 = 50000 × 12 = 600000, 규격 "12개월". "1식"은 수량 1, 규격 "1식".
  updateItems에는 바꿀 값만 넣고, index는 1부터 시작하는 품목 번호입니다.
- 작성을 끝내자는 말(완료, 다 됐어)은 complete, 건너뛰자는 말은 skip, 문서 작성과 관계없는 질문은 off_topic, 이해할 수 없으면 unclear.
- 사용자가 말하지 않은 값을 지어내지 마세요. 해당 없는 배열은 []로 두세요.`;
  const content = await chatCompletion(
    [{ role: "system", content: system }, { role: "user", content: maskPii(message) }],
    { maxTokens: 700, json: true }
  );
  return parseInterpretation(content);
}

/** 품목 변경 적용 → 안내 문구 목록 */
function applyItems(s: DocState, it: Pick<Interpretation, "addItems" | "updateItems" | "removeItems">): string[] {
  const notes: string[] = [];
  for (const u of it.updateItems) {
    const cur = s.lineItems[u.index - 1];
    if (!cur) continue;
    const next = cleanItem({ ...cur, ...Object.fromEntries(Object.entries(u.patch).filter(([k]) => ["name", "spec", "qty", "unitPrice"].includes(k))) });
    if (next) {
      s.lineItems[u.index - 1] = next;
      notes.push(`품목 ${u.index} 수정 — ${itemText(next)}`);
    }
  }
  for (const idx of [...new Set(it.removeItems)].sort((a, b) => b - a)) {
    const removed = s.lineItems[idx - 1];
    if (removed) {
      s.lineItems.splice(idx - 1, 1);
      notes.push(`품목 ${idx} 삭제 — ${removed.name}`);
    }
  }
  for (const add of it.addItems) {
    if (s.lineItems.length >= ITEM_LIMITS.count) break;
    s.lineItems.push(add);
    notes.push(`품목 ${s.lineItems.length} 추가 — ${itemText(add)}`);
  }
  return notes;
}

// ───────── 리드 ─────────

/** 문서 작성에 쓰는 리드 값 (회사·담당자·연락처 항목 채움, 발송 후 단계 제안) */
export type LeadLite = Pick<Lead, "id" | "company" | "contact" | "email" | "phone" | "value" | "stage">;
const LEAD_LITE_COLUMNS = "id, company, contact, email, phone, value, stage";

export async function findLeadLite(id: string, db: PoolClient | typeof pool = pool): Promise<LeadLite | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query<LeadLite>(`SELECT ${LEAD_LITE_COLUMNS} FROM leads WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

function selectLead(d: DocShape, s: DocState, lead: LeadLite, changed: string[]) {
  s.leadId = lead.id;
  const updates: Record<string, string> = {};
  for (const f of d.fields) {
    const v = f.leadSource ? leadValue(lead, f.leadSource) : "";
    if (v && !s.values[f.key]?.trim()) updates[f.key] = v;
  }
  const filled = applyValues(d, s, updates);
  changed.push(...filled);
  say(
    s,
    filled.length
      ? `${filledText(d, s, filled, "✓ 리드에서 채움 —").replace(/ 입력$/, "")}\n다른 값이 있으면 말씀해 주세요.`
      : `${lead.company} 리드로 작성할게요.`,
    { kind: "filled" }
  );
}

// ───────── 처리 ─────────

export interface ChatInput {
  message: string;
  action: DocAction | null;
  value: string;
}

async function handleText(d: LoadedDocument, s: DocState, text: string, changed: string[]) {
  const step = s.step;

  if (step.type === "lead") {
    if (NO_LEAD_RE.test(text)) {
      s.leadId = null;
      say(s, "리드 없이 작성할게요.", { kind: "info" });
      return ask(d, s);
    }
    const q = text.replace(/[%_\\]/g, "\\$&").slice(0, 100);
    const { rows } = await pool.query<LeadLite>(
      `SELECT ${LEAD_LITE_COLUMNS} FROM leads
       WHERE company ILIKE '%' || $1 || '%' OR contact ILIKE '%' || $1 || '%' OR $2 ILIKE '%' || company || '%'
       ORDER BY (lower(company) = lower($2)) DESC, updated_at DESC LIMIT 6`,
      [q, text.slice(0, 200)]
    );
    if (rows.length === 1) {
      selectLead(d, s, rows[0], changed);
      return ask(d, s);
    }
    const recent = rows.length ? [] : await recentLeadQuick();
    say(s, rows.length ? "어느 리드인가요?" : `‘${text.slice(0, 30)}’와 일치하는 리드를 찾지 못했어요. 다시 입력하거나 아래에서 골라 주세요.`, {
      kind: "question",
      quick: [
        ...(rows.length ? rows : []).map((r) => ({ label: r.contact ? `${r.company} · ${r.contact}` : r.company, action: "select_lead" as const, value: r.id })),
        ...recent,
        { label: "리드 없이 작성", action: "no_lead" as const },
      ],
    });
    return;
  }

  if (step.type === "items" && ITEMS_DONE_RE.test(text)) return itemsDone(d, s);
  if (COMPLETE_RE.test(text)) return complete(d, s, false);
  const current = step.type === "field" ? d.fields.find((f) => f.key === step.key) : undefined;
  if (current && SKIP_RE.test(text)) {
    s.skipped.push(current.key);
    return ask(d, s);
  }

  const editLike = EDIT_RE.test(text) || d.fields.some((f) => f.key !== current?.key && f.key.length >= 2 && text.includes(f.key));

  // 1) 지금 묻는 항목 → 규칙으로 해석
  if (current && !editLike) {
    const direct = current.type !== "text" || text.length <= 30 ? parseFieldValue(current, text) : { ok: false as const };
    if (direct.ok) {
      const keys = applyValues(d, s, { [current.key]: direct.value });
      changed.push(...keys);
      if (keys.length) say(s, filledText(d, s, keys), { kind: "filled" });
      else s.skipped = s.skipped.filter((k) => k !== current.key);
      return ask(d, s);
    }
    if (isPrivate(current)) {
      say(s, `${current.type === "email" ? "이메일 주소 형식으로" : "전화번호 형식으로"} 알려주세요. 예: ${current.type === "email" ? "name@company.com" : "010-1234-5678"}`, {
        kind: "question", fieldKey: current.key, quick: quickFor(current, todayKst()),
      });
      return;
    }
  }
  // 품목 단순 문장
  if (step.type === "items" && !editLike) {
    const item = parseItemText(text);
    if (item) {
      const notes = applyItems(s, { addItems: [item], updateItems: [], removeItems: [] });
      changed.push(ITEMS_KEY);
      say(s, `✓ ${notes.join("\n✓ ")}\n${totalsText(d, s.lineItems)}`, { kind: "filled" });
      return ask(d, s);
    }
  }

  // 2) AI 해석
  const label = current ? `${current.key} (${current.type})` : step.type === "items" ? "견적 품목" : "없음 (수정 요청 대기)";
  const r = await interpret(d, s, text, label);
  if (r.intent === "complete") return complete(d, s, false);
  if (r.intent === "skip" && current) {
    s.skipped.push(current.key);
    return ask(d, s);
  }
  if (r.intent === "off_topic") {
    say(s, "이 화면에서는 문서 작성만 도와드려요. 리드·일정 질문은 다른 메뉴의 AI Assistant를 이용해 주세요.", { kind: "info" });
    return s.status === "draft" ? ask(d, s) : undefined;
  }
  const keys = applyValues(d, s, r.updates, false);
  const itemNotes = itemsEnabled(d) ? applyItems(s, r) : [];
  changed.push(...keys, ...(itemNotes.length ? [ITEMS_KEY] : []));
  if (!keys.length && !itemNotes.length) {
    say(s, "잘 이해하지 못했어요. 다시 알려주세요.", { kind: "info" });
    return s.status === "draft" ? ask(d, s) : undefined;
  }
  const lines = [...(keys.length ? [filledText(d, s, keys)] : []), ...itemNotes.map((n) => `✓ ${n}`)];
  if (itemNotes.length) lines.push(totalsText(d, s.lineItems));
  say(s, lines.join("\n"), { kind: "filled" });
  if (s.status === "completed") say(s, "완성된 문서에도 반영했어요.", { kind: "info" });
  else ask(d, s);
}

function itemsDone(d: DocShape, s: DocState) {
  if (s.lineItems.length === 0) {
    say(s, "품목을 1개 이상 입력해 주세요.", { kind: "info" });
    return ask(d, s);
  }
  if (!s.skipped.includes(ITEMS_KEY)) s.skipped.push(ITEMS_KEY);
  ask(d, s);
}

/** 리드 단계 이동 (발송 후 제안 버튼). 같은 트랜잭션에서 이력 기록 */
async function moveLeadStage(client: PoolClient, leadId: string, stage: StageId): Promise<{ company: string } | null> {
  const prev = (await client.query<{ stage: StageId; company: string }>("SELECT stage, company FROM leads WHERE id = $1 FOR UPDATE", [leadId])).rows[0];
  if (!prev) return null;
  if (prev.stage === stage) return { company: prev.company };
  const { rows } = await client.query<{ max: number | null }>("SELECT max(position) AS max FROM leads WHERE id <> $1", [leadId]);
  await client.query("UPDATE leads SET stage = $2, position = $3, updated_at = now() WHERE id = $1", [leadId, stage, (rows[0].max ?? 0) + 1]);
  await recordEvent(client, leadId, prev.company, "moved", { stage: { from: prev.stage, to: stage } });
  return { company: prev.company };
}

/** Assistant 대화 1회 처리 */
export async function handleDocChat(id: string, input: ChatInput): Promise<DocChatResult> {
  const d = await getDocument(id);
  if (!d) throw new DocError("문서를 찾을 수 없습니다", 404);
  const s = stateOf(d);
  const changed: string[] = [];
  let leadChanged = false;
  const { action, value, message } = input;

  if (d.status === "sent" && action !== "move_stage" && action !== "keep_stage") {
    if (message) userSaid(s, message);
    say(s, "발송한 문서는 수정할 수 없어요. 작성한 문서 목록에서 ‘복제’해 수정하세요.", { kind: "info" });
  } else if (action) {
    switch (action) {
      case "select_lead": {
        const lead = await findLeadLite(value);
        if (!lead) throw new DocError("리드를 찾을 수 없습니다", 400);
        userSaid(s, lead.contact ? `${lead.company} · ${lead.contact}` : lead.company);
        selectLead(d, s, lead, changed);
        ask(d, s);
        break;
      }
      case "no_lead":
        userSaid(s, "리드 없이 작성");
        s.leadId = null;
        say(s, "리드 없이 작성할게요.", { kind: "info" });
        ask(d, s);
        break;
      case "answer": {
        if (!value) throw new DocError("답변을 입력하세요", 400);
        userSaid(s, value);
        await handleText(d, s, value, changed);
        break;
      }
      case "skip":
        userSaid(s, "건너뛰기");
        if (s.step.type === "field" && !s.skipped.includes(s.step.key)) s.skipped.push(s.step.key);
        ask(d, s);
        break;
      case "items_done":
        userSaid(s, "품목 추가 완료");
        itemsDone(d, s);
        break;
      case "remove_last_item": {
        userSaid(s, "마지막 품목 삭제");
        const removed = s.lineItems.pop();
        if (removed) {
          changed.push(ITEMS_KEY);
          say(s, `✓ ${removed.name} 삭제\n${totalsText(d, s.lineItems)}`, { kind: "filled" });
        }
        ask(d, s);
        break;
      }
      case "complete":
        userSaid(s, "완성하기");
        complete(d, s, false);
        break;
      case "complete_blank":
        userSaid(s, "빈칸으로 완성");
        complete(d, s, true);
        break;
      case "fill_missing": {
        userSaid(s, "빈 항목 채우기");
        const missing = missingList(d, s);
        s.skipped = s.skipped.filter((k) => !missing.includes(k) && !(k === ITEMS_KEY && missing.includes("품목")));
        s.status = "draft";
        ask(d, s);
        break;
      }
      case "reopen":
        userSaid(s, "계속 수정");
        s.status = "draft";
        say(s, "수정할 내용을 말씀하시거나, 오른쪽 문서에서 값을 눌러 바로 고치세요.", { kind: "info" });
        ask(d, s);
        break;
      case "keep_stage":
        userSaid(s, "그대로 두기");
        say(s, "알겠어요. 리드 단계는 그대로 둘게요.", { kind: "info" });
        break;
      case "move_stage": {
        if (!isStage(value) || !d.leadId) throw new DocError("잘못된 요청입니다", 400);
        userSaid(s, `${stageName(value)} 단계로 이동`);
        const moved = await withTransaction((c) => moveLeadStage(c, d.leadId!, value));
        if (!moved) throw new DocError("리드를 찾을 수 없습니다", 404);
        leadChanged = true;
        say(s, `✓ ${moved.company} 리드를 ‘${stageName(value)}’ 단계로 옮겼어요.`, { kind: "filled" });
        break;
      }
    }
  } else {
    userSaid(s, message);
    if (d.status === "completed" && COMPLETE_RE.test(message)) say(s, "이미 완성된 문서예요. PDF로 내려받거나 메일로 보낼 수 있어요.", { kind: "result" });
    else await handleText(d, s, message, changed);
  }

  if (!(await saveState(pool, id, d.rev, s))) {
    throw new DocError("다른 화면에서 문서가 바뀌었습니다. 새로고침 후 다시 시도하세요", 409);
  }
  const saved = await getDocument(id);
  return { document: publicDocument(saved!), changed: [...new Set(changed)], leadChanged };
}

/** 오른쪽 문서에서 직접 수정 (값·품목·제목) */
export async function patchDocument(
  id: string,
  patch: { values?: Record<string, string>; lineItems?: LineItem[]; title?: string }
): Promise<DocChatResult> {
  const d = await getDocument(id);
  if (!d) throw new DocError("문서를 찾을 수 없습니다", 404);
  if (d.status === "sent") throw new DocError("발송한 문서는 수정할 수 없습니다. 복제해서 수정하세요", 409);
  const s = stateOf(d);
  const changed: string[] = [];
  if (patch.title) s.title = patch.title;
  if (patch.values) {
    for (const [k, v] of Object.entries(patch.values)) {
      const f = d.fields.find((x) => x.key === k);
      if (!f) throw new DocError(`없는 항목입니다: ${k}`, 400);
      if (!normalizeStored(f, v).ok) throw new DocError(`${k} 값을 ${f.type === "date" ? "날짜(예: 2026-12-01)" : "올바른 형식"}로 입력하세요`, 400);
      if (!v.trim()) {
        if (s.values[k]) {
          delete s.values[k];
          changed.push(k);
        }
      }
    }
    const keys = applyValues(d, s, Object.fromEntries(Object.entries(patch.values).filter(([, v]) => v.trim())));
    changed.push(...keys);
    if (changed.length) say(s, filledText(d, s, changed, "✓ 직접 수정 —").replace(/ 입력$/, ""), { kind: "filled" });
  }
  if (patch.lineItems) {
    s.lineItems = patch.lineItems;
    changed.push(ITEMS_KEY);
    say(s, `✓ 품목 표 수정 — ${s.lineItems.length}개, ${totalsText(d, s.lineItems)}`, { kind: "filled" });
  }
  // 지금 묻던 항목이 채워졌으면 다음 질문으로
  if (s.status === "draft" && s.step.type === "field" && s.values[s.step.key]?.trim()) ask(d, s);

  if (!(await saveState(pool, id, d.rev, s))) {
    throw new DocError("다른 화면에서 문서가 바뀌었습니다. 새로고침 후 다시 시도하세요", 409);
  }
  return { document: publicDocument((await getDocument(id))!), changed, leadChanged: false };
}

/** 템플릿으로 새 문서 만들기 → 첫 질문(리드 선택)까지 */
export async function createDocument(template: DocTemplate, userId: string | null): Promise<string> {
  const quick = await recentLeadQuick();
  const s: DocState = {
    leadId: null, title: template.name, values: {}, lineItems: [], skipped: [], messages: [], step: { type: "lead" }, status: "draft",
  };
  userSaid(s, template.name);
  say(s, `좋아요. 어느 리드의 ${KIND_LABEL[template.kind]}인가요?`, {
    kind: "question",
    quick: [...quick, { label: "리드 없이 작성", action: "no_lead" }],
  });
  return withTransaction((c) => insertDocument(c, template, s, userId));
}

/** 템플릿 스냅샷 + 상태로 문서 행 만들기 (문서번호 발급 포함, 호출한 쪽 트랜잭션) */
export async function insertDocument(c: PoolClient, template: DocTemplate, s: DocState, userId: string | null): Promise<string> {
  const docNumber = await nextDocNumber(c, template.kind);
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO documents (template_id, kind, title, doc_number, lead_id, body, fields, line_items_config, email_subject, email_body,
                            field_values, line_items, skipped, messages, step, status, completed_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, CASE WHEN $16 = 'completed' THEN now() END, $17) RETURNING id`,
    [
      template.id, template.kind, s.title, docNumber, s.leadId, template.body, JSON.stringify(template.fields),
      template.lineItems ? JSON.stringify(template.lineItems) : null, template.emailSubject, template.emailBody,
      JSON.stringify(s.values), JSON.stringify(s.lineItems), JSON.stringify(s.skipped), JSON.stringify(s.messages),
      JSON.stringify(s.step), s.status, userId,
    ]
  );
  return rows[0].id;
}

/**
 * 구조화된 입력으로 문서 채우기 (Sales Agent): 리드 → 항목 값 → 품목 → 완성.
 * OpenAI를 부르지 않는다. 이메일·전화번호 항목은 리드에서만 채운다(allowPrivate=false).
 * 필수 항목이 비면 초안으로 두고 다음 질문을 남긴다 → 비어 있는 항목 이름
 */
export function fillFromInput(
  d: DocShape, s: DocState,
  input: { lead: LeadLite | null; values: Record<string, string>; lineItems: LineItem[] }
): string[] {
  if (input.lead) selectLead(d, s, input.lead, []);
  applyValues(d, s, input.values, false);
  if (itemsEnabled(d) && input.lineItems.length) {
    s.lineItems = input.lineItems.slice(0, ITEM_LIMITS.count);
    if (!s.skipped.includes(ITEMS_KEY)) s.skipped.push(ITEMS_KEY);
  }
  const missing = missingList(d, s);
  if (missing.length === 0) complete(d, s, false);
  else ask(d, s);
  return missing;
}

/** 문서 복제 (발송한 문서를 고칠 때): 값·품목·리드를 그대로 두고 새 문서번호로 */
export async function duplicateDocument(src: LoadedDocument, userId: string | null): Promise<string> {
  const s: DocState = {
    leadId: src.leadId, title: src.title, values: { ...src.values }, lineItems: [...src.lineItems],
    skipped: [...src.skipped], messages: [], step: { type: "review" }, status: "draft",
  };
  say(s, `${src.docNumber} 문서를 복제했어요. 수정할 내용을 말씀하시거나 오른쪽 문서에서 값을 눌러 고치세요.`, { kind: "info" });
  ask({ ...src, status: "draft" }, s);
  return withTransaction(async (c) => {
    const docNumber = await nextDocNumber(c, src.kind);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO documents (template_id, kind, title, doc_number, lead_id, body, fields, line_items_config, email_subject,
                              email_body, field_values, line_items, skipped, messages, step, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [
        src.templateId, src.kind, src.title, docNumber, src.leadId, src.body, JSON.stringify(src.fields),
        src.lineItemsConfig ? JSON.stringify(src.lineItemsConfig) : null, src.emailSubject, src.emailBody,
        JSON.stringify(s.values), JSON.stringify(s.lineItems), JSON.stringify(s.skipped), JSON.stringify(s.messages),
        JSON.stringify(s.step), userId,
      ]
    );
    return rows[0].id;
  });
}

/** 발송 후 제안할 단계: 견적서 → 제안/견적, 계약서 → 협상 (이미 그 단계 이후거나 수주·실주면 없음) */
export function suggestedStage(kind: DocKind, stage: StageId): StageId | null {
  const target: StageId = kind === "quote" ? "proposal" : "negotiation";
  const order = STAGES.map((x) => x.id);
  return stage === "won" || stage === "lost" || order.indexOf(stage) >= order.indexOf(target) ? null : target;
}

/** 발송 후 Assistant 메시지 + 리드 단계 이동 제안 (견적서 → 제안/견적, 계약서 → 협상) */
export function afterSendMessages(
  s: DocState, kind: DocKind, to: string[], link: string, lead: { company: string; stage: StageId } | null
) {
  say(s, `✓ ${to.join(", ")}에 ${KIND_LABEL[kind]}를 보냈어요.`, { kind: "sent", link });
  const target = lead ? suggestedStage(kind, lead.stage) : null;
  if (!lead || !target) return;
  say(s, `${lead.company} 리드를 ‘${stageName(target)}’ 단계로 옮길까요? (현재: ${stageName(lead.stage)})`, {
    kind: "question",
    quick: [{ label: `${stageName(target)}로 이동`, action: "move_stage", value: target }, { label: "그대로 두기", action: "keep_stage" }],
  });
}
