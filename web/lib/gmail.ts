import "server-only";
import { FREE_MAIL_DOMAINS } from "./constants";
import { forgetAccessToken, getAccessToken, GoogleError, type TokenUser } from "./google";
import type { EmailDetail, EmailSummary } from "./types";

/**
 * Gmail REST API (SDK 없이 fetch, 읽기 전용 gmail.readonly)
 * 리드 이메일 주소로 주고받은 메일을 검색한다. 메일은 DB에 저장하지 않고 매번 Gmail에서 읽는다.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** 한 번에 보여줄 메일 수 */
export const PAGE_SIZE = 20;
/** 화면에 보여줄 본문 최대 길이 */
const BODY_MAX_CHARS = 50_000;

/** 검색에 쓸 수 있는 이메일 주소 (Gmail 검색 연산자로 해석될 문자 제외) */
const ADDRESS_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export const isSearchableAddress = (v: string) => v.length <= 254 && ADDRESS_RE.test(v);
/** Gmail 메시지 id (16진수) */
export const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Gmail API 호출: 401이면 토큰을 새로 받아 1회, 429/5xx면 1회 재시도 */
async function gfetch(user: TokenUser, path: string, attempt = 0): Promise<unknown> {
  const token = await getAccessToken(user, "gmail");
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new GoogleError(timeout ? "Gmail 응답 시간이 초과되었습니다" : "Gmail에 연결할 수 없습니다", 502, timeout ? "timeout" : "");
  });

  if ((res.status === 401 || res.status === 429 || res.status >= 500) && attempt === 0) {
    if (res.status === 401) forgetAccessToken(user.id);
    return gfetch(user, path, 1);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // 원인 판별은 전체 응답으로 (reason 코드가 긴 message 뒤에 있어 잘라서 보면 놓친다), 로그만 잘라서 남긴다
    const reason = JSON.stringify(body) ?? "";
    // 검색어·메일 내용은 로그에 남기지 않는다
    console.error("[gmail] error", res.status, path.split("?")[0].replace(/\/messages\/.+/, "/messages/:id"), reason.slice(0, 300));
    if (res.status === 404) throw new GoogleError("메일을 찾을 수 없습니다", 404, "not_found");
    if (res.status === 403 && reason.includes("insufficient")) {
      throw new GoogleError("Gmail 권한이 부족합니다. 설정에서 다시 연동하세요 (동의 화면에서 Gmail 권한 체크)", 403, "scope");
    }
    if (res.status === 403 && (reason.includes("accessNotConfigured") || reason.includes("SERVICE_DISABLED"))) {
      throw new GoogleError("Gmail API가 사용 설정되지 않았습니다 (Google Cloud Console 확인)", 503);
    }
    if (res.status === 429 || reason.includes("rateLimit")) throw new GoogleError("Gmail 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요", 429);
    throw new GoogleError("Gmail 요청을 처리하지 못했습니다", 502);
  }
  return body;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const s = (v: unknown) => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * 리드 검색 대상: 담당자 주소 + (회사 도메인이면) 같은 도메인 전체.
 * 무료 메일 도메인이나 내 계정과 같은 도메인(사내 메일)은 도메인 검색에서 뺀다.
 */
export interface LeadTarget {
  address: string;
  domain: string | null;
}

export function leadTarget(email: string, myEmail: string): LeadTarget | null {
  const address = email.trim().toLowerCase();
  if (!isSearchableAddress(address)) return null;
  const domain = address.split("@")[1];
  const myDomain = myEmail.trim().toLowerCase().split("@")[1] ?? "";
  return { address, domain: FREE_MAIL_DOMAINS.has(domain) || domain === myDomain ? null : domain };
}

/** 검색어: {from:x to:x cc:x bcc:x ...} (중괄호 = OR). 도메인이 있으면 @도메인으로 담당자 주소도 포함된다 */
function targetQuery(targets: LeadTarget[]): string {
  const terms = targets.map((t) => (t.domain ? `@${t.domain}` : t.address));
  return `{${[...new Set(terms)].flatMap((x) => [`from:${x}`, `to:${x}`, `cc:${x}`, `bcc:${x}`]).join(" ")}}`;
}

/** 추가 검색어는 괄호로 묶어 리드 조건과 AND로만 붙인다 (그룹·따옴표 문자 제거) */
function extraQuery(q: string | undefined): string {
  const cleaned = (q ?? "").replace(/[(){}"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return cleaned ? ` (${cleaned})` : "";
}

function header(headers: unknown, name: string): string {
  const h = arr(headers).map(obj).find((x) => s(x.name).toLowerCase() === name);
  return h ? s(h.value) : "";
}

/** HTML 엔티티 → 문자 (snippet과 HTML 본문에 쓰임) */
function decodeEntities(text: string): string {
  const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, code: string) => {
    const c = code.toLowerCase();
    if (c in named) return named[c];
    if (c.startsWith("#x")) return String.fromCodePoint(parseInt(c.slice(2), 16) || 32);
    if (c.startsWith("#")) return String.fromCodePoint(parseInt(c.slice(1), 10) || 32);
    return m;
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** base64url 본문 → 문자열 (EUC-KR 등 charset 반영, 모르면 UTF-8) */
function decodeBody(data: string, contentType: string): string {
  const bytes = Buffer.from(data, "base64url");
  const charset = /charset="?([^";\s]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

interface ParsedParts {
  plain: string[];
  html: string[];
  attachments: string[];
}

/** MIME 파트를 돌며 텍스트·HTML 본문과 첨부 파일명을 모은다 */
function walkParts(part: Record<string, unknown>, out: ParsedParts) {
  const mime = s(part.mimeType).toLowerCase();
  const filename = s(part.filename);
  const body = obj(part.body);
  if (filename) {
    out.attachments.push(filename);
  } else if (s(body.data) && (mime === "text/plain" || mime === "text/html")) {
    const text = decodeBody(s(body.data), header(part.headers, "content-type"));
    (mime === "text/plain" ? out.plain : out.html).push(text);
  }
  for (const child of arr(part.parts)) walkParts(obj(child), out);
}

function toSummary(raw: unknown): EmailSummary | null {
  const m = obj(raw);
  if (!s(m.id)) return null;
  const payload = obj(m.payload);
  const labels = arr(m.labelIds).map(s);
  const internal = Number(s(m.internalDate));
  const mixed = s(payload.mimeType).toLowerCase() === "multipart/mixed";
  return {
    id: s(m.id),
    threadId: s(m.threadId),
    subject: header(payload.headers, "subject") || "(제목 없음)",
    from: header(payload.headers, "from"),
    to: header(payload.headers, "to"),
    cc: header(payload.headers, "cc"),
    date: new Date(Number.isFinite(internal) && internal > 0 ? internal : Date.now()).toISOString(),
    snippet: decodeEntities(s(m.snippet)),
    direction: labels.includes("SENT") ? "sent" : "received",
    unread: labels.includes("UNREAD"),
    hasAttachments: mixed,
  };
}

type HeaderFields = Pick<EmailSummary, "from" | "to" | "cc"> & { bcc?: string };
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 메일 헤더(From/To/Cc/Bcc)에 주소가 들어 있는지 (앞뒤가 주소 문자가 아닌 정확한 일치) */
export function involvesAddress(m: HeaderFields, address: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9._%+'-])${escapeRe(address.toLowerCase())}($|[^a-z0-9.-])`);
  return [m.from, m.to, m.cc, m.bcc ?? ""].some((h) => re.test(h.toLowerCase()));
}

/** 메일 헤더에 @도메인 주소가 있는지 (sub.domain·domain.evil 같은 다른 도메인은 제외) */
export function involvesDomain(m: HeaderFields, domain: string): boolean {
  const re = new RegExp(`@${escapeRe(domain.toLowerCase())}($|[^a-z0-9.-])`);
  return [m.from, m.to, m.cc, m.bcc ?? ""].some((h) => re.test(h.toLowerCase()));
}

/** 리드 대상 메일인지 */
export const involvesTarget = (m: HeaderFields, t: LeadTarget) =>
  involvesAddress(m, t.address) || (t.domain !== null && involvesDomain(m, t.domain));

/**
 * 리드 담당자 주소·회사 도메인과 주고받은 메일 id 목록 (최신순). 스팸·휴지통은 제외된다.
 * opts.newerThanDays: 최근 N일, opts.query: 추가 검색어
 */
export async function listLeadMessageIds(
  user: TokenUser,
  targets: LeadTarget[],
  opts: { max?: number; pageToken?: string; query?: string; newerThanDays?: number } = {}
): Promise<{ ids: string[]; nextPageToken: string | null }> {
  if (targets.length === 0) return { ids: [], nextPageToken: null };
  const q =
    targetQuery(targets) +
    (opts.newerThanDays ? ` newer_than:${Math.max(1, Math.round(opts.newerThanDays))}d` : "") +
    extraQuery(opts.query);
  const params = new URLSearchParams({ q, maxResults: String(Math.min(opts.max ?? PAGE_SIZE, 50)) });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const list = obj(await gfetch(user, `/messages?${params}`));
  return {
    ids: arr(list.messages).map((x) => s(obj(x).id)).filter((id) => MESSAGE_ID_RE.test(id)),
    nextPageToken: s(list.nextPageToken) || null,
  };
}

/**
 * 메일 헤더·미리보기 (본문 제외). 지워진 메일이거나 대상 리드와 관계없는 메일이면 null
 * (Gmail 검색은 부분 일치라 헤더로 한 번 더 확인한다)
 */
export async function getMessagesMeta(user: TokenUser, ids: string[], targets: LeadTarget[]): Promise<EmailSummary[]> {
  const meta = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "To", "Cc", "Subject", "Date"]) meta.append("metadataHeaders", h);
  const messages = await Promise.all(
    ids.map((id) =>
      gfetch(user, `/messages/${id}?${meta}`).then(toSummary).catch((e: unknown) => {
        // 목록 사이에 지워진 메일은 건너뛴다
        if (e instanceof GoogleError && e.code === "not_found") return null;
        throw e;
      })
    )
  );
  return messages.filter((m): m is EmailSummary => m !== null && targets.some((t) => involvesTarget(m, t)));
}

/** 메일 본문 포함 상세. 없으면 null */
export async function getMessage(user: TokenUser, id: string): Promise<(EmailDetail & { bcc: string }) | null> {
  if (!MESSAGE_ID_RE.test(id)) return null;
  let raw: unknown;
  try {
    raw = await gfetch(user, `/messages/${id}?format=full`);
  } catch (e) {
    if (e instanceof GoogleError && e.code === "not_found") return null;
    throw e;
  }
  const summary = toSummary(raw);
  if (!summary) return null;
  const payload = obj(obj(raw).payload);
  const parts: ParsedParts = { plain: [], html: [], attachments: [] };
  walkParts(payload, parts);
  const text = parts.plain.length ? parts.plain.join("\n\n").replace(/\r\n/g, "\n").trim() : htmlToText(parts.html.join("\n"));
  return {
    ...summary,
    bcc: header(payload.headers, "bcc"),
    hasAttachments: parts.attachments.length > 0,
    attachments: parts.attachments,
    body: text.slice(0, BODY_MAX_CHARS),
  };
}

/**
 * 답장 본문에서 인용된 이전 메일을 잘라낸다 (AI 컨텍스트 절약).
 * "On ... wrote:", "...님이 작성:", "-----Original Message-----", "> " 인용줄 이후 제거
 */
export function stripQuoted(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(On .+wrote:|.+님이 작성:|-{2,}\s*(Original Message|원본 메시지|Forwarded message)\s*-{2,}|From: .+@.+|보낸 사람: .+)$/i.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** "홍길동 <a@b.com>" → "홍길동" (이름이 없으면 빈 문자열). 주소는 외부로 보내지 않기 위해 버린다 */
export function displayNames(headerValue: string): string {
  return headerValue
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((p) => p.replace(/<[^>]*>/g, "").replace(/"/g, "").trim())
    .map((p) => (p.includes("@") ? "" : p))
    .filter(Boolean)
    .join(", ");
}

/**
 * 메일 보내기 (gmail.send). raw는 RFC 2822 메시지 문자열 (lib/mime.ts의 buildMime).
 * 보낸 메일은 사용자 Gmail 보낸편지함에 남는다. 401이면 토큰을 새로 받아 1회 재시도.
 */
export async function sendRawMessage(user: TokenUser, raw: string, attempt = 0): Promise<{ id: string; threadId: string }> {
  const token = await getAccessToken(user, "gmail");
  const res = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url") }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e: unknown) => {
    const timeout = e instanceof Error && e.name === "TimeoutError";
    throw new GoogleError(timeout ? "Gmail 응답 시간이 초과되었습니다" : "Gmail에 연결할 수 없습니다", 502, timeout ? "timeout" : "");
  });
  if (res.status === 401 && attempt === 0) {
    forgetAccessToken(user.id);
    return sendRawMessage(user, raw, 1);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = JSON.stringify(body) ?? "";
    // 받는 사람·본문은 로그에 남기지 않는다
    console.error("[gmail] send error", res.status, reason.slice(0, 300));
    if (res.status === 403 && reason.includes("insufficient")) {
      throw new GoogleError("Gmail 발송 권한이 없습니다. 설정에서 Gmail을 다시 연동하세요", 403, "scope");
    }
    if (res.status === 403 && (reason.includes("accessNotConfigured") || reason.includes("SERVICE_DISABLED"))) {
      throw new GoogleError("Gmail API가 사용 설정되지 않았습니다 (Google Cloud Console 확인)", 503);
    }
    if (res.status === 400) throw new GoogleError("받는 사람 주소나 메일 내용이 올바르지 않습니다", 400, "invalid");
    if (res.status === 413) throw new GoogleError("첨부 파일이 너무 큽니다", 413);
    if (res.status === 429 || reason.includes("rateLimit")) throw new GoogleError("Gmail 발송 한도를 초과했습니다. 잠시 후 다시 시도하세요", 429);
    throw new GoogleError("메일을 보내지 못했습니다. 잠시 후 다시 시도하세요", 502);
  }
  const b = obj(body);
  return { id: s(b.id), threadId: s(b.threadId) };
}
