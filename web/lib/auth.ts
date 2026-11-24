import "server-only";
import { cookies, headers } from "next/headers";
import { randomToken, sha256 } from "./crypto";
import { pool } from "./db";

/**
 * 로그인 세션 (DB 세션 + httpOnly 쿠키)
 *  - 쿠키에는 랜덤 토큰, DB(sessions.id)에는 그 SHA-256 해시만 저장한다.
 *  - proxy.ts가 모든 요청에서 세션을 확인하고, 통과한 요청에 사용자 id 헤더(USER_HEADER)를 붙인다.
 */

export const SESSION_COOKIE = "crm_session";
/** 세션 유효기간: 테스트 상태 구글 앱의 리프레시 토큰 수명(7일)과 맞춘다 */
export const SESSION_DAYS = 7;
/** proxy.ts가 검증한 사용자 id를 Route Handler로 넘기는 요청 헤더 (외부에서 보낸 값은 proxy가 지운다) */
export const USER_HEADER = "x-crm-user-id";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  picture: string;
  /** 암호화된 구글 리프레시 토큰 (캘린더·Gmail 공용). null = 구글 기능 미연동 */
  refreshToken: string | null;
  /** 토큰 만료·폐기 (캘린더·Gmail 공통) */
  calendarExpired: boolean;
  calendarEnabled: boolean;
  gmailEnabled: boolean;
  calendarId: string;
  googleSub: string;
  /** 구글에서 받은 권한 (공백 구분) */
  googleScopes: string;
}

export const USER_COLUMNS = `
  u.id, u.email, u.name, u.picture, u.google_refresh_token AS "refreshToken",
  u.calendar_expired AS "calendarExpired", u.calendar_id AS "calendarId", u.google_sub AS "googleSub",
  u.calendar_enabled AS "calendarEnabled", u.gmail_enabled AS "gmailEnabled", u.google_scopes AS "googleScopes"`;

export type GoogleFeature = "calendar" | "gmail";
export type ConnectionState = "connected" | "expired" | "none";

type FeatureUser = Pick<SessionUser, "refreshToken" | "calendarExpired" | "calendarEnabled" | "gmailEnabled">;

/** 기능별 연동 상태: 연동한 기능이 아니면 none, 공용 토큰이 만료됐으면 expired */
export function featureState(user: FeatureUser | null | undefined, feature: GoogleFeature): ConnectionState {
  if (!user?.refreshToken) return "none";
  const enabled = feature === "gmail" ? user.gmailEnabled : user.calendarEnabled;
  if (!enabled) return "none";
  return user.calendarExpired ? "expired" : "connected";
}

/** ALLOWED_EMAILS(쉼표 구분)에 있는 이메일만 로그인 허용 */
export function isAllowedEmail(email: string): boolean {
  const allowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

export const sessionCookieOptions = (expires: Date) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  expires,
});

/** 세션 생성 → 쿠키에 넣을 토큰 반환. 만료된 세션도 함께 정리한다. */
export async function createSession(userId: string): Promise<{ token: string; expires: Date }> {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query("DELETE FROM sessions WHERE expires_at < now()");
  await pool.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [sha256(token), userId, expires]);
  return { token, expires };
}

export async function deleteSession(token: string) {
  await pool.query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
}

/** 쿠키 토큰 → 사용자. 만료됐거나 허용 목록에서 빠진 계정이면 null */
export async function findSessionUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await pool.query<SessionUser>(
    `SELECT ${USER_COLUMNS}
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  const user = rows[0];
  return user && isAllowedEmail(user.email) ? user : null;
}

/** Route Handler에서 현재 로그인 사용자 조회 (쿠키로 다시 검증) */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return findSessionUser(store.get(SESSION_COOKIE)?.value);
}

/** proxy.ts가 붙인 사용자 id (요청 밖에서 호출되면 null) */
export async function requestUserId(): Promise<string | null> {
  try {
    const id = (await headers()).get(USER_HEADER);
    return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}
