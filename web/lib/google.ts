import "server-only";
import { createHash } from "node:crypto";
import { featureState, type GoogleFeature, type SessionUser } from "./auth";
import { decrypt, randomToken } from "./crypto";
import { pool } from "./db";

/**
 * 구글 OAuth 2.0 (SDK 없이 fetch)
 *  - 로그인: openid email profile
 *  - 캘린더 연동(설정 → Google 캘린더): 로그인 권한에 캘린더 권한을 추가로 받는다 (include_granted_scopes)
 *  - Gmail 연동(설정 → Gmail): 같은 방식으로 Gmail 읽기 권한을 추가로 받는다
 * 리프레시 토큰은 사용자당 하나(받은 권한 전체)를 두 기능이 같이 쓰고, 기능별 사용 여부는 users.*_enabled로 구분한다.
 * 리디렉션 URI는 하나(/api/auth/callback)만 쓰고, 어떤 흐름인지는 state 쿠키의 purpose로 구분한다.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const LOGIN_SCOPES = ["openid", "email", "profile"];
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
export const CALENDAR_EVENTS_SCOPE = CALENDAR_SCOPES[0];
/** 메일 읽기 전용 (보내기·수정·삭제 권한 없음) */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export const OAUTH_COOKIE = "crm_oauth";
export const CALLBACK_PATH = "/api/auth/callback";

/** state 쿠키: 콜백 경로에서만 읽고 10분 뒤 만료 */
export const oauthCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
  maxAge: 600,
});

/** 사용자에게 보여줄 한국어 메시지 + HTTP 상태 코드 */
export class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly code = "") {
    super(message);
  }
}

function clientConfig() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new GoogleError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET이 설정되지 않았습니다", 503);
  return { id, secret };
}

/**
 * 앱 주소: APP_URL → (Vercel 운영) VERCEL_PROJECT_PRODUCTION_URL → 요청 주소
 * 콜백 URL은 구글 콘솔에 등록한 리디렉션 URI와 정확히 같아야 한다.
 */
export function appOrigin(reqUrl: string): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return new URL(reqUrl).origin;
}

export type OAuthPurpose = "login" | GoogleFeature;

/** state 쿠키에 보관하는 값 (10분) */
export interface OAuthState {
  state: string;
  verifier: string;
  purpose: OAuthPurpose;
  next: string;
}

/** 로그인 후 돌아갈 경로: 같은 사이트 내부 경로만 허용 (오픈 리다이렉트 방지) */
export const safeNext = (v: string | null | undefined, fallback = "/") =>
  v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/api/") ? v.slice(0, 200) : fallback;

/** 구글 동의 화면 URL + state 쿠키 값 */
export function buildAuthRequest(
  reqUrl: string,
  purpose: OAuthPurpose,
  opts: { next: string; loginHint?: string }
): { url: string; cookie: OAuthState } {
  const { id } = clientConfig();
  const state = randomToken(16);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: appOrigin(reqUrl) + CALLBACK_PATH,
    response_type: "code",
    scope: [...LOGIN_SCOPES, ...(purpose === "calendar" ? CALENDAR_SCOPES : purpose === "gmail" ? [GMAIL_SCOPE] : [])].join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
  });
  if (purpose !== "login") {
    // 리프레시 토큰을 받으려면 offline + consent가 필요하다
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  } else {
    params.set("prompt", "select_account");
  }
  if (opts.loginHint) params.set("login_hint", opts.loginHint);

  return { url: `${AUTH_URL}?${params}`, cookie: { state, verifier, purpose, next: opts.next } };
}

export function parseOAuthState(raw: string | undefined): OAuthState | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const r = v as Record<string, unknown>;
    if (typeof r.state !== "string" || typeof r.verifier !== "string" || typeof r.next !== "string") return null;
    if (r.purpose !== "login" && r.purpose !== "calendar" && r.purpose !== "gmail") return null;
    return { state: r.state, verifier: r.verifier, purpose: r.purpose, next: r.next };
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new GoogleError("구글에 연결할 수 없습니다", 502);
  });
  const body: unknown = await res.json().catch(() => null);
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!res.ok) {
    const code = typeof b.error === "string" ? b.error : "";
    // 토큰 값은 로그에 남기지 않는다
    console.error("[google] token error", res.status, code);
    if (code === "invalid_grant") throw new GoogleError("구글 인증이 만료되었습니다", 401, code);
    throw new GoogleError("구글 인증에 실패했습니다", 502, code);
  }
  if (typeof b.access_token !== "string") throw new GoogleError("구글 인증 응답이 올바르지 않습니다", 502);
  return {
    access_token: b.access_token,
    expires_in: typeof b.expires_in === "number" ? b.expires_in : 3600,
    refresh_token: typeof b.refresh_token === "string" ? b.refresh_token : undefined,
    scope: typeof b.scope === "string" ? b.scope : undefined,
    id_token: typeof b.id_token === "string" ? b.id_token : undefined,
  };
}

/** 인가 코드 → 토큰 (PKCE) */
export async function exchangeCode(reqUrl: string, code: string, verifier: string): Promise<TokenResponse> {
  const { id, secret } = clientConfig();
  return tokenRequest({
    code,
    client_id: id,
    client_secret: secret,
    redirect_uri: appOrigin(reqUrl) + CALLBACK_PATH,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

/**
 * id_token 확인. 구글 토큰 엔드포인트에서 TLS로 직접 받은 값이므로 서명 검증 대신
 * iss·aud·exp·email_verified를 확인한다 (OpenID Connect Core 3.1.3.7).
 */
export function readIdToken(idToken: string | undefined): GoogleIdentity {
  const fail = () => new GoogleError("구글 계정 정보를 확인하지 못했습니다", 502);
  const part = idToken?.split(".")[1];
  if (!part) throw fail();
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw fail();
  }
  const { id } = clientConfig();
  const issOk = p.iss === "https://accounts.google.com" || p.iss === "accounts.google.com";
  const expOk = typeof p.exp === "number" && p.exp * 1000 > Date.now();
  if (!issOk || p.aud !== id || !expOk || typeof p.sub !== "string" || typeof p.email !== "string") throw fail();
  if (p.email_verified !== true) throw new GoogleError("이메일이 확인되지 않은 구글 계정입니다", 403);
  return {
    sub: p.sub,
    email: p.email.toLowerCase(),
    name: typeof p.name === "string" ? p.name : "",
    picture: typeof p.picture === "string" ? p.picture : "",
  };
}

// 액세스 토큰 메모리 캐시 (DB에는 저장하지 않음). 서버리스 인스턴스마다 따로 유지된다.
const globalForGoogle = globalThis as unknown as { googleTokens?: Map<string, { token: string; exp: number }> };
const tokenCache = (globalForGoogle.googleTokens ??= new Map());

export function forgetAccessToken(userId: string) {
  tokenCache.delete(userId);
}

export type TokenUser = Pick<SessionUser, "id" | "refreshToken" | "calendarExpired" | "calendarEnabled" | "gmailEnabled">;

const FEATURE_LABEL: Record<GoogleFeature, string> = { calendar: "캘린더", gmail: "Gmail" };

/** 기능 연동이 끊긴 상태(409) 예외 */
export function notConnectedError(feature: GoogleFeature, expired: boolean): GoogleError {
  const label = FEATURE_LABEL[feature];
  return expired
    ? new GoogleError(`${label} 연동이 만료되었습니다. 설정에서 다시 연동하세요`, 409, "expired")
    : new GoogleError(
        feature === "gmail"
          ? "Gmail이 연동되지 않았습니다. 설정에서 Gmail 연동을 진행하세요"
          : "캘린더가 연동되지 않았습니다. 설정에서 Google 연동을 진행하세요",
        409,
        "not_connected"
      );
}

/** 사용자의 구글 액세스 토큰 (feature 기능을 연동했을 때만). 리프레시 토큰이 만료·폐기됐으면 연동 만료로 표시하고 예외 */
export async function getAccessToken(user: TokenUser, feature: GoogleFeature = "calendar"): Promise<string> {
  const state = featureState(user, feature);
  if (state !== "connected") throw notConnectedError(feature, state === "expired");

  const cached = tokenCache.get(user.id);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const refresh = user.refreshToken ? decrypt(user.refreshToken) : null;
  if (!refresh) {
    await markExpired(user.id);
    throw new GoogleError(`${FEATURE_LABEL[feature]} 연동 정보를 읽지 못했습니다. 설정에서 다시 연동하세요`, 409, "expired");
  }

  const { id, secret } = clientConfig();
  try {
    const t = await tokenRequest({ refresh_token: refresh, client_id: id, client_secret: secret, grant_type: "refresh_token" });
    tokenCache.set(user.id, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
    return t.access_token;
  } catch (e) {
    if (e instanceof GoogleError && e.code === "invalid_grant") {
      await markExpired(user.id);
      throw notConnectedError(feature, true);
    }
    throw e;
  }
}

async function markExpired(userId: string) {
  forgetAccessToken(userId);
  await pool.query("UPDATE users SET calendar_expired = true, updated_at = now() WHERE id = $1", [userId]);
}

/** 구글에 토큰 폐기 요청 (실패해도 무시: 로컬 연동 정보는 어차피 지운다) */
export async function revokeToken(token: string) {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

/**
 * 기능별 연동 해제. 다른 기능이 아직 연동돼 있으면 토큰은 남기고 이 기능만 끈다
 * (구글 토큰 폐기는 앱에 준 권한 전체를 없애므로). 마지막 기능이면 구글에 토큰 폐기 요청 후 삭제.
 */
export async function disconnectFeature(user: TokenUser, feature: GoogleFeature) {
  const otherEnabled = feature === "gmail" ? user.calendarEnabled : user.gmailEnabled;
  if (user.refreshToken && otherEnabled) {
    await pool.query(
      feature === "gmail"
        ? "UPDATE users SET gmail_enabled = false, updated_at = now() WHERE id = $1"
        : "UPDATE users SET calendar_enabled = false, calendar_id = 'primary', updated_at = now() WHERE id = $1",
      [user.id]
    );
    return;
  }
  const refresh = user.refreshToken ? decrypt(user.refreshToken) : null;
  if (refresh) await revokeToken(refresh);
  await pool.query(
    `UPDATE users SET google_refresh_token = NULL, google_scopes = '', calendar_expired = false,
            calendar_enabled = false, gmail_enabled = false, calendar_id = 'primary', updated_at = now()
     WHERE id = $1`,
    [user.id]
  );
  forgetAccessToken(user.id);
}

/** Route Handler 공통: 구글 에러 → { error, code } 응답, 그 외 예외는 다시 던진다 */
export function googleErrorResponse(e: unknown): Response {
  if (e instanceof GoogleError) {
    return Response.json({ error: e.message, code: e.code || undefined }, { status: e.status });
  }
  throw e;
}

export const unauthorized = () => Response.json({ error: "로그인이 필요합니다" }, { status: 401 });
