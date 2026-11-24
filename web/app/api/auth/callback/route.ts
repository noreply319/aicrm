import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSession, getSessionUser, isAllowedEmail, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { pool } from "@/lib/db";
import {
  CALENDAR_EVENTS_SCOPE, exchangeCode, forgetAccessToken, GMAIL_SCOPE, GoogleError, OAUTH_COOKIE,
  parseOAuthState, readIdToken, safeNext, type OAuthPurpose,
} from "@/lib/google";

export const dynamic = "force-dynamic";

/**
 * 구글 OAuth 콜백 (로그인·캘린더·Gmail 연동 공용)
 *  - login: 허용 이메일 확인 → 사용자 저장 → 세션 쿠키 발급
 *  - calendar / gmail: 로그인한 계정과 같은 구글 계정인지 확인 → 리프레시 토큰 암호화 저장 + 기능 사용 표시
 *    (include_granted_scopes라 새 토큰에는 전에 받은 권한도 들어 있다. 다른 기능은 권한이 남아 있을 때만 유지)
 * 실패하면 에러 코드와 함께 /login 또는 /settings로 돌려보낸다 (메시지는 화면에서 표시).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const store = await cookies();
  const st = parseOAuthState(store.get(OAUTH_COOKIE)?.value);

  const go = (path: string) => {
    const res = NextResponse.redirect(new URL(path, req.url));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth" });
    return res;
  };
  const fail = (purpose: OAuthPurpose | undefined, code: string) =>
    go(purpose === "calendar" || purpose === "gmail" ? `/settings?${purpose}_error=${code}` : `/login?error=${code}`);

  if (url.searchParams.get("error")) return fail(st?.purpose, "denied");
  const code = url.searchParams.get("code");
  if (!st || !code || st.state !== url.searchParams.get("state")) return fail(st?.purpose, "state");

  try {
    const tokens = await exchangeCode(req.url, code, st.verifier);
    const identity = readIdToken(tokens.id_token);
    if (!isAllowedEmail(identity.email)) return fail(st.purpose, "not_allowed");

    if (st.purpose === "login") {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (google_sub, email, name, picture) VALUES ($1, $2, $3, $4)
         ON CONFLICT (google_sub) DO UPDATE SET email = $2, name = $3, picture = $4, updated_at = now()
         RETURNING id`,
        [identity.sub, identity.email, identity.name, identity.picture]
      );
      const session = await createSession(rows[0].id);
      const res = go(safeNext(st.next));
      res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expires));
      return res;
    }

    // 캘린더 / Gmail 연동
    const purpose = st.purpose;
    const user = await getSessionUser();
    if (!user) return go("/login?next=/settings");
    if (user.googleSub !== identity.sub) return fail(purpose, "account_mismatch");
    const scopes = tokens.scope ?? "";
    const granted = scopes.split(" ");
    const hasCalendar = granted.includes(CALENDAR_EVENTS_SCOPE);
    const hasGmail = granted.includes(GMAIL_SCOPE);
    if (!(purpose === "calendar" ? hasCalendar : hasGmail)) return fail(purpose, "scope");
    if (!tokens.refresh_token && !user.refreshToken) return fail(purpose, "no_refresh");

    // 이번에 연동한 기능은 켜고, 다른 기능은 기존에 켜져 있었고 권한도 남아 있을 때만 유지
    const calendarEnabled = purpose === "calendar" || (user.calendarEnabled && hasCalendar);
    const gmailEnabled = purpose === "gmail" || (user.gmailEnabled && hasGmail);
    await pool.query(
      `UPDATE users SET google_refresh_token = coalesce($2, google_refresh_token), google_scopes = $3,
              calendar_expired = false, calendar_enabled = $4, gmail_enabled = $5, updated_at = now()
       WHERE id = $1`,
      [user.id, tokens.refresh_token ? encrypt(tokens.refresh_token) : null, scopes, calendarEnabled, gmailEnabled]
    );
    forgetAccessToken(user.id);
    return go(`/settings?${purpose}=connected`);
  } catch (e) {
    if (e instanceof GoogleError) {
      console.error("[auth] callback", e.message);
      return fail(st.purpose, e.status === 503 ? "config" : "google");
    }
    throw e;
  }
}
