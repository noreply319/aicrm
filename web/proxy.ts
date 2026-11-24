import { NextResponse, type NextRequest } from "next/server";
import { findSessionUser, SESSION_COOKIE, USER_HEADER } from "@/lib/auth";

/**
 * 로그인 확인 (Next.js 16 Proxy = 이전 Middleware, Node.js 런타임)
 *  - 로그인 화면·OAuth 경로를 제외한 모든 페이지와 API는 유효한 세션이 있어야 한다.
 *  - 페이지는 /login으로 이동, API는 401.
 *  - 통과한 요청에는 사용자 id 헤더를 붙여 Route Handler가 이력(lead_events)에 변경자를 남길 수 있게 한다.
 *  - 쿠키 인증이므로 변경 요청(POST/PATCH/DELETE)은 같은 사이트에서 온 것만 허용한다 (CSRF 방지).
 */

const PUBLIC_PATHS = ["/login", "/api/auth/google", "/api/auth/callback", "/api/auth/logout"];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (isApi && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && safeHost(origin) !== req.headers.get("host")) {
      return NextResponse.json({ error: "허용되지 않은 요청입니다" }, { status: 403 });
    }
  }

  // 외부에서 보낸 사용자 헤더는 항상 지운다
  const headers = new Headers(req.headers);
  headers.delete(USER_HEADER);

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const user = token ? await findSessionUser(token).catch(() => null) : null;

  if (PUBLIC_PATHS.includes(pathname)) {
    // 이미 로그인했으면 로그인 화면 대신 앱으로
    if (pathname === "/login" && user) return NextResponse.redirect(new URL("/", req.url));
    return NextResponse.next({ request: { headers } });
  }

  if (!user) {
    const res = isApi
      ? NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 })
      : NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(pathname + search)}`, req.url));
    if (token) res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  headers.set(USER_HEADER, user.id);
  return NextResponse.next({ request: { headers } });
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export const config = {
  // 정적 파일(_next, 확장자가 있는 public 파일)은 제외
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};
