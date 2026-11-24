import { describe, expect, it } from "vitest";
import {
  isMobileNumber, leadCopyOf, normalizeUrl, personKey, positionOf, sameNameContact, searchContacts, statsByContact,
} from "@/lib/contact";
import type { Contact, Lead } from "@/lib/types";
import { parseContactInput, parseLeadInput } from "@/lib/validate";

const contact = (over: Partial<Contact>): Contact => ({
  id: "c", name: "", companyId: null, department: "", title: "", email: "", mobile: "", officePhone: "", linkedinUrl: "",
  role: null, ownerId: null, tags: [], notes: "", createdAt: "", updatedAt: "", ...over,
});

describe("연락처 순수 함수", () => {
  it("personKey: 소문자 + 공백 제거", () => {
    expect(personKey(" Kim  Min Su ")).toBe("kimminsu");
    expect(personKey("김 민수")).toBe(personKey("김민수"));
  });

  it("normalizeUrl: https:// 자동, 잘못된 주소는 null", () => {
    expect(normalizeUrl("linkedin.com/in/a")).toBe("https://linkedin.com/in/a");
    expect(normalizeUrl("http://x.io")).toBe("http://x.io");
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("리드 사본: 전화는 휴대폰, 없으면 유선 전화", () => {
    expect(leadCopyOf(contact({ name: "김", title: "팀장", email: "a@b.co", mobile: "010-1", officePhone: "02-1" })))
      .toEqual({ contact: "김", title: "팀장", email: "a@b.co", phone: "010-1" });
    expect(leadCopyOf(contact({ officePhone: "02-1" })).phone).toBe("02-1");
    expect(isMobileNumber("010-1234-5678")).toBe(true);
    expect(isMobileNumber("02-123-4567")).toBe(false);
  });

  it("positionOf: 부서 · 직함", () => {
    expect(positionOf(contact({ department: "구매팀", title: "팀장" }))).toBe("구매팀 · 팀장");
    expect(positionOf(contact({ title: "CTO" }))).toBe("CTO");
  });

  it("searchContacts: 선택한 회사 연락처를 먼저, 검색어 없으면 회사 연락처만", () => {
    const list = [
      contact({ id: "1", name: "김민수", companyId: "A" }),
      contact({ id: "2", name: "김태희", companyId: "B" }),
      contact({ id: "3", name: "박서연", companyId: "A", email: "kim.park@a.com" }),
      contact({ id: "4", name: "이도윤", companyId: null, department: "김포지점" }),
    ];
    const r = searchContacts(list, "김", "A", 8);
    expect(r.sameCompany.map((c) => c.id)).toEqual(["1"]);
    // 이름 일치 → 부서 일치 순
    expect(r.others.map((c) => c.id)).toEqual(["2", "4"]);
    // 이메일로도 찾는다
    expect(searchContacts(list, "kim.park", "A", 8).sameCompany.map((c) => c.id)).toEqual(["3"]);
    expect(searchContacts(list, "", "A", 8)).toEqual({ sameCompany: [list[0], list[2]], others: [] });
    expect(searchContacts(list, "", null, 8)).toEqual({ sameCompany: [], others: [] });
    expect(searchContacts(list, "김", "A", 2).others).toHaveLength(1);
  });

  it("sameNameContact: 같은 회사 + 같은 이름 (자기 자신 제외)", () => {
    const list = [contact({ id: "1", name: "김민수", companyId: "A" })];
    expect(sameNameContact(list, "김 민수", "A", null)?.id).toBe("1");
    expect(sameNameContact(list, "김민수", "B", null)).toBeNull();
    expect(sameNameContact(list, "김민수", "A", "1")).toBeNull();
  });

  it("statsByContact: 연락처별 진행·수주 집계", () => {
    const lead = (contactId: string | null, stage: Lead["stage"], value: number) => ({ contactId, stage, value, createdAt: 1 }) as Lead;
    const s = statsByContact([lead("x", "new", 10), lead("x", "won", 5), lead(null, "new", 99)]);
    expect(s.x).toMatchObject({ total: 2, open: 1, pipelineValue: 10, won: 1, wonValue: 5 });
    expect(Object.keys(s)).toEqual(["x"]);
  });
});

describe("parseContactInput", () => {
  it("정리해서 받는다", () => {
    const r = parseContactInput({ name: "  김  민수 ", email: "A@B.CO", tags: ["a", "a", ""], role: "", linkedinUrl: "linkedin.com/in/x" });
    expect(r).toMatchObject({ ok: true, data: { name: "김 민수", email: "a@b.co", tags: ["a"], role: null, linkedinUrl: "https://linkedin.com/in/x" } });
  });

  it("잘못된 값은 에러", () => {
    expect(parseContactInput({ name: "" }).ok).toBe(false);
    expect(parseContactInput({ name: "a".repeat(51) }).ok).toBe(false);
    expect(parseContactInput({ name: "a", email: "x@" }).ok).toBe(false);
    expect(parseContactInput({ name: "a", role: "ceo" }).ok).toBe(false);
    expect(parseContactInput({ name: "a", companyId: "nope" }).ok).toBe(false);
    expect(parseContactInput({ name: "a", mobile: "전화" }).ok).toBe(false);
    expect(parseContactInput({ name: "a", tags: "x" }).ok).toBe(false);
  });

  it("리드 입력의 contactId는 UUID 또는 null", () => {
    expect(parseLeadInput({ company: "A", contactId: "" })).toMatchObject({ ok: true, data: { contactId: null } });
    expect(parseLeadInput({ company: "A", contactId: "bad" }).ok).toBe(false);
  });
});
