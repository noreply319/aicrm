// 연락처 관련 순수 함수 (클라이언트·서버 공용, DB 접근 없음)
import { emptyStats, type CompanyStats } from "./company";
import type { Contact, Lead } from "./types";

/**
 * 이름 비교 키: 소문자 + 공백 제거.
 * db/schema.sql의 crm_person_key()와 같은 규칙 (마이그레이션·동명이인 경고에 사용).
 */
export const personKey = (name: string) => name.toLowerCase().replace(/\s/g, "");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isValidEmail = (v: string) => EMAIL_RE.test(v);

/** URL 정리: http(s)://가 없으면 https://를 붙인다. 올바른 http(s) 주소가 아니면 null */
export function normalizeUrl(v: string): string | null {
  const raw = v.trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    return withScheme;
  } catch {
    return null;
  }
}

/** 휴대폰 번호인지 (숫자만 남겼을 때 01로 시작) — schema.sql 마이그레이션과 같은 규칙 */
// 국가 번호 표기(+82 10-…)도 국내 표기(010-…)로 바꿔 판단
export const isMobileNumber = (v: string) => v.replace(/\D/g, "").replace(/^82(?=1)/, "0").startsWith("01");

/** 리드에 저장할 담당자 사본: 이름·직함·이메일·전화(휴대폰, 없으면 유선 전화) */
export const leadCopyOf = (c: Pick<Contact, "name" | "title" | "email" | "mobile" | "officePhone">) => ({
  contact: c.name,
  title: c.title,
  email: c.email,
  phone: c.mobile || c.officePhone,
});

/** "부서 · 직함" (빈 값 제외) */
export const positionOf = (c: Pick<Contact, "department" | "title">) => [c.department, c.title].filter(Boolean).join(" · ");

/** 연락처별 연결 리드 집계 (클라이언트 leads로 계산 → 리드 변경 즉시 반영) */
export function statsByContact(leads: Lead[]): Record<string, CompanyStats> {
  const out: Record<string, CompanyStats> = {};
  for (const l of leads) {
    if (!l.contactId) continue;
    const s = (out[l.contactId] ??= emptyStats());
    s.total++;
    if (l.stage === "won") {
      s.won++;
      s.wonValue += l.value;
    } else if (l.stage === "lost") s.lost++;
    else {
      s.open++;
      s.pipelineValue += l.value;
    }
    s.lastLeadAt = Math.max(s.lastLeadAt, l.createdAt);
  }
  return out;
}

/**
 * 담당자 검색 (리드 모달): 이름·이메일·부서 부분 일치 (공백·대소문자 무시).
 * companyId가 있으면 그 회사 연락처(sameCompany)와 나머지(others)로 나눈다.
 * 검색어가 없으면 그 회사 연락처만 보여준다 (회사 연락처는 보통 2~3명).
 */
export function searchContacts(
  contacts: Contact[],
  query: string,
  companyId: string | null,
  limit: number
): { sameCompany: Contact[]; others: Contact[] } {
  const q = personKey(query.trim());
  const byName = (a: Contact, b: Contact) => a.name.localeCompare(b.name, "ko");
  if (!q) {
    return { sameCompany: companyId ? contacts.filter((c) => c.companyId === companyId).sort(byName).slice(0, limit) : [], others: [] };
  }
  const scored: { c: Contact; rank: number }[] = [];
  for (const c of contacts) {
    const k = personKey(c.name);
    const idx = k.indexOf(q);
    if (idx >= 0) scored.push({ c, rank: idx === 0 ? 0 : 1 });
    else if (personKey(c.email).includes(q) || personKey(c.department).includes(q)) scored.push({ c, rank: 2 });
  }
  scored.sort((a, b) => a.rank - b.rank || byName(a.c, b.c));
  const list = scored.map((s) => s.c);
  const sameCompany = companyId ? list.filter((c) => c.companyId === companyId) : [];
  const others = list.filter((c) => !companyId || c.companyId !== companyId);
  const top = sameCompany.slice(0, limit);
  return { sameCompany: top, others: others.slice(0, Math.max(0, limit - top.length)) };
}

/** 같은 회사(회사 없음 포함)에 이름이 같은 다른 연락처 (동명이인 경고) */
export const sameNameContact = (contacts: Contact[], name: string, companyId: string | null, selfId: string | null) => {
  const k = personKey(name.trim());
  if (!k) return null;
  return contacts.find((c) => c.id !== selfId && c.companyId === companyId && personKey(c.name) === k) ?? null;
};
