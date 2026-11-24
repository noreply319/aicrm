/** 클라이언트 fetch 헬퍼: JSON 요청/응답, 실패 시 서버의 { error } 메시지로 예외 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const res = await fetch(url, {
    ...init,
    // FormData는 브라우저가 multipart 경계를 붙이도록 Content-Type을 지정하지 않는다
    headers: isForm ? init?.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const msg = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "";
    throw new Error(msg || `요청 실패 (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
