import { describe, expect, it } from "vitest";
import {
  companyKey, domainFromWebsite, formatBusinessNumber, isValidBusinessNumber, normalizeDomain, searchCompanies, statsByCompany,
} from "@/lib/company";
import { parseCompanyInput, parseLeadInput } from "@/lib/validate";
import type { Company, Lead } from "@/lib/types";

const co = (name: string, over: Partial<Company> = {}): Company => ({
  id: name, name, website: "", emailDomain: null, industry: "", size: null, phone: "", address: "",
  businessNumber: "", ceoName: "", ownerId: null, tier: null, tags: [], notes: "",
  createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z", ...over,
});

describe("companyKey (회사명 정규화)", () => {
  it("공백·대소문자·법인 표기를 무시한다", () => {
    expect(companyKey("(주) 에이스 상사")).toBe("에이스상사");
    expect(companyKey("에이스상사㈜")).toBe("에이스상사");
    expect(companyKey("주식회사 에이스상사")).toBe("에이스상사");
    expect(companyKey("ACME  Corp")).toBe("acmecorp");
  });
  it("법인 표기만 있으면 원래 이름으로 비교한다", () => {
    expect(companyKey("㈜")).toBe("㈜");
  });
});

describe("사업자등록번호·도메인", () => {
  it("검증 숫자를 확인하고 하이픈 형식으로 보여준다", () => {
    expect(isValidBusinessNumber("220-81-62517")).toBe(true);
    expect(isValidBusinessNumber("220-81-62518")).toBe(false);
    expect(isValidBusinessNumber("12345")).toBe(false);
    expect(formatBusinessNumber("2208162517")).toBe("220-81-62517");
  });
  it("도메인을 정리하고, 웹사이트의 무료 메일 도메인은 제안하지 않는다", () => {
    expect(normalizeDomain("https://www.Acme.co.kr/about")).toBe("acme.co.kr");
    expect(normalizeDomain("kim@acme.co.kr")).toBe("acme.co.kr");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(domainFromWebsite("www.acme.co.kr")).toBe("acme.co.kr");
    expect(domainFromWebsite("https://gmail.com")).toBeNull();
  });
});

describe("searchCompanies (리드 모달 검색)", () => {
  const list = [co("스마트에이전시"), co("에이아이랩스"), co("(주)에이스상사"), co("블루웨이브")];
  it("부분 일치, 앞부분 일치를 먼저 보여준다", () => {
    const { results, exact } = searchCompanies(list, "에이", 8);
    expect(results.map((c) => c.name)).toEqual(["(주)에이스상사", "에이아이랩스", "스마트에이전시"]);
    expect(exact).toBeNull();
  });
  it("정규화 이름이 같으면 exact로 알려준다 (새 회사로 생성 숨김)", () => {
    const { results, exact } = searchCompanies(list, "에이스 상사", 8);
    expect(exact?.name).toBe("(주)에이스상사");
    expect(results[0].name).toBe("(주)에이스상사");
  });
  it("결과 개수를 제한한다", () => {
    expect(searchCompanies(list, "", 2).results).toHaveLength(2);
  });
});

describe("statsByCompany (회사별 리드 집계)", () => {
  it("진행 중은 파이프라인, 수주는 수주 금액으로 나눈다", () => {
    const lead = (stage: Lead["stage"], value: number, companyId: string | null = "c1") =>
      ({ id: stage + value, companyId, company: "A", stage, value, createdAt: value } as Lead);
    const s = statsByCompany([lead("new", 10), lead("proposal", 20), lead("won", 5), lead("lost", 7), lead("new", 99, null)]);
    expect(s.c1).toEqual({ total: 4, open: 2, won: 1, lost: 1, pipelineValue: 30, wonValue: 5, lastLeadAt: 20 });
    expect(Object.keys(s)).toEqual(["c1"]);
  });
});

describe("parseCompanyInput", () => {
  it("이름만으로도 통과하고 나머지는 기본값", () => {
    const r = parseCompanyInput({ name: "  에이스   상사 " });
    expect(r).toMatchObject({ ok: true, data: { name: "에이스 상사", emailDomain: null, tags: [], tier: null, size: null } });
  });
  it("웹사이트에 https를 붙이고 사업자번호는 숫자만 저장", () => {
    const r = parseCompanyInput({ name: "A", website: "acme.co.kr", businessNumber: "220-81-62517", emailDomain: "ACME.co.kr" });
    expect(r).toMatchObject({ ok: true, data: { website: "https://acme.co.kr", businessNumber: "2208162517", emailDomain: "acme.co.kr" } });
  });
  it("검증 숫자가 틀린 사업자번호도 10자리면 저장 허용", () => {
    expect(parseCompanyInput({ name: "A", businessNumber: "123-45-67890" }).ok).toBe(true);
    expect(parseCompanyInput({ name: "A", businessNumber: "123-45" })).toEqual({ ok: false, error: "사업자등록번호는 숫자 10자리로 입력하세요" });
  });
  it("잘못된 값은 한국어 에러", () => {
    expect(parseCompanyInput({ name: "" })).toEqual({ ok: false, error: "회사명은 필수입니다" });
    expect(parseCompanyInput({ name: "A", emailDomain: "gmail.com" }).ok).toBe(false);
    expect(parseCompanyInput({ name: "A", size: "huge" }).ok).toBe(false);
    expect(parseCompanyInput({ name: "A", tier: "S" }).ok).toBe(false);
    expect(parseCompanyInput({ name: "A", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }).ok).toBe(false);
    expect(parseCompanyInput({ name: "A", ownerId: "x" }).ok).toBe(false);
  });
  it("태그는 공백·중복을 정리한다", () => {
    expect(parseCompanyInput({ name: "A", tags: [" 재계약 ", "재계약", ""] })).toMatchObject({ ok: true, data: { tags: ["재계약"] } });
  });
});

describe("parseLeadInput 회사 지정", () => {
  it("companyId가 있으면 회사명이 없어도 통과", () => {
    const r = parseLeadInput({ companyId: "00000000-0000-4000-8000-000000000000" });
    expect(r).toMatchObject({ ok: true, data: { companyId: "00000000-0000-4000-8000-000000000000", company: "" } });
  });
  it("잘못된 companyId는 거부", () => {
    expect(parseLeadInput({ companyId: "abc", company: "A" })).toEqual({ ok: false, error: "회사가 올바르지 않습니다" });
  });
});
