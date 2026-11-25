/** CSRF 방지: 쿠키 인증 API의 변경 요청은 같은 사이트에서 온 것만 허용한다 (proxy.ts) */

/**
 * 다른 사이트에서 온 변경 요청인지: 브라우저가 보내는 Sec-Fetch-Site(cross-site·same-site)나 다른 Origin이면 true.
 * 두 헤더가 모두 없는 요청(서버 간 호출·테스트)은 통과 — 세션 쿠키가 없으면 어차피 401
 */
export function isCrossSite(h: Headers): boolean {
  const site = h.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return true;
  const origin = h.get("origin");
  return !!origin && safeHost(origin) !== h.get("host");
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
