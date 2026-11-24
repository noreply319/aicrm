"use client";

import { useEffect, useRef, useState } from "react";
import { domainFromWebsite, formatBusinessNumber, isValidBusinessNumber } from "@/lib/company";
import { COMPANY_SIZES, COMPANY_TAG_LEN, COMPANY_TAG_MAX, COMPANY_TIERS } from "@/lib/constants";
import { conflictCompany } from "@/lib/useCompanies";
import type { Company, CompanyInput, CompanySize, CompanyTier, TeamMember } from "@/lib/types";

interface Props {
  company: Company | null;
  team: TeamMember[];
  /** 업종·태그 자동완성 (기존 값) */
  industries: string[];
  allTags: string[];
  /** 연결 리드 수: 0이 아니면 삭제 불가 */
  leadCount: number;
  onSave: (input: CompanyInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  /** 중복 안내의 "그 회사로 이동" */
  onOpenCompany: (id: string) => void;
  onClose: () => void;
}

const empty = (): CompanyInput => ({
  name: "", website: "", emailDomain: null, industry: "", size: null, phone: "", address: "",
  businessNumber: "", ceoName: "", ownerId: null, tier: null, tags: [], notes: "",
});

const toInput = (c: Company): CompanyInput => {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = c;
  return rest;
};

export default function CompanyModal({ company, team, industries, allTags, leadCount, onSave, onDelete, onOpenCompany, onClose }: Props) {
  const [form, setForm] = useState<CompanyInput>(() => (company ? toInput(company) : empty()));
  // 사업자번호·도메인은 입력 중 값을 그대로 보여주고 저장할 때 정리
  const [bizInput, setBizInput] = useState(() => formatBusinessNumber(company?.businessNumber ?? ""));
  const [domainInput, setDomainInput] = useState(company?.emailDomain ?? "");
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Company | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof CompanyInput>(key: K, value: CompanyInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const addTag = (raw: string) => {
    const t = raw.trim().slice(0, COMPANY_TAG_LEN);
    if (!t || form.tags.includes(t) || form.tags.length >= COMPANY_TAG_MAX) return;
    set("tags", [...form.tags, t]);
    setTagInput("");
  };

  const suggestedDomain = !domainInput ? domainFromWebsite(form.website) : null;
  const bizDigits = bizInput.replace(/\D/g, "");
  const bizWarn = bizDigits.length > 0 && (bizDigits.length !== 10 || !isValidBusinessNumber(bizDigits));

  const submit = async () => {
    setError(null);
    setDuplicate(null);
    const pendingTag = tagInput.trim();
    const tags = pendingTag && !form.tags.includes(pendingTag) ? [...form.tags, pendingTag].slice(0, COMPANY_TAG_MAX) : form.tags;
    setSaving(true);
    try {
      await onSave({ ...form, tags, businessNumber: bizDigits, emailDomain: domainInput.trim() || null });
    } catch (e) {
      setError((e as Error).message);
      const dup = conflictCompany(e);
      if (dup && dup.id !== company?.id) setDuplicate(dup);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal company-modal"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="modal-head">
          <h2>{company ? `${company.name} 수정` : "새 회사 등록"}</h2>
        </div>
        <div className="modal-body">
          <div className="form-legend">기본 정보</div>
          <div className="field full">
            <label htmlFor="co-name">회사명 *</label>
            <input id="co-name" ref={nameRef} required maxLength={100} placeholder="예: 에이스상사"
              value={form.name} onChange={(e) => set("name", e.target.value)} />
            {duplicate && (
              <div className="field-error">
                이미 등록된 회사예요: <b>{duplicate.name}</b>{" "}
                <button type="button" className="link-btn" onClick={() => onOpenCompany(duplicate.id)}>그 회사로 이동</button>
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="co-web">웹사이트</label>
            <input id="co-web" placeholder="https://www.example.co.kr" value={form.website}
              onChange={(e) => set("website", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="co-domain">이메일 도메인</label>
            <input id="co-domain" placeholder="example.co.kr" value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)} />
            {suggestedDomain ? (
              <div className="field-hint">
                웹사이트 도메인 사용: <button type="button" className="link-btn" onClick={() => setDomainInput(suggestedDomain)}>{suggestedDomain}</button>
              </div>
            ) : (
              <div className="field-hint">gmail.com 등 무료 메일 도메인은 등록할 수 없어요</div>
            )}
          </div>
          <div className="field">
            <label htmlFor="co-industry">업종</label>
            <input id="co-industry" list="co-industries" maxLength={50} placeholder="예: 제조" value={form.industry}
              onChange={(e) => set("industry", e.target.value)} />
            <datalist id="co-industries">
              {industries.map((v) => <option key={v} value={v} />)}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor="co-size">규모 (직원 수)</label>
            <select id="co-size" value={form.size ?? ""} onChange={(e) => set("size", (e.target.value || null) as CompanySize | null)}>
              <option value="">미정</option>
              {COMPANY_SIZES.map((s) => <option key={s} value={s}>{s}명</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="co-phone">대표 전화</label>
            <input id="co-phone" maxLength={30} placeholder="02-0000-0000" value={form.phone}
              onChange={(e) => set("phone", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="co-addr">주소</label>
            <input id="co-addr" maxLength={300} placeholder="서울시 …" value={form.address}
              onChange={(e) => set("address", e.target.value)} />
          </div>

          <div className="form-legend">사업자 정보</div>
          <div className="field">
            <label htmlFor="co-biz">사업자등록번호</label>
            <input id="co-biz" inputMode="numeric" placeholder="000-00-00000" value={bizInput}
              onChange={(e) => setBizInput(e.target.value)}
              onBlur={() => setBizInput(formatBusinessNumber(bizInput))} />
            {bizWarn && (
              <div className="field-warn">
                {bizDigits.length !== 10 ? "숫자 10자리로 입력하세요" : "⚠ 번호를 확인해 주세요 (저장은 가능)"}
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="co-ceo">대표자명</label>
            <input id="co-ceo" maxLength={50} value={form.ceoName} onChange={(e) => set("ceoName", e.target.value)} />
          </div>

          <div className="form-legend">영업 관리</div>
          <div className="field">
            <label htmlFor="co-owner">담당 영업</label>
            <select id="co-owner" value={form.ownerId ?? ""} onChange={(e) => set("ownerId", e.target.value || null)}>
              <option value="">없음</option>
              {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label id="co-tier-label">등급</label>
            <div className="seg-choice" role="radiogroup" aria-labelledby="co-tier-label">
              {[...COMPANY_TIERS, null].map((t) => (
                <button key={t ?? "none"} type="button" role="radio" aria-checked={form.tier === t}
                  className={form.tier === t ? "on" : ""} onClick={() => set("tier", t as CompanyTier | null)}>
                  {t ?? "없음"}
                </button>
              ))}
            </div>
          </div>
          <div className="field full">
            <label htmlFor="co-tags">태그 <span className="muted">(Enter로 추가, 최대 {COMPANY_TAG_MAX}개)</span></label>
            <div className="tag-input">
              {form.tags.map((t) => (
                <span key={t} className="tag-chip">
                  {t}
                  <button type="button" aria-label={`${t} 태그 삭제`} onClick={() => set("tags", form.tags.filter((x) => x !== t))}>✕</button>
                </span>
              ))}
              <input id="co-tags" list="co-all-tags" maxLength={COMPANY_TAG_LEN} placeholder={form.tags.length ? "" : "예: 재계약"}
                value={tagInput} disabled={form.tags.length >= COMPANY_TAG_MAX}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag(tagInput);
                  } else if (e.key === "Backspace" && !tagInput && form.tags.length) {
                    set("tags", form.tags.slice(0, -1));
                  }
                }} />
              <datalist id="co-all-tags">
                {allTags.filter((t) => !form.tags.includes(t)).map((t) => <option key={t} value={t} />)}
              </datalist>
            </div>
          </div>

          <div className="form-legend">메모</div>
          <div className="field full">
            <textarea aria-label="메모" maxLength={5000} placeholder="회사 관련 메모" value={form.notes}
              onChange={(e) => set("notes", e.target.value)} />
          </div>
        </div>
        {error && !duplicate && <div className="modal-error" role="alert">{error}</div>}
        {onDelete && leadCount > 0 && (
          <div className="modal-warn">연결된 리드 {leadCount}건이 있어 삭제할 수 없어요. 리드를 다른 회사로 옮기거나 삭제해 주세요.</div>
        )}
        <div className="modal-foot">
          {onDelete && (
            <button type="button" className="btn btn-danger" disabled={leadCount > 0 || saving}
              onClick={async () => {
                if (!confirm(`'${company?.name}' 회사를 삭제할까요?`)) return;
                try {
                  await onDelete();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}>
              삭제
            </button>
          )}
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>취소</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim()}>{saving ? "저장 중…" : "저장"}</button>
        </div>
      </form>
    </div>
  );
}
