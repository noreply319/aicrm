import type {
  DocKind, FieldType, Lead, LeadSource, LineItem, LineItemsConfig, TemplateField,
} from "./types";

/**
 * 계약서·견적서 템플릿 공통 로직 (서버·클라이언트 공용, 외부 의존 없음)
 *  - 본문의 {{항목}} 찾기, 항목 설정 동기화
 *  - 본문 → 블록(제목·문단·목록·품목 표) 변환: 화면 미리보기와 PDF가 같은 결과를 쓴다
 *  - 답변 해석(날짜·금액·기간·선택지 등), 품목 합계·한글 금액 계산
 */

export const KIND_LABEL: Record<DocKind, string> = { contract: "계약서", quote: "견적서" };

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "텍스트", multiline: "여러 줄", number: "숫자", money: "금액(원)", date: "날짜",
  period: "기간", email: "이메일", phone: "전화번호", choice: "선택지",
};

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  "": "없음", company: "회사명", contact: "담당자", email: "이메일", phone: "전화번호", value: "예상 금액",
};

export const TEMPLATE_LIMITS = { name: 100, description: 500, body: 50_000, fields: 50, key: 40, options: 20, email: 5000 };

/** 품목 표 블록 */
export const ITEMS_KEY = "품목표";
/** 자동으로 채우는 항목 (묻지 않음) */
export const SYSTEM_KEYS = ["문서번호", "작성일", "문서명", "작성자", "작성자_이메일"] as const;
/** 품목 표에서 계산하는 항목 (묻지 않음) */
export const CALC_KEYS = ["공급가액", "부가세", "합계", "합계_한글"] as const;

const RESERVED = new Set<string>([ITEMS_KEY, ...SYSTEM_KEYS, ...CALC_KEYS]);
export const isReservedKey = (key: string) => RESERVED.has(key);

const TOKEN_RE = /\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g;

/** 텍스트에서 {{항목}} 이름을 등장 순서대로 (중복 제거) */
export function extractKeys(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const k = m[1].trim();
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

export const hasItemsTable = (body: string) => extractKeys(body).includes(ITEMS_KEY);

/** 항목 이름으로 유형·리드 자동 채움 추측 (새 항목 기본값) */
export function guessField(key: string): TemplateField {
  const f: TemplateField = {
    key, type: "text", question: "", hint: "", required: true, defaultValue: "", leadSource: "", options: [],
  };
  if (/이메일|메일|e-?mail/i.test(key)) f.type = "email";
  else if (/전화|연락처|휴대폰|핸드폰/.test(key)) f.type = "phone";
  else if (/기간/.test(key)) f.type = "period";
  else if (/(일|일자|날짜|기한)$/.test(key) && !/요일/.test(key)) f.type = "date";
  else if (/금액|요금|대금|비용|단가|가격|보증금/.test(key)) f.type = "money";
  else if (/수량|개수|인원|석/.test(key)) f.type = "number";
  else if (/주소|비고|특약|내용|범위/.test(key)) f.type = "multiline";

  if (/^(회사명|고객사|고객명|상호|업체명|회사)$/.test(key)) f.leadSource = "company";
  else if (/^(담당자|담당자명|고객 ?담당자)$/.test(key)) f.leadSource = "contact";
  else if (f.type === "email" && /담당|고객/.test(key)) f.leadSource = "email";
  else if (f.type === "phone" && /담당|고객/.test(key)) f.leadSource = "phone";
  else if (f.type === "money" && /계약 ?금액|이용 ?요금|견적 ?금액|총 ?금액/.test(key)) f.leadSource = "value";
  if (/비고|특약/.test(key)) f.required = false;
  return f;
}

/**
 * 본문·메일 양식의 {{항목}}과 항목 설정을 맞춘다.
 * 기존 설정은 순서·값을 유지하고, 새 항목은 추측한 기본값으로 뒤에 붙이고, 사라진 항목은 뺀다.
 */
export function syncFields(texts: string[], existing: TemplateField[]): TemplateField[] {
  const keys = texts.flatMap(extractKeys).filter((k, i, a) => !isReservedKey(k) && a.indexOf(k) === i);
  const kept = existing.filter((f) => keys.includes(f.key));
  const added = keys.filter((k) => !kept.some((f) => f.key === k)).map(guessField);
  return [...kept, ...added];
}

// ───────── 한국어 조사 ─────────

const hasBatchim = (word: string) => {
  const c = word.trim().at(-1);
  if (!c) return false;
  const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return /[0-9]$/.test(c) ? "013678".includes(c) : false;
};
/** 을/를, 은/는, 이/가 */
export const josa = (word: string, pair: "을를" | "은는" | "이가") => word + (hasBatchim(word) ? pair[0] : pair[1]);

/** 질문 문구 (설정이 비어 있으면 유형별 기본 문구) */
export function questionFor(f: TemplateField): string {
  if (f.question.trim()) return f.question.trim();
  switch (f.type) {
    case "date": return `${josa(f.key, "은는")} 언제인가요?`;
    case "choice": return `${josa(f.key, "을를")} 골라 주세요.`;
    case "period": return `${josa(f.key, "은는")} 얼마나 되나요?`;
    default: return `${josa(f.key, "을를")} 알려주세요.`;
  }
}

// ───────── 날짜 (한국 시간) ─────────

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** 오늘 날짜 'YYYY-MM-DD' (한국 시간) */
export const todayKst = (now = new Date()) => now.toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 10);

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? ymd(y, m, d) : null;
}

/** 날짜 + 개월·일 (UTC 기준 계산, 말일 보정) */
export function addPeriod(date: string, months: number, days = 0): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last) + days));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** "2026-12-01", "2026.12.1", "12월 1일", "다음 달 1일", "내일" 등 → 'YYYY-MM-DD' */
export function parseDate(input: string, today = todayKst()): string | null {
  const s = input.replace(/\s+/g, " ").trim();
  const [ty, tm] = today.split("-").map(Number);
  if (/오늘/.test(s)) return today;
  if (/내일/.test(s)) return addPeriod(today, 0, 1);
  if (/모레/.test(s)) return addPeriod(today, 0, 2);

  let m = /(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);

  m = /(다음|이번|다다음)\s*달\s*(\d{1,2}|말)\s*일?/.exec(s);
  if (m) {
    const offset = m[1] === "이번" ? 0 : m[1] === "다음" ? 1 : 2;
    const first = addPeriod(ymd(ty, tm, 1), offset);
    if (m[2] === "말") return addPeriod(addPeriod(first, 1), 0, -1);
    const [fy, fm] = first.split("-").map(Number);
    return validYmd(fy, fm, +m[2]);
  }

  m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(s) ?? /^(\d{1,2})\s*[./]\s*(\d{1,2})$/.exec(s);
  if (m) {
    // 연도가 없으면 올해. 이미 두 달 넘게 지난 날짜면 내년으로 본다
    let y = ty;
    const candidate = validYmd(y, +m[1], +m[2]);
    if (candidate && candidate < addPeriod(today, -2)) y += 1;
    return validYmd(y, +m[1], +m[2]);
  }
  return null;
}

/** 'YYYY-MM-DD' → '2026년 12월 1일' */
export const formatKoreanDate = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${+m[1]}년 ${+m[2]}월 ${+m[3]}일` : v;
};

// ───────── 기간 ─────────

/** "1년", "6개월", "1년 6개월", "30일" → 정규화한 문자열과 개월·일 */
export function parsePeriod(input: string): { text: string; months: number; days: number } | null {
  const s = input.replace(/\s+/g, "");
  const y = /(\d+)년/.exec(s);
  const mo = /(\d+)(개월|달)/.exec(s);
  const d = /(\d+)일/.exec(s);
  const korean: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 여섯: 6 };
  const ky = /(한|두|세)해/.exec(s);
  const kmo = /(한|두|세|네|여섯)달/.exec(s);
  const years = y ? +y[1] : ky ? korean[ky[1]] : 0;
  const months = mo ? +mo[1] : kmo ? korean[kmo[1]] : 0;
  const days = d && !y && !mo ? +d[1] : 0;
  const total = years * 12 + months;
  if (total <= 0 && days <= 0) return null;
  if (total > 600 || days > 3650) return null;
  const text =
    days > 0 ? `${days}일` : [total >= 12 ? `${Math.floor(total / 12)}년` : "", total % 12 ? `${total % 12}개월` : ""].filter(Boolean).join(" ");
  return { text, months: total, days };
}

// ───────── 숫자·금액 ─────────

const KO_DIGIT: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SMALL_UNIT: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const BIG_UNIT: Record<string, number> = { 만: 1e4, 억: 1e8, 조: 1e12 };

/**
 * "1,100만원", "1.2억", "천이백만원", "5만", "12000000", "20개" → 정수. 숫자가 없으면 null
 * (문장 속 첫 금액 표현을 읽는다)
 */
export function parseAmount(input: string): number | null {
  const s = input.replace(/\s+/g, "");
  const run = /[0-9][0-9,.]*(?:[0-9,.십백천만억조일이삼사오육칠팔구]*)/.exec(s)?.[0]
    ?? /[일이삼사오육칠팔구십백천만억조]+(?=원|$|개|명|석|식|건)/.exec(s)?.[0];
  if (!run) return null;

  let total = 0;
  let section = 0; // 만 단위 미만 누적
  let num: number | null = null; // 직전 숫자
  let i = 0;
  while (i < run.length) {
    const c = run[i];
    if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9,]*(\.[0-9]+)?/.exec(run.slice(i))!;
      num = Number(m[0].replace(/,/g, ""));
      i += m[0].length;
      continue;
    }
    if (c in KO_DIGIT) {
      num = KO_DIGIT[c];
    } else if (c in SMALL_UNIT) {
      section += (num ?? 1) * SMALL_UNIT[c];
      num = null;
    } else if (c in BIG_UNIT) {
      total += (section + (num ?? 0) || 1) * BIG_UNIT[c];
      section = 0;
      num = null;
    } else {
      break;
    }
    i++;
  }
  const value = Math.round(total + section + (num ?? 0));
  return Number.isFinite(value) && value >= 0 && value < 1e15 ? value : null;
}

const KO_NUM = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
/** 14850000 → "일천사백팔십오만" */
export function koreanNumber(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "영";
  const groups = ["", "만", "억", "조"];
  let out = "";
  for (let g = 0; n > 0; g++, n = Math.floor(n / 10000)) {
    const chunk = n % 10000;
    if (!chunk) continue;
    let part = "";
    [1000, 100, 10, 1].forEach((u, idx) => {
      const d = Math.floor(chunk / u) % 10;
      if (d) part += KO_NUM[d] + ["천", "백", "십", ""][idx];
    });
    out = part + groups[g] + out;
  }
  return out;
}

/** 14850000 → "일금 일천사백팔십오만원정 (₩14,850,000)" */
export const koreanAmount = (n: number) => `일금 ${koreanNumber(n)}원정 (₩${Math.round(n).toLocaleString("ko-KR")})`;

export const formatNumber = (n: number) => Math.round(n).toLocaleString("ko-KR");

// ───────── 품목 ─────────

export interface Totals {
  supply: number;
  vat: number;
  total: number;
}

export const lineAmount = (it: LineItem) => Math.round(it.qty * it.unitPrice);

/** 공급가액·부가세·합계 (원 단위 반올림) */
export function computeTotals(items: LineItem[], cfg: LineItemsConfig | null): Totals {
  const sum = items.reduce((a, it) => a + lineAmount(it), 0);
  const vatMode = cfg?.vat ?? "excluded";
  if (vatMode === "none") return { supply: sum, vat: 0, total: sum };
  if (vatMode === "included") {
    const supply = Math.round(sum / 1.1);
    return { supply, vat: sum - supply, total: sum };
  }
  const vat = Math.round(sum * 0.1);
  return { supply: sum, vat, total: sum + vat };
}

export const ITEM_LIMITS = { count: 50, name: 100, spec: 50, qty: 1_000_000, price: 1e12 };

/** 품목 값 검증·정리 (잘못되면 null) */
export function cleanItem(raw: unknown): LineItem | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const name = typeof r.name === "string" ? r.name.trim().slice(0, ITEM_LIMITS.name) : "";
  const spec = typeof r.spec === "string" ? r.spec.trim().slice(0, ITEM_LIMITS.spec) : "";
  const qty = typeof r.qty === "number" ? r.qty : typeof r.qty === "string" ? parseAmount(r.qty) ?? NaN : NaN;
  const unitPrice = typeof r.unitPrice === "number" ? r.unitPrice : typeof r.unitPrice === "string" ? parseAmount(r.unitPrice) ?? NaN : NaN;
  if (!name || !Number.isFinite(qty) || qty <= 0 || qty > ITEM_LIMITS.qty) return null;
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > ITEM_LIMITS.price) return null;
  return { name, spec, qty: Math.round(qty * 100) / 100, unitPrice: Math.round(unitPrice) };
}

// ───────── 답변 → 값 ─────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?82[-\s.]?)?0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}/;

/** 전화번호 숫자 → 010-1234-5678 형식 */
function formatPhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("82")) d = "0" + d.slice(2);
  if (d.startsWith("02")) return d.length === 9 ? `02-${d.slice(2, 5)}-${d.slice(5)}` : `02-${d.slice(2, 6)}-${d.slice(6)}`;
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

/** 텍스트 답변 끝의 "입니다/이에요" 등을 떼어 값만 남긴다 */
function stripEnding(s: string): string {
  return s.trim().replace(/[.!~]+$/, "").replace(/\s*(입니다|이에요|예요|에요|이요|요|임)$/, "").trim();
}

export type ParseResult = { ok: true; value: string } | { ok: false };

/**
 * 답변 해석 (AI 없이). 해석할 수 없으면 ok:false → 서버가 필요하면 AI로 해석하거나 다시 묻는다.
 * 저장 형식: 날짜 'YYYY-MM-DD', 금액·숫자 정수 문자열, 기간 '1년 6개월', 그 외 텍스트
 */
export function parseFieldValue(f: TemplateField, input: string, today = todayKst()): ParseResult {
  const s = input.trim();
  if (!s) return { ok: false };
  switch (f.type) {
    case "date": {
      const v = parseDate(s, today);
      return v ? { ok: true, value: v } : { ok: false };
    }
    case "money":
    case "number": {
      const v = parseAmount(s);
      return v === null ? { ok: false } : { ok: true, value: String(v) };
    }
    case "period": {
      const v = parsePeriod(s);
      return v ? { ok: true, value: v.text } : { ok: false };
    }
    case "email": {
      const v = EMAIL_RE.exec(s)?.[0];
      return v ? { ok: true, value: v.toLowerCase() } : { ok: false };
    }
    case "phone": {
      const v = PHONE_RE.exec(s)?.[0];
      return v ? { ok: true, value: formatPhone(v) } : { ok: false };
    }
    case "choice": {
      const n = /^(\d{1,2})\s*번?$/.exec(s);
      if (n && f.options[+n[1] - 1]) return { ok: true, value: f.options[+n[1] - 1] };
      const exact = f.options.find((o) => o === s);
      if (exact) return { ok: true, value: exact };
      const hits = f.options.filter((o) => s.includes(o) || o.includes(stripEnding(s)));
      return hits.length === 1 ? { ok: true, value: hits[0] } : { ok: false };
    }
    case "multiline":
      return { ok: true, value: s.slice(0, 2000) };
    default: {
      const v = stripEnding(s);
      return v && v.length <= 200 ? { ok: true, value: v } : { ok: false };
    }
  }
}

/** 저장된 값이 유형에 맞는지 (직접 수정·AI 결과 검증). 맞으면 정규화한 값 */
export function normalizeStored(f: TemplateField, value: string, today = todayKst()): ParseResult {
  const v = value.trim();
  if (!v) return { ok: true, value: "" };
  if (f.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    const ok = validYmd(y, m, d);
    return ok ? { ok: true, value: ok } : { ok: false };
  }
  if ((f.type === "money" || f.type === "number") && /^\d+$/.test(v)) return { ok: true, value: String(Number(v)) };
  return parseFieldValue(f, v, today);
}

/** 화면·PDF 표시용 값 */
export function displayValue(f: Pick<TemplateField, "type"> | undefined, raw: string): string {
  if (!f || !raw) return raw;
  if (f.type === "money" || f.type === "number") return /^\d+$/.test(raw) ? formatNumber(Number(raw)) : raw;
  if (f.type === "date") return formatKoreanDate(raw);
  return raw;
}

/**
 * 계약 종료일 자동 계산: 종료일 = 시작일 + 기간 - 1일.
 * 시작일(이름에 '시작'), 종료일(이름에 '종료'·'만료'), 기간 유형 항목이 모두 있을 때만.
 */
export function deriveEndDate(fields: TemplateField[], values: Record<string, string>):
  { key: string; value: string; sources: string[] } | null {
  const start = fields.find((f) => f.type === "date" && /시작/.test(f.key));
  const end = fields.find((f) => f.type === "date" && /종료|만료/.test(f.key));
  const period = fields.find((f) => f.type === "period");
  if (!start || !end || !period) return null;
  const s = values[start.key];
  const p = values[period.key] ? parsePeriod(values[period.key]) : null;
  if (!s || !p) return null;
  return { key: end.key, value: addPeriod(s, p.months, p.days - 1), sources: [start.key, period.key] };
}

export function leadValue(lead: Pick<Lead, "company" | "contact" | "email" | "phone" | "value">, source: LeadSource): string {
  switch (source) {
    case "company": return lead.company;
    case "contact": return lead.contact;
    case "email": return lead.email;
    case "phone": return lead.phone;
    case "value": return lead.value > 0 ? String(lead.value) : "";
    default: return "";
  }
}

/** 필수 항목 중 비어 있는 것 */
export const missingRequired = (fields: TemplateField[], values: Record<string, string>) =>
  fields.filter((f) => f.required && !values[f.key]?.trim()).map((f) => f.key);

export function progressOf(fields: TemplateField[], values: Record<string, string>) {
  const req = fields.filter((f) => f.required);
  return { filled: req.filter((f) => values[f.key]?.trim()).length, total: req.length };
}

// ───────── 본문 → 블록 ─────────

export type Seg = { t: string } | { f: string };
export type Block =
  | { type: "h1" | "h2" | "p" | "li"; segs: Seg[] }
  | { type: "gap" }
  | { type: "items" };

function toSegs(line: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN_RE)) {
    if (m.index! > last) segs.push({ t: line.slice(last, m.index) });
    segs.push({ f: m[1].trim() });
    last = m.index! + m[0].length;
  }
  if (last < line.length) segs.push({ t: line.slice(last) });
  return segs;
}

/** 서식: '# 제목', '## 조항', '- 목록', 빈 줄 = 문단 간격, '{{품목표}}' 줄 = 품목 표 */
export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (blocks.length && blocks.at(-1)!.type !== "gap") blocks.push({ type: "gap" });
      continue;
    }
    if (line.trim() === `{{${ITEMS_KEY}}}` || line.replace(/\s/g, "") === `{{${ITEMS_KEY}}}`) {
      blocks.push({ type: "items" });
    } else if (line.startsWith("## ")) blocks.push({ type: "h2", segs: toSegs(line.slice(3).trim()) });
    else if (line.startsWith("# ")) blocks.push({ type: "h1", segs: toSegs(line.slice(2).trim()) });
    else if (/^\s*[-•]\s+/.test(line)) blocks.push({ type: "li", segs: toSegs(line.replace(/^\s*[-•]\s+/, "")) });
    else blocks.push({ type: "p", segs: toSegs(line) });
  }
  while (blocks.at(-1)?.type === "gap") blocks.pop();
  return blocks;
}

/** 값 계산에 필요한 문서 정보 */
export interface DocContext {
  fields: TemplateField[];
  values: Record<string, string>;
  lineItems: LineItem[];
  lineItemsConfig: LineItemsConfig | null;
  docNumber: string;
  /** 작성일 'YYYY-MM-DD' */
  date: string;
  docName: string;
  author: string;
  authorEmail: string;
}

export type Resolved = { text: string; filled: boolean; kind: "field" | "calc" | "system" | "unknown" };

/** {{key}} → 표시 값 */
export function resolveKey(key: string, ctx: DocContext): Resolved {
  if ((SYSTEM_KEYS as readonly string[]).includes(key)) {
    const v = { 문서번호: ctx.docNumber, 작성일: formatKoreanDate(ctx.date), 문서명: ctx.docName, 작성자: ctx.author, 작성자_이메일: ctx.authorEmail }[
      key as (typeof SYSTEM_KEYS)[number]
    ];
    return { text: v, filled: Boolean(v), kind: "system" };
  }
  if ((CALC_KEYS as readonly string[]).includes(key)) {
    const t = computeTotals(ctx.lineItems, ctx.lineItemsConfig);
    const filled = ctx.lineItems.length > 0;
    const text =
      key === "공급가액" ? formatNumber(t.supply) : key === "부가세" ? formatNumber(t.vat) : key === "합계" ? formatNumber(t.total) : koreanAmount(t.total);
    return { text, filled, kind: "calc" };
  }
  const f = ctx.fields.find((x) => x.key === key);
  const raw = ctx.values[key] ?? "";
  return { text: displayValue(f, raw), filled: Boolean(raw.trim()), kind: f ? "field" : "unknown" };
}

/** 메일 제목·본문 등 텍스트의 {{key}}를 값으로 바꾼다 (빈 값은 blank) */
export function fillText(text: string, ctx: DocContext, blank = ""): string {
  return text.replace(TOKEN_RE, (_, k: string) => {
    const r = resolveKey(k.trim(), ctx);
    return r.filled ? r.text : blank;
  });
}

/** 문서 → 값 계산 정보 (화면·PDF 공용) */
export function contextOf(doc: {
  fields: TemplateField[]; values: Record<string, string>; lineItems: LineItem[]; lineItemsConfig: LineItemsConfig | null;
  docNumber: string; createdAt: string; title: string; createdByName: string; createdByEmail: string;
}): DocContext {
  return {
    fields: doc.fields, values: doc.values, lineItems: doc.lineItems, lineItemsConfig: doc.lineItemsConfig,
    docNumber: doc.docNumber, date: todayKst(new Date(doc.createdAt)), docName: doc.title,
    author: doc.createdByName, authorEmail: doc.createdByEmail,
  };
}

/** PDF 파일명: 견적서_에이스상사_2026-11-24.pdf (파일명에 못 쓰는 문자 제거) */
export function docFileName(kind: DocKind, company: string, title: string, date: string): string {
  const name = (company || title).replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, "_").slice(0, 60);
  return `${KIND_LABEL[kind]}_${name}_${date}.pdf`;
}
