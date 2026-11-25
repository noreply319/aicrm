import "server-only";
import type { Pool, PoolClient } from "pg";
import { findCompanyMatch } from "./companies";
import { domainFromWebsite, emailDomain, isFreeMailDomain, isValidBusinessNumber, normalizeDomain } from "./company";
import { createCompany, findCompany } from "./companyOps";
import { isMobileNumber, isValidEmail, normalizeUrl } from "./contact";
import { createContact } from "./contactOps";
import { findContactByEmail, findSamePerson } from "./contacts";
import { CARD_TAG, COMPANY_NAME_MAX, CONTACT_NAME_MAX, CONTACT_NOTES_MAX } from "./constants";
import { chatCompletion } from "./openai";
import type {
  BusinessCardDraft, BusinessCardMatch, BusinessCardSaved, Company, CompanyInput, Contact, ContactInput,
} from "./types";

/**
 * 명함 → 회사·연락처 (AIC-10)
 *  - 분석: 명함 이미지를 OpenAI 비전 모델로 읽는다. 명함 이미지에는 이메일·전화번호가 들어 있어
 *    "이메일·전화번호는 OpenAI로 보내지 않음" 원칙의 유일한 예외 (화면에서 사용자에게 안내). 이미지는 저장하지 않는다.
 *  - 저장: 사용자가 확인 카드에서 고친 값으로 회사(또는 기존 회사)와 연락처를 한 트랜잭션에서 만든다.
 */

const SYSTEM_PROMPT = `너는 명함 이미지를 읽어 CRM에 등록할 정보를 JSON으로 돌려준다.
이미지가 2장이면 같은 사람 명함의 앞·뒷면이다 (한글·영문 면이 있으면 한글 값을 우선).
아래 키만 쓰고, 명함에 없거나 읽을 수 없는 값은 빈 문자열 ""로 둔다. 추측해서 지어내지 않는다.
{
  "company": { "name": "회사명 (법인 표기 포함 그대로)", "website": "", "phone": "회사 대표·유선 번호", "address": "", "businessNumber": "사업자등록번호" },
  "contact": { "name": "사람 이름", "department": "부서", "title": "직함·직급", "email": "", "mobile": "휴대폰 번호", "officePhone": "직통·사무실 번호", "linkedinUrl": "" }
}
전화번호는 "M.", "T.", "Tel", "Mobile", "HP" 같은 표시를 빼고 숫자와 - 만 쓴다. 010·011 등으로 시작하는 번호는 mobile이다.
명함이 아니면 모든 값을 빈 문자열로 돌려준다.`;

export async function extractBusinessCard(images: { mime: string; data: Uint8Array }[]): Promise<BusinessCardDraft> {
  const raw = await chatCompletion(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: images.length > 1 ? "명함 앞·뒷면입니다." : "명함입니다." },
          ...images.map((img) => ({
            type: "image_url" as const,
            image_url: { url: `data:${img.mime};base64,${Buffer.from(img.data).toString("base64")}`, detail: "high" as const },
          })),
        ],
      },
    ],
    { maxTokens: 800, json: true, timeoutMs: 45_000 }
  );
  return parseCardJson(raw);
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** 전화번호: "M. 010 1234 5678" → "010-1234-5678"처럼 표시를 빼고 숫자·+·-·괄호만 남긴다 */
export function cleanPhone(v: unknown): string {
  const s = text(v, 60).replace(/^[^\d+(]+/, "").replace(/[^\d+\-()\s]/g, " ").replace(/\s+/g, " ").trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7) return "";
  // 공백·점으로 나눈 국내 번호는 하이픈으로 통일
  return s.replace(/(\d)\s+(?=\d)/g, "$1-").slice(0, 30);
}

/** 모델 응답(JSON 문자열) → 검증·정규화한 명함 값. 형식이 틀린 값은 빈 값으로 버린다 */
export function parseCardJson(raw: string): BusinessCardDraft {
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const c = obj(obj(body).company);
  const p = obj(obj(body).contact);

  const email = text(p.email, 254).toLowerCase().replace(/^mailto:/, "");
  let mobile = cleanPhone(p.mobile);
  let officePhone = cleanPhone(p.officePhone);
  // 휴대폰이 유선 칸에 들어온 경우 바로잡는다
  if (!mobile && officePhone && isMobileNumber(officePhone)) [mobile, officePhone] = [officePhone, ""];
  if (mobile && !isMobileNumber(mobile) && !officePhone) [mobile, officePhone] = ["", mobile];

  const rawWebsite = text(c.website, 300);
  const website = rawWebsite ? normalizeUrl(rawWebsite) ?? "" : "";
  const mailDomain = isValidEmail(email) ? emailDomain(email) : "";
  // 회사 도메인: 회사 메일 주소 → 없으면 웹사이트 (무료 메일 도메인은 회사 도메인이 아님)
  const domain = (mailDomain && !isFreeMailDomain(mailDomain) ? normalizeDomain(mailDomain) : null) ?? (website ? domainFromWebsite(website) : null) ?? "";
  const businessNumber = text(c.businessNumber, 30).replace(/\D/g, "");
  const linkedin = text(p.linkedinUrl, 300);

  return {
    company: {
      name: text(c.name, COMPANY_NAME_MAX),
      website,
      emailDomain: domain,
      phone: cleanPhone(c.phone),
      address: text(c.address, 300),
      businessNumber: businessNumber.length === 10 && isValidBusinessNumber(businessNumber) ? businessNumber : "",
    },
    contact: {
      name: text(p.name, CONTACT_NAME_MAX),
      department: text(p.department, 50),
      title: text(p.title, 50),
      email: isValidEmail(email) ? email : "",
      mobile,
      officePhone,
      linkedinUrl: linkedin && /linkedin\.com/i.test(linkedin) ? normalizeUrl(linkedin) ?? "" : "",
    },
  };
}

/** 명함과 같은 기존 회사(도메인·이름)와 연락처(이메일, 같은 회사의 같은 이름) */
export async function findCardMatch(db: Pool | PoolClient, d: BusinessCardDraft): Promise<BusinessCardMatch> {
  const companyMatch =
    d.company.name || d.company.emailDomain
      ? await findCompanyMatch(db, { name: d.company.name, emailDomain: d.company.emailDomain || null })
      : null;
  const contactByEmail = await findContactByEmail(db, d.contact.email);
  const sameName =
    !contactByEmail && d.contact.name
      ? await findSamePerson(db, { name: d.contact.name, companyId: companyMatch?.company.id ?? null })
      : null;
  return { company: companyMatch?.company ?? null, companyByDomain: companyMatch?.byDomain ?? false, contactByEmail, sameName };
}

/** 같은 이메일의 연락처가 있어 저장을 되돌릴 때 (withTransaction이 ROLLBACK 하도록 던진다) */
export class CardContactConflict extends Error {
  constructor(readonly error: string, readonly existing: Contact | null) {
    super(error);
  }
}

/** 연락처 메모·태그에 명함으로 등록했다는 표시를 더한다 */
function markFromCard(d: ContactInput): ContactInput {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const line = `명함으로 등록 (${today})`;
  const notes = d.notes ? `${d.notes}\n${line}` : line;
  return {
    ...d,
    tags: d.tags.includes(CARD_TAG) ? d.tags : [...d.tags, CARD_TAG],
    notes: notes.length > CONTACT_NOTES_MAX ? d.notes : notes,
  };
}

/**
 * 명함 저장 (호출한 쪽의 트랜잭션 client로 실행).
 *  - companyId: 그 회사에 연결 / company: 새로 만들되 같은 이름·도메인 회사가 이미 있으면 그 회사에 연결 / 둘 다 없으면 회사 없이
 *  - 같은 이메일 연락처가 있으면 CardContactConflict (회사 생성까지 되돌린다)
 */
export async function saveBusinessCard(
  client: PoolClient,
  userId: string | null,
  input: { companyId: string | null; company: CompanyInput | null; contact: ContactInput }
): Promise<{ ok: true; saved: BusinessCardSaved } | { ok: false; status: 400 | 404 | 409; error: string }> {
  let company: Company | null = null;
  let companyCreated = false;
  if (input.companyId) {
    company = await findCompany(client, input.companyId);
    if (!company) return { ok: false, status: 404, error: "회사를 찾을 수 없습니다" };
  } else if (input.company) {
    const r = await createCompany(client, userId, input.company);
    if (r.ok) {
      company = r.company;
      companyCreated = true;
    } else if (r.status === 409 && r.existing) {
      company = r.existing;
    } else {
      return { ok: false, status: r.status, error: r.error };
    }
  }

  const r = await createContact(client, userId, markFromCard({ ...input.contact, companyId: company?.id ?? null }));
  if (!r.ok) {
    if (r.status === 409) throw new CardContactConflict(r.error, r.existing);
    throw new CardSaveError(r.status, r.error);
  }
  return { ok: true, saved: { company, companyCreated, contact: r.contact } };
}

/** 연락처 저장 실패(400·404) → 회사 생성도 되돌린다 */
export class CardSaveError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
  }
}
