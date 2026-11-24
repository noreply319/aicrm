"use client";

import { useEffect, useRef, useState } from "react";
import { domainFromWebsite, formatBusinessNumber, isValidBusinessNumber } from "@/lib/company";
import { COMPANY_SIZES, COMPANY_TAG_LEN, COMPANY_TAG_MAX, COMPANY_TIERS } from "@/lib/constants";
import { conflictCompany } from "@/lib/useCompanies";
import type { Company, CompanyInput, CompanySize, CompanyTier, TeamMember } from "@/lib/types";
import { Alert, Badge, Button, Field, IconButton, Input, Modal, ModalFooter, ModalHeader, Select, Textarea } from "./ui";

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
    if (saving || !form.name.trim()) return;
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

  const remove = async () => {
    if (!onDelete || !confirm(`'${company?.name}' 회사를 삭제할까요?`)) return;
    try {
      await onDelete();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const title = company ? `${company.name} 수정` : "새 회사 등록";
  return (
    <Modal label={title} size="lg" onClose={onClose} onSubmit={submit} className="company-modal">
      <ModalHeader title={title} onClose={onClose} />
      <div className="modal-body">
        <div className="form-legend">기본 정보</div>
        <Field label="회사명 *" full>
          <Input id="co-name" aria-label="회사명 *" ref={nameRef} required maxLength={100} placeholder="예: 에이스상사"
            value={form.name} onChange={(e) => set("name", e.target.value)} />
          {duplicate && (
            <div className="field-error">
              이미 등록된 회사예요: <b>{duplicate.name}</b>{" "}
              <Button variant="ghost" size="sm" onClick={() => onOpenCompany(duplicate.id)}>그 회사로 이동</Button>
            </div>
          )}
        </Field>
        <Field label="웹사이트">
          <Input aria-label="웹사이트" placeholder="https://www.example.co.kr" value={form.website}
            onChange={(e) => set("website", e.target.value)} />
        </Field>
        <Field label="이메일 도메인">
          <Input aria-label="이메일 도메인" placeholder="example.co.kr" value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)} />
          {suggestedDomain ? (
            <div className="field-note">
              웹사이트 도메인 사용:{" "}
              <Button variant="ghost" size="sm" onClick={() => setDomainInput(suggestedDomain)}>{suggestedDomain}</Button>
            </div>
          ) : (
            <div className="field-note">gmail.com 등 무료 메일 도메인은 등록할 수 없어요</div>
          )}
        </Field>
        <Field label="업종">
          <Input aria-label="업종" list="co-industries" maxLength={50} placeholder="예: 제조" value={form.industry}
            onChange={(e) => set("industry", e.target.value)} />
          <datalist id="co-industries">
            {industries.map((v) => <option key={v} value={v} />)}
          </datalist>
        </Field>
        <Field label="규모 (직원 수)">
          <Select aria-label="규모 (직원 수)" value={form.size ?? ""} onChange={(e) => set("size", (e.target.value || null) as CompanySize | null)}>
            <option value="">미정</option>
            {COMPANY_SIZES.map((s) => <option key={s} value={s}>{s}명</option>)}
          </Select>
        </Field>
        <Field label="대표 전화">
          <Input aria-label="대표 전화" maxLength={30} placeholder="02-0000-0000" value={form.phone}
            onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="주소">
          <Input aria-label="주소" maxLength={300} placeholder="서울시 …" value={form.address}
            onChange={(e) => set("address", e.target.value)} />
        </Field>

        <div className="form-legend">사업자 정보</div>
        <Field label="사업자등록번호">
          <Input aria-label="사업자등록번호" inputMode="numeric" placeholder="000-00-00000" value={bizInput}
            onChange={(e) => setBizInput(e.target.value)}
            onBlur={() => setBizInput(formatBusinessNumber(bizInput))} />
          {bizWarn && (
            <div className="field-warn">
              {bizDigits.length !== 10 ? "숫자 10자리로 입력하세요" : "⚠ 번호를 확인해 주세요 (저장은 가능)"}
            </div>
          )}
        </Field>
        <Field label="대표자명">
          <Input aria-label="대표자명" maxLength={50} value={form.ceoName} onChange={(e) => set("ceoName", e.target.value)} />
        </Field>

        <div className="form-legend">영업 관리</div>
        <Field label="담당 영업">
          <Select aria-label="담당 영업" value={form.ownerId ?? ""} onChange={(e) => set("ownerId", e.target.value || null)}>
            <option value="">없음</option>
            {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="등급">
          <div className="choice-row" role="radiogroup" aria-label="등급">
            {[...COMPANY_TIERS, null].map((t) => (
              <Button key={t ?? "none"} size="sm" role="radio" aria-checked={form.tier === t} active={form.tier === t}
                onClick={() => set("tier", t as CompanyTier | null)}>
                {t ?? "없음"}
              </Button>
            ))}
          </div>
        </Field>
        <Field label="태그" hint={`(Enter로 추가, 최대 ${COMPANY_TAG_MAX}개)`} full>
          <div className="tag-input">
            {form.tags.map((t) => (
              <Badge key={t} className="tag-chip">
                {t}
                <IconButton icon="close" size="sm" label={`${t} 태그 삭제`} onClick={() => set("tags", form.tags.filter((x) => x !== t))} />
              </Badge>
            ))}
            <Input aria-label="태그" list="co-all-tags" maxLength={COMPANY_TAG_LEN} placeholder={form.tags.length ? "" : "예: 재계약"}
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
        </Field>

        <div className="form-legend">메모</div>
        <Field label="" full>
          <Textarea aria-label="메모" maxLength={5000} placeholder="회사 관련 메모" value={form.notes}
            onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
      {error && !duplicate && <Alert tone="danger" className="modal-alert">{error}</Alert>}
      {onDelete && leadCount > 0 && (
        <Alert tone="warning" className="modal-alert">
          연결된 리드 {leadCount}건이 있어 삭제할 수 없어요. 리드를 다른 회사로 옮기거나 삭제해 주세요.
        </Alert>
      )}
      <ModalFooter
        start={onDelete && <Button variant="danger" disabled={leadCount > 0 || saving} onClick={remove}>삭제</Button>}
      >
        <Button onClick={onClose}>취소</Button>
        <Button type="submit" variant="primary" disabled={saving || !form.name.trim()}>{saving ? "저장 중…" : "저장"}</Button>
      </ModalFooter>
    </Modal>
  );
}
