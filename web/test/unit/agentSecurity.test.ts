import { describe, expect, it } from "vitest";
import { isCrossSite } from "@/lib/csrf";
import { AiError, toolErrorText, toolResultContent } from "@/lib/openai";

describe("CSRF: 다른 사이트에서 온 변경 요청", () => {
  const h = (init: Record<string, string>) => new Headers({ host: "crm.example.com", ...init });
  it("Sec-Fetch-Site가 cross-site·same-site면 막는다", () => {
    expect(isCrossSite(h({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSite(h({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isCrossSite(h({ "sec-fetch-site": "same-origin", origin: "https://crm.example.com" }))).toBe(false);
  });
  it("Origin이 다른 호스트면 막고, 두 헤더가 모두 없으면 통과", () => {
    expect(isCrossSite(h({ origin: "https://evil.example" }))).toBe(true);
    expect(isCrossSite(h({}))).toBe(false);
  });
});

describe("도구 결과·오류 → 모델", () => {
  it("도구 결과는 data로 감싼다", () => {
    expect(JSON.parse(toolResultContent({ count: 1 }))).toEqual({ data: { count: 1 } });
  });
  it("앱 오류는 메시지를 마스킹해 보내고, 그 밖의 오류는 내용을 숨긴다", () => {
    expect(toolErrorText(new AiError("kim@a.com 처리 실패", 502))).toBe("[이메일] 처리 실패");
    expect(toolErrorText(new Error('duplicate key value violates "contacts_email_idx" kim@a.com'))).toBe("도구 실행 중 오류가 발생했습니다");
  });
});
