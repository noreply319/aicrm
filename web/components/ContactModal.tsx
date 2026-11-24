"use client";

import { useEffect, useRef, useState } from "react";
import type { CompanyStats } from "@/lib/company";
import { sameNameContact } from "@/lib/contact";
import { COMPANY_TAG_LEN, COMPANY_TAG_MAX, CONTACT_NAME_MAX, CONTACT_NOTES_MAX, CONTACT_ROLES } from "@/lib/constants";
import { conflictContact } from "@/lib/useContacts";
import type { Company, Contact, ContactInput, ContactRole, TeamMember } from "@/lib/types";
import CompanyCombobox from "./CompanyCombobox";
import { Alert, Badge, Button, Field, IconButton, Input, Modal, ModalFooter, ModalHeader, Select, Textarea } from "./ui";

interface Props {
  contact: Contact | null;
  /** 동명이인 경고·부서 자동완성용 전체 연락처 */
  contacts: Contact[];
  companies: Company[];
  companyStats: Record<string, CompanyStats>;
  team: TeamMember[];
  allTags: string[];
  /** 연결 리드 수 (삭제 확인 안내) */
  leadCount: number;
  /** 새 연락처를 이 회사 소속으로 연다 (회사 상세 → 연락처 추가) */
  defaultCompanyId?: string | null;
  onSave: (input: ContactInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCreateCompany: (name: string) => Promise<Company>;
  /** 중복 안내의 "그 연락처 보기" */
  onOpenContact: (id: string) => void;
  onClose: () => void;
}

const empty = (companyId: string | null): ContactInput => ({
  name: "", companyId, department: "", title: "", email: "", mobile: "", officePhone: "",
  linkedinUrl: "", role: null, ownerId: null, tags: [], notes: "",
});

const toInput = (c: Contact): ContactInput => {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = c;
  return rest;
};

export default function ContactModal({
  contact, contacts, companies, companyStats, team, allTags, leadCount, defaultCompanyId, onSave, onDelete, onCreateCompany,
  onOpenContact, onClose,
}: Props) {
  const [form, setForm] = useState<ContactInput>(() => (contact ? toInput(contact) : empty(defaultCompanyId ?? null)));
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Contact | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  const set = <K extends keyof ContactInput>(key: K, value: ContactInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const addTag = (raw: string) => {
    const t = raw.trim().slice(0, COMPANY_TAG_LEN);
    if (!t || form.tags.includes(t) || form.tags.length >= COMPANY_TAG_MAX) return;
    set("tags", [...form.tags, t]);
    setTagInput("");
  };

  // 같은 회사(또는 둘 다 회사 없음)에 같은 이름 → 경고만 (동명이인일 수 있어 저장은 허용)
  const sameName = sameNameContact(contacts, form.name, form.companyId, contact?.id ?? null);
  // 부서 자동완성: 같은 회사 값 먼저
  const departments = [...new Set([
    ...contacts.filter((c) => c.companyId === form.companyId).map((c) => c.department),
    ...contacts.map((c) => c.department),
  ].filter(Boolean))];

  const submit = async () => {
    if (saving || !form.name.trim()) return;
    setError(null);
    setDuplicate(null);
    const pendingTag = tagInput.trim();
    const tags = pendingTag && !form.tags.includes(pendingTag) ? [...form.tags, pendingTag].slice(0, COMPANY_TAG_MAX) : form.tags;
    setSaving(true);
    try {
      await onSave({ ...form, tags });
    } catch (e) {
      setError((e as Error).message);
      const dup = conflictContact(e);
      if (dup && dup.id !== contact?.id) setDuplicate(dup);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    const msg = leadCount
      ? `'${contact?.name}' 연락처를 삭제할까요?\n연결된 리드 ${leadCount}건은 담당자 연결만 해제돼요. 리드에 적힌 담당자 이름·연락처는 그대로 남아요.`
      : `'${contact?.name}' 연락처를 삭제할까요?`;
    if (!confirm(msg)) return;
    try {
      await onDelete();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const title = contact ? `${contact.name} 수정` : "새 연락처 등록";
  return (
    <Modal label={title} size="lg" onClose={onClose} onSubmit={submit} className="company-modal">
      <ModalHeader title={title} onClose={onClose} />
      <div className="modal-body">
        <div className="form-legend">기본 정보</div>
        <Field label="이름 *">
          <Input aria-label="이름 *" ref={nameRef} required maxLength={CONTACT_NAME_MAX} placeholder="예: 김민수"
            value={form.name} onChange={(e) => set("name", e.target.value)} />
          {sameName && (
            <div className="field-warn">
              같은 회사에 &apos;{sameName.name}&apos;이(가) 이미 있어요{" "}
              <Button variant="ghost" size="sm" onClick={() => onOpenContact(sameName.id)}>보기</Button>
            </div>
          )}
        </Field>
        <Field label="회사" hint="(선택)">
          <CompanyCombobox
            companies={companies}
            stats={companyStats}
            value={form.companyId}
            leadEmail={form.email}
            onChange={(c) => set("companyId", c?.id ?? null)}
            onCreate={onCreateCompany}
          />
        </Field>
        <Field label="부서">
          <Input aria-label="부서" list="ct-departments" maxLength={50} placeholder="예: 구매팀" value={form.department}
            onChange={(e) => set("department", e.target.value)} />
          <datalist id="ct-departments">
            {departments.map((v) => <option key={v} value={v} />)}
          </datalist>
        </Field>
        <Field label="직함">
          <Input aria-label="직함" maxLength={50} placeholder="예: 팀장" value={form.title} onChange={(e) => set("title", e.target.value)} />
        </Field>

        <div className="form-legend">연락 수단</div>
        <Field label="이메일">
          <Input aria-label="이메일" type="email" maxLength={254} placeholder="name@company.com" value={form.email}
            onChange={(e) => set("email", e.target.value)} />
          {duplicate ? (
            <div className="field-error">
              이미 등록된 이메일이에요: <b>{duplicate.name}</b>{" "}
              <Button variant="ghost" size="sm" onClick={() => onOpenContact(duplicate.id)}>그 연락처 보기</Button>
            </div>
          ) : (
            <div className="field-note">다른 연락처와 같은 이메일은 등록할 수 없어요</div>
          )}
        </Field>
        <Field label="휴대폰">
          <Input aria-label="휴대폰" maxLength={30} placeholder="010-0000-0000" value={form.mobile}
            onChange={(e) => set("mobile", e.target.value)} />
        </Field>
        <Field label="유선 전화">
          <Input aria-label="유선 전화" maxLength={30} placeholder="02-0000-0000 #내선" value={form.officePhone}
            onChange={(e) => set("officePhone", e.target.value)} />
        </Field>
        <Field label="LinkedIn">
          <Input aria-label="LinkedIn" maxLength={500} placeholder="linkedin.com/in/…" value={form.linkedinUrl}
            onChange={(e) => set("linkedinUrl", e.target.value)} />
        </Field>

        <div className="form-legend">영업 관리</div>
        <Field label="역할">
          <div className="choice-row" role="radiogroup" aria-label="역할">
            {[...CONTACT_ROLES, { id: null, label: "없음" }].map((r) => (
              <Button key={r.id ?? "none"} size="sm" role="radio" aria-checked={form.role === r.id} active={form.role === r.id}
                onClick={() => set("role", r.id as ContactRole | null)}>
                {r.label}
              </Button>
            ))}
          </div>
        </Field>
        <Field label="담당 영업">
          <Select aria-label="담당 영업" value={form.ownerId ?? ""} onChange={(e) => set("ownerId", e.target.value || null)}>
            <option value="">없음</option>
            {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="태그" hint={`(Enter로 추가, 최대 ${COMPANY_TAG_MAX}개)`} full>
          <div className="tag-input">
            {form.tags.map((t) => (
              <Badge key={t} className="tag-chip">
                {t}
                <IconButton icon="close" size="sm" label={`${t} 태그 삭제`} onClick={() => set("tags", form.tags.filter((x) => x !== t))} />
              </Badge>
            ))}
            <Input aria-label="태그" list="ct-all-tags" maxLength={COMPANY_TAG_LEN} placeholder={form.tags.length ? "" : "예: 키맨"}
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
            <datalist id="ct-all-tags">
              {allTags.filter((t) => !form.tags.includes(t)).map((t) => <option key={t} value={t} />)}
            </datalist>
          </div>
        </Field>

        <div className="form-legend">메모</div>
        <Field label="" full>
          <Textarea aria-label="메모" maxLength={CONTACT_NOTES_MAX} placeholder="선호 연락 시간, 관심사 등" value={form.notes}
            onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
      {error && !duplicate && <Alert tone="danger" className="modal-alert">{error}</Alert>}
      <ModalFooter start={onDelete && <Button variant="danger" disabled={saving} onClick={remove}>삭제</Button>}>
        <Button onClick={onClose}>취소</Button>
        <Button type="submit" variant="primary" disabled={saving || !form.name.trim()}>{saving ? "저장 중…" : "저장"}</Button>
      </ModalFooter>
    </Modal>
  );
}
