// 회사 관련 순수 함수 (클라이언트·서버 공용, DB 접근 없음)
import { FREE_MAIL_DOMAINS } from "./constants";
import type { Company, Lead } from "./types";

const CORP_MARKS = /\(주\)|㈜|주식회사|\(유\)|유한회사/g;

/**
 * 회사명 정규화 키: 소문자, 공백 제거, (주)·㈜·주식회사·(유)·유한회사 제거.
 * db/schema.sql의 crm_company_key()와 같은 규칙 (중복 판단·검색에 사용).
 */
export function companyKey(name: string): string {
  const key = name.replace(CORP_MARKS, "").toLowerCase().replace(/\s/g, "");
  return key || name.toLowerCase().replace(/\s/g, "");
}

/** 사업자등록번호 → 숫자만 (10자리가 아니면 그대로 숫자만 반환) */
export const businessDigits = (v: string) => v.replace(/\D/g, "");

/** 숫자 10자리 → 000-00-00000 */
export function formatBusinessNumber(v: string): string {
  const d = businessDigits(v);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : v;
}

/** 사업자등록번호 검증 숫자 확인 (형식이 틀려도 저장은 허용 — 화면 경고용) */
export function isValidBusinessNumber(v: string): boolean {
  const d = businessDigits(v);
  if (d.length !== 10) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i];
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 이메일 도메인 정리: 소문자, @·http(s)://·www.·경로 제거. 형식이 틀리면 null */
export function normalizeDomain(v: string): string | null {
  const d = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^.*@/, "").replace(/^www\./, "").split(/[/?#:]/)[0];
  return DOMAIN_RE.test(d) ? d : null;
}

export const isFreeMailDomain = (domain: string) => FREE_MAIL_DOMAINS.has(domain);

/** 웹사이트 주소에서 이메일 도메인 제안 (무료 메일 도메인이면 제안하지 않음) */
export function domainFromWebsite(website: string): string | null {
  const d = normalizeDomain(website);
  return d && !isFreeMailDomain(d) ? d : null;
}

/** 이메일 주소의 도메인 (소문자) */
export const emailDomain = (email: string) => {
  const at = email.trim().toLowerCase().split("@");
  return at.length === 2 && at[1] ? at[1] : "";
};

/** 회사별 리드 집계 (클라이언트 leads로 계산 → 리드 변경 즉시 반영) */
export interface CompanyStats {
  total: number;
  open: number;
  won: number;
  lost: number;
  pipelineValue: number;
  wonValue: number;
  /** 연결 리드 중 가장 최근 생성 시각 (ms), 없으면 0 */
  lastLeadAt: number;
}

export const emptyStats = (): CompanyStats => ({
  total: 0, open: 0, won: 0, lost: 0, pipelineValue: 0, wonValue: 0, lastLeadAt: 0,
});

export function statsByCompany(leads: Lead[]): Record<string, CompanyStats> {
  const out: Record<string, CompanyStats> = {};
  for (const l of leads) {
    if (!l.companyId) continue;
    const s = (out[l.companyId] ??= emptyStats());
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
 * 회사 검색: 정규화 키 부분 일치. 키가 완전히 같은 회사를 맨 앞에, 그다음 앞부분 일치, 나머지는 이름순.
 * exact는 정규화 키가 완전히 같은 회사 (있으면 "새 회사로 생성"을 숨긴다).
 */
export function searchCompanies(companies: Company[], query: string, limit: number): { results: Company[]; exact: Company | null } {
  const q = companyKey(query.trim());
  if (!q) return { results: [...companies].sort((a, b) => a.name.localeCompare(b.name, "ko")).slice(0, limit), exact: null };
  const scored: { c: Company; rank: number }[] = [];
  for (const c of companies) {
    const k = companyKey(c.name);
    const idx = k.indexOf(q);
    if (idx < 0) continue;
    scored.push({ c, rank: k === q ? 0 : idx === 0 ? 1 : 2 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name, "ko"));
  return { results: scored.slice(0, limit).map((s) => s.c), exact: scored[0]?.rank === 0 ? scored[0].c : null };
}
