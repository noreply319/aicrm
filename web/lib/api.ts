/** API 실패: 서버의 { error } 메시지 + 상태 코드 + 응답 본문 (409의 기존 회사 등) */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

/** 클라이언트 fetch 헬퍼: JSON 요청/응답, 실패 시 서버의 { error } 메시지로 예외 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const res = await fetch(url, {
    ...init,
    // FormData는 브라우저가 multipart 경계를 붙이도록 Content-Type을 지정하지 않는다
    headers: isForm ? init?.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  // 세션이 만료되면 로그인 화면으로 (돌아올 경로 유지)
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error("로그인이 필요합니다");
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const msg = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "";
    // JSON이 아닌 응답: Vercel 함수 시간 초과(504)·요청 크기 초과(413) 등 플랫폼 에러
    const fallback =
      res.status === 504 ? "서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요"
        : res.status === 413 ? "업로드 크기가 너무 큽니다"
          : `요청 실패 (${res.status})`;
    throw new ApiError(msg || fallback, res.status, body);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
