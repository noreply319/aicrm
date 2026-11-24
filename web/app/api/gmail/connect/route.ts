import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildAuthRequest, GoogleError, OAUTH_COOKIE, oauthCookieOptions, safeNext } from "@/lib/google";

export const dynamic = "force-dynamic";

/**
 * 설정 → Gmail 연동: 로그인한 계정에 Gmail 읽기·보내기 권한을 추가로 받는다.
 * ?next=/contracts?doc=… 처럼 돌아갈 화면을 지정할 수 있다 (기본: 설정)
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/settings", req.url));
  try {
    const { url, cookie } = buildAuthRequest(req.url, "gmail", {
      next: safeNext(new URL(req.url).searchParams.get("next"), "/settings"),
      loginHint: user.email,
    });
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_COOKIE, JSON.stringify(cookie), oauthCookieOptions());
    return res;
  } catch (e) {
    if (e instanceof GoogleError) return NextResponse.redirect(new URL("/settings?gmail_error=config", req.url));
    throw e;
  }
}
