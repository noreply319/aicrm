import "server-only";
import { kstDateTime } from "./calendar";
import { pool } from "./db";
import {
  displayNames, getMessage, getMessagesMeta, involvesAddress, involvesTarget, leadTarget, listLeadMessageIds,
  stripQuoted, type LeadTarget,
} from "./gmail";
import type { TokenUser } from "./google";
import { AiError, chatCompletion, maskPii } from "./openai";
import type { LeadEmails, StoredEmail } from "./types";
import { UUID_RE } from "./validate";

/**
 * 리드 메일 캐시 (lead_emails)
 *  - Gmail에서 한 번 불러온 메일은 제목·헤더·미리보기·AI 요약을 저장하고 다시 불러오거나 다시 요약하지 않는다.
 *  - 본문은 저장하지 않는다 (요약할 때와 사용자가 메일을 열 때만 Gmail에서 읽음).
 *  - 메일함 소유자(user_id)별로 저장하고 본인 것만 보여준다.
 */

/** 한 번에 요약할 최대 메일 수 / OpenAI 1회 호출에 묶는 메일 수 / 요약에 넣는 본문 길이 */
export const SUMMARIZE_MAX = 20;
const SUMMARY_BATCH = 10;
const SUMMARY_BODY_CHARS = 2500;
const SUMMARY_MAX_CHARS = 300;
/** 화면·Assistant에서 읽는 저장 메일 상한 */
const LIST_LIMIT = 200;
const CONTEXT_SCAN_LIMIT = 500;

const COLUMNS = `
  e.gmail_id AS id, e.thread_id AS "threadId", e.subject, e.from_header AS "from", e.to_header AS "to",
  e.cc_header AS "cc", e.direction, e.sent_at AS "date", e.snippet, e.has_attachments AS "hasAttachments",
  e.summary, e.summary_status AS "summaryStatus"`;

type Row = Omit<StoredEmail, "date" | "unread" | "viaDomain"> & { date: Date };

const toStored = (r: Row, target: LeadTarget): StoredEmail => ({
  ...r,
  date: r.date.toISOString(),
  // 읽음 여부는 Gmail에서 계속 바뀌므로 저장하지 않는다
  unread: false,
  ...(involvesAddress(r, target.address) ? {} : { viaDomain: true }),
});

/**
 * 저장된 리드 메일 (최신순). 리드 이메일 주소가 바뀌었을 수 있으므로 현재 대상과 관계있는 메일만.
 */
export async function getStoredEmails(userId: string, leadId: string, target: LeadTarget): Promise<StoredEmail[]> {
  const { rows } = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM lead_emails e WHERE e.user_id = $1 AND e.lead_id = $2 ORDER BY e.sent_at DESC LIMIT $3`,
    [userId, leadId, LIST_LIMIT]
  );
  return rows.filter((r) => involvesTarget(r, target)).map((r) => toStored(r, target));
}

/**
 * Gmail 동기화: 목록(id)만 받아 아직 저장하지 않은 메일만 헤더를 읽어 저장한다.
 * pageToken이 없으면 최신 한 페이지, 있으면 그 이전 페이지.
 */
export async function syncLeadEmails(
  user: TokenUser,
  leadId: string,
  target: LeadTarget,
  pageToken?: string
): Promise<{ added: number; nextPageToken: string | null }> {
  const { ids, nextPageToken } = await listLeadMessageIds(user, [target], { pageToken });
  if (ids.length === 0) return { added: 0, nextPageToken };

  const { rows } = await pool.query<{ id: string }>(
    "SELECT gmail_id AS id FROM lead_emails WHERE user_id = $1 AND lead_id = $2 AND gmail_id = ANY($3::text[])",
    [user.id, leadId, ids]
  );
  const known = new Set(rows.map((r) => r.id));
  const fresh = await getMessagesMeta(user, ids.filter((id) => !known.has(id)), [target]);
  if (fresh.length === 0) return { added: 0, nextPageToken };

  const col = <K extends keyof (typeof fresh)[number]>(k: K) => fresh.map((m) => m[k]);
  const res = await pool.query(
    `INSERT INTO lead_emails (user_id, lead_id, gmail_id, thread_id, subject, from_header, to_header, cc_header,
                              direction, sent_at, snippet, has_attachments)
     SELECT $1::uuid, $2::uuid, u.*
     FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                 $10::timestamptz[], $11::text[], $12::boolean[]) AS u
     ON CONFLICT (user_id, lead_id, gmail_id) DO NOTHING`,
    [
      user.id, leadId, col("id"), col("threadId"), col("subject"), col("from"), col("to"), col("cc"),
      col("direction"), col("date"), col("snippet"), col("hasAttachments"),
    ]
  );
  return { added: res.rowCount ?? 0, nextPageToken };
}

const SUMMARY_PROMPT = `당신은 B2B 영업 담당자를 돕는 비서입니다. 각 이메일을 영업 관점에서 한국어 1~2문장(최대 150자)으로 요약하세요.
- 고객의 요청·질문, 금액·수량, 일정, 결정 사항, 다음에 할 일을 우선해서 담으세요.
- 인사말·서명·회사 소개 문구는 빼세요. 본문이 비어 있으면 제목으로 요약하세요.
- direction이 sent면 영업 담당자(나)가 보낸 메일, received면 고객 쪽에서 받은 메일입니다.
- 이메일 주소·전화번호는 [이메일]/[전화번호]로 가려져 있습니다.
JSON 객체로만 답하세요: {"items":[{"key":"1","summary":"..."}]}`;

interface SummaryInput {
  key: string;
  direction: string;
  date: string;
  from: string;
  subject: string;
  body: string;
}

async function summarizeBatch(items: SummaryInput[]): Promise<Map<string, string>> {
  const content = await chatCompletion(
    [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: JSON.stringify(items) },
    ],
    { maxTokens: 2000, json: true, timeoutMs: 45_000 }
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AiError("AI 요약 결과를 읽지 못했습니다", 502);
  }
  const list = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).items : null;
  const out = new Map<string, string>();
  for (const it of Array.isArray(list) ? list : []) {
    const r = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
    const key = typeof r.key === "string" ? r.key : typeof r.key === "number" ? String(r.key) : "";
    const summary = typeof r.summary === "string" ? maskPii(r.summary.trim()).slice(0, SUMMARY_MAX_CHARS) : "";
    if (key && summary) out.set(key, summary);
  }
  return out;
}

/**
 * 아직 요약하지 않은 메일을 요약해 저장한다 (최신순 최대 max건).
 * 본문은 Gmail에서 읽어 OpenAI로 보내고(인용된 이전 메일 제외, 이메일·전화번호 가림) 저장하지 않는다.
 * retryFailed면 요약에 실패했던 메일도 다시 시도. OpenAI 호출이 실패하면 pending으로 남기고 예외를 던진다.
 */
export async function summarizePending(
  user: TokenUser,
  opts: { leadId?: string; max?: number; retryFailed?: boolean } = {}
): Promise<number> {
  const { rows } = await pool.query<Row & { rowId: string }>(
    `SELECT e.id AS "rowId", ${COLUMNS} FROM lead_emails e
     WHERE e.user_id = $1 AND ($2::uuid IS NULL OR e.lead_id = $2)
       AND e.summary_status = ANY($3::text[])
     ORDER BY e.sent_at DESC LIMIT $4`,
    [user.id, opts.leadId ?? null, opts.retryFailed ? ["pending", "failed"] : ["pending"], opts.max ?? SUMMARIZE_MAX]
  );
  if (rows.length === 0) return 0;

  // 같은 메일이 여러 리드(같은 회사 도메인)에 저장돼 있을 수 있어 Gmail 본문은 한 번만 읽는다
  const bodies = new Map<string, string>();
  await Promise.all(
    [...new Set(rows.map((r) => r.id))].map(async (id) => {
      const msg = await getMessage(user, id).catch(() => null);
      bodies.set(id, msg?.body ? stripQuoted(msg.body) : "");
    })
  );

  let done = 0;
  for (let i = 0; i < rows.length; i += SUMMARY_BATCH) {
    const batch = rows.slice(i, i + SUMMARY_BATCH);
    const inputs: SummaryInput[] = batch.map((r, j) => ({
      key: String(j + 1),
      direction: r.direction,
      date: kstDateTime(r.date),
      from: maskPii(displayNames(r.from)),
      subject: maskPii(r.subject),
      body: maskPii((bodies.get(r.id) || r.snippet).slice(0, SUMMARY_BODY_CHARS)),
    }));
    const result = await summarizeBatch(inputs);
    const ids = batch.map((r) => r.rowId);
    const summaries = batch.map((_, j) => result.get(String(j + 1)) ?? "");
    await pool.query(
      `UPDATE lead_emails e SET summary = u.summary,
              summary_status = CASE WHEN u.summary = '' THEN 'failed' ELSE 'done' END, updated_at = now()
       FROM unnest($1::uuid[], $2::text[]) AS u(id, summary)
       WHERE e.id = u.id AND e.user_id = $3`,
      [ids, summaries, user.id]
    );
    done += summaries.filter(Boolean).length;
  }
  return done;
}

/** Gmail 연동 해제 시 저장된 메일 정보 삭제 */
export async function deleteUserEmails(userId: string) {
  await pool.query("DELETE FROM lead_emails WHERE user_id = $1", [userId]);
}

// ───────────── AI Assistant: 질문과 관련된 저장 메일 찾기 ─────────────

interface ContextRow extends Row {
  leadId: string;
  company: string;
  contact: string;
  leadEmail: string;
}

export interface EmailContext {
  leadId: string;
  company: string;
  date: string;
  direction: "sent" | "received";
  /** contact: 리드 담당자 본인, colleague: 같은 회사 도메인의 다른 사람 */
  with: "contact" | "colleague";
  from: string;
  subject: string;
  summary: string;
}

const STOP_WORDS = new Set([
  "이메일", "메일", "최근", "요약", "요약해줘", "알려줘", "해줘", "보여줘", "정리", "정리해줘", "내용", "관련", "어떤",
  "무엇", "있어", "있나", "있나요", "있는지", "주고받은", "받은", "보낸", "고객", "리드", "회사", "언제", "어떻게",
  "했어", "했나요", "대한", "대해", "그리고", "지금", "현재", "상황", "확인", "확인해줘",
]);
const PARTICLE_RE = /(으로|에서|에게|한테|께서|까지|부터|이랑|하고|은|는|이|가|을|를|에|의|와|과|도|로|랑|만)$/;

/** 질문 → 검색 키워드 (조사·불용어 제거, 2글자 이상) */
export function questionKeywords(question: string): string[] {
  const words = question.toLowerCase().split(/[^0-9a-z가-힣]+/);
  const out = new Set<string>();
  for (const w of words) {
    const t = w.length > 2 ? w.replace(PARTICLE_RE, "") : w;
    if (t.length >= 2 && !STOP_WORDS.has(t) && !STOP_WORDS.has(w)) out.add(t);
  }
  return [...out];
}

const toContext = (r: ContextRow): EmailContext => ({
  leadId: r.leadId,
  company: r.company,
  date: kstDateTime(r.date),
  direction: r.direction,
  with: involvesAddress(r, r.leadEmail.trim().toLowerCase()) ? "contact" : "colleague",
  from: maskPii(displayNames(r.from)) || "(이름 없음)",
  subject: maskPii(r.subject),
  summary: maskPii(r.summary || r.snippet),
});

/**
 * 질문과 관련된 저장 메일만 고른다 (본문 없이 제목·요약).
 *  - 질문에 회사명·담당자 이름이 나온 리드의 메일
 *  - 제목·요약에 질문 키워드가 들어간 메일
 *  - 관련 메일이 없고 메일 자체를 묻는 질문이면 최근 메일 몇 건
 */
export async function findRelevantEmails(user: { id: string; email: string }, question: string, limit = 30): Promise<EmailContext[]> {
  const { rows } = await pool.query<ContextRow>(
    `SELECT ${COLUMNS}, e.lead_id AS "leadId", l.company, l.contact, l.email AS "leadEmail"
     FROM lead_emails e JOIN leads l ON l.id = e.lead_id
     WHERE e.user_id = $1 ORDER BY e.sent_at DESC LIMIT $2`,
    [user.id, CONTEXT_SCAN_LIMIT]
  );
  const targets = new Map<string, LeadTarget | null>();
  const current = rows.filter((r) => {
    if (!targets.has(r.leadId)) targets.set(r.leadId, leadTarget(r.leadEmail, user.email));
    const t = targets.get(r.leadId);
    return t ? involvesTarget(r, t) : false;
  });

  const q = question.toLowerCase();
  const keywords = questionKeywords(question);
  const mentioned = (r: ContextRow) =>
    (r.company.length >= 2 && q.includes(r.company.toLowerCase())) || (r.contact.length >= 2 && q.includes(r.contact.toLowerCase()));

  const scored = current
    .map((r) => {
      const text = `${r.subject} ${r.summary} ${r.snippet}`.toLowerCase();
      const hits = keywords.filter((k) => text.includes(k)).length;
      return { r, score: (mentioned(r) ? 10 : 0) + hits * 2 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.date.getTime() - a.r.date.getTime());

  if (scored.length === 0 && /메일|email|답장|회신/i.test(question)) return current.slice(0, 10).map(toContext);
  return scored.slice(0, limit).map((x) => toContext(x.r));
}

/** Assistant 도구: 저장 메일 검색 (리드·키워드·기간) */
export async function searchStoredEmails(
  user: { id: string; email: string },
  opts: { leadId?: string; query?: string; days?: number; max: number }
): Promise<EmailContext[]> {
  const { rows } = await pool.query<ContextRow>(
    `SELECT ${COLUMNS}, e.lead_id AS "leadId", l.company, l.contact, l.email AS "leadEmail"
     FROM lead_emails e JOIN leads l ON l.id = e.lead_id
     WHERE e.user_id = $1 AND ($2::uuid IS NULL OR e.lead_id = $2)
       AND ($3::int IS NULL OR e.sent_at > now() - make_interval(days => $3::int))
     ORDER BY e.sent_at DESC LIMIT $4`,
    [user.id, opts.leadId ?? null, opts.days ?? null, CONTEXT_SCAN_LIMIT]
  );
  const keywords = opts.query ? questionKeywords(opts.query) : [];
  return rows
    .filter((r) => {
      const t = leadTarget(r.leadEmail, user.email);
      if (!t || !involvesTarget(r, t)) return false;
      if (keywords.length === 0) return true;
      const text = `${r.subject} ${r.summary} ${r.snippet}`.toLowerCase();
      return keywords.some((k) => text.includes(k));
    })
    .slice(0, opts.max)
    .map(toContext);
}

// ───────────── Route Handler 공통 ─────────────

/** 리드 id → 검색 대상. 실패하면 화면에 보여줄 응답 */
export async function resolveLeadTarget(
  leadId: string,
  userEmail: string
): Promise<{ ok: true; target: LeadTarget } | { ok: false; response: Response }> {
  const fail = (error: string, status: number, code?: string) => ({
    ok: false as const,
    response: Response.json({ error, ...(code ? { code } : {}) }, { status }),
  });
  if (!UUID_RE.test(leadId)) return fail("리드를 찾을 수 없습니다", 404);
  const { rows } = await pool.query<{ email: string }>("SELECT email FROM leads WHERE id = $1", [leadId]);
  if (!rows[0]) return fail("리드를 찾을 수 없습니다", 404);
  if (!rows[0].email.trim()) return fail("리드에 이메일 주소가 없습니다", 400, "no_email");
  const target = leadTarget(rows[0].email, userEmail);
  if (!target) return fail("리드 이메일 주소 형식이 올바르지 않습니다", 400, "bad_email");
  return { ok: true, target };
}

/** 이메일 탭 응답 본문 */
export async function leadEmailsBody(
  userId: string,
  leadId: string,
  target: LeadTarget,
  extra: { nextPageToken?: string | null; added?: number } = {}
): Promise<LeadEmails> {
  const messages = await getStoredEmails(userId, leadId, target);
  return {
    address: target.address,
    domain: target.domain,
    messages,
    nextPageToken: extra.nextPageToken ?? null,
    ...(extra.added !== undefined ? { added: extra.added } : {}),
    pending: messages.filter((m) => m.summaryStatus === "pending").length,
  };
}
