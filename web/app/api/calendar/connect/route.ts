import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildAuthRequest, GoogleError, OAUTH_COOKIE, oauthCookieOptions } from "@/lib/google";

export const dynamic = "force-dynamic";

/** 설정 → Google 연동: 로그인한 계정에 캘린더 권한을 추가로 받는다 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/settings", req.url));
  try {
    const { url, cookie } = buildAuthRequest(req.url, "calendar", { next: "/settings", loginHint: user.email });
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_COOKIE, JSON.stringify(cookie), oauthCookieOptions());
    return res;
  } catch (e) {
    if (e instanceof GoogleError) return NextResponse.redirect(new URL("/settings?calendar_error=config", req.url));
    throw e;
  }
}
