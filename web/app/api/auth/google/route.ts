import { NextResponse } from "next/server";
import { buildAuthRequest, GoogleError, OAUTH_COOKIE, oauthCookieOptions, safeNext } from "@/lib/google";

export const dynamic = "force-dynamic";

/** 구글 로그인 시작: state·PKCE를 쿠키에 보관하고 구글 동의 화면으로 이동 */
export async function GET(req: Request) {
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  try {
    const { url, cookie } = buildAuthRequest(req.url, "login", { next });
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_COOKIE, JSON.stringify(cookie), oauthCookieOptions());
    return res;
  } catch (e) {
    if (e instanceof GoogleError) return NextResponse.redirect(new URL("/login?error=config", req.url));
    throw e;
  }
}
