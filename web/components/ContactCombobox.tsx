"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { positionOf, searchContacts } from "@/lib/contact";
import { CONTACT_NAME_MAX, CONTACT_ROLE_LABEL, CONTACT_SEARCH_LIMIT } from "@/lib/constants";
import { conflictContact } from "@/lib/useContacts";
import type { Company, Contact } from "@/lib/types";
import { Badge, Button, Icon, IconButton, Input } from "./ui";

/** 리드 모달에서 바로 만드는 연락처 (회사는 리드의 회사) */
export interface QuickContact {
  name: string;
  title: string;
  email: string;
  mobile: string;
}

interface Props {
  contacts: Contact[];
  companies: Company[];
  /** 선택된 연락처 id (없으면 null) */
  value: string | null;
  /** 리드에 선택된 회사: 그 회사 연락처를 위에 보여주고, 바로 만들 때 소속으로 쓴다 */
  companyId: string | null;
  onChange: (contact: Contact | null) => void;
  onCreate: (input: QuickContact) => Promise<Contact>;
  /** 연락처에 연결되지 않은 담당자 텍스트 (기존 리드·연락처 삭제 후) */
  legacy: { contact: string; title: string; email: string; phone: string };
  onClearLegacy: () => void;
  /** 간이 생성 폼이 열려 있는지 (열려 있으면 리드 저장을 막는다) */
  onPendingChange: (pending: boolean) => void;
  onOpenContact?: (id: string) => void;
  onEditContact?: (id: string) => void;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const idx = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <b>{text.slice(idx, idx + q.length)}</b>
      {text.slice(idx + q.length)}
    </>
  );
}

const emptyQuick = (name = ""): QuickContact => ({ name, title: "", email: "", mobile: "" });

/**
 * 리드 담당자 선택: 검색 → 드롭다운(이 회사 연락처 / 다른 회사), 없으면 "새 연락처로 만들기" → 간이 입력 폼.
 * ARIA combobox 패턴 (↑↓ 이동, Enter 선택, Esc 닫기).
 */
export default function ContactCombobox({
  contacts, companies, value, companyId, onChange, onCreate, legacy, onClearLegacy, onPendingChange, onOpenContact, onEditContact,
}: Props) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [quick, setQuick] = useState<QuickContact | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<Contact | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  const selected = value ? contacts.find((c) => c.id === value) ?? null : null;
  const { sameCompany, others } = useMemo(
    () => searchContacts(contacts, query, companyId, CONTACT_SEARCH_LIMIT),
    [contacts, query, companyId]
  );
  const options = [...sameCompany, ...others];
  const name = query.trim().replace(/\s+/g, " ");
  const canCreate = Boolean(name) && name.length <= CONTACT_NAME_MAX;
  const optionCount = options.length + (canCreate ? 1 : 0);

  useEffect(() => setActive(0), [query]);
  useEffect(() => onPendingChange(quick !== null), [quick, onPendingChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (c: Contact) => {
    onChange(c);
    setQuery("");
    setOpen(false);
    setQuick(null);
    setError(null);
    setDuplicate(null);
  };

  const startCreate = () => {
    if (!canCreate) return;
    setQuick(emptyQuick(name));
    setOpen(false);
    setError(null);
    setDuplicate(null);
  };

  const choose = (i: number) => {
    if (i < options.length) pick(options[i]);
    else if (canCreate) startCreate();
  };

  const create = async () => {
    if (!quick || creating || !quick.name.trim()) return;
    setCreating(true);
    setError(null);
    setDuplicate(null);
    try {
      const c = await onCreate({ ...quick, name: quick.name.trim() });
      setCreatedId(c.id);
      pick(c);
    } catch (e) {
      setError((e as Error).message);
      setDuplicate(conflictContact(e));
    } finally {
      setCreating(false);
    }
  };

  const clear = () => {
    onChange(null);
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // 간이 폼 입력에서 Enter는 리드 저장이 아니라 연락처 만들기, Esc는 폼 닫기
  const quickKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      create();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setQuick(null);
    }
  };

  if (selected) {
    const company = selected.companyId ? companyName.get(selected.companyId) : undefined;
    return (
      <div className="company-combo">
        <div className="company-chip" data-testid="contact-chip">
          <Icon name="user" size={16} />
          <b>{selected.name}</b>
          {createdId === selected.id && <Badge tone="brand" shape="pill">새 연락처</Badge>}
          {selected.role && <Badge tone={selected.role === "decision_maker" ? "brand" : "neutral"} shape="pill">{CONTACT_ROLE_LABEL[selected.role]}</Badge>}
          <span className="muted ellipsis">{[company, positionOf(selected)].filter(Boolean).join(" · ")}</span>
          <span className="spacer" />
          <IconButton icon="close" size="sm" label="다른 담당자 선택" onClick={clear} />
        </div>
        <dl className="contact-readonly">
          <div><dt>이메일</dt><dd>{selected.email || <span className="muted">—</span>}</dd></div>
          <div><dt>전화</dt><dd>{selected.mobile || selected.officePhone || <span className="muted">—</span>}</dd></div>
        </dl>
        {(onOpenContact || onEditContact) && (
          <div className="contact-actions">
            {onOpenContact && <Button variant="ghost" size="sm" onClick={() => onOpenContact(selected.id)}>연락처 정보 →</Button>}
            <span className="spacer" />
            {onEditContact && <Button size="sm" icon="edit" onClick={() => onEditContact(selected.id)}>연락처 수정</Button>}
          </div>
        )}
      </div>
    );
  }

  if (quick) {
    const companyLabel = companyId ? companyName.get(companyId) : undefined;
    const setQ = (k: keyof QuickContact, v: string) => setQuick((q) => (q ? { ...q, [k]: v } : q));
    return (
      <div className="contact-quick" role="group" aria-label="새 연락처">
        <div className="contact-quick-head">
          <b>새 연락처</b>
          <span className="muted">{companyLabel ? `· ${companyLabel} 소속으로 만들어요` : "· 회사 없이 만들어요"}</span>
        </div>
        <div className="contact-quick-grid">
          <label>이름 *<Input aria-label="새 연락처 이름" autoFocus maxLength={CONTACT_NAME_MAX} value={quick.name}
            onChange={(e) => setQ("name", e.target.value)} onKeyDown={quickKey} /></label>
          <label>직함<Input aria-label="새 연락처 직함" maxLength={50} placeholder="구매팀장" value={quick.title}
            onChange={(e) => setQ("title", e.target.value)} onKeyDown={quickKey} /></label>
          <label>이메일<Input aria-label="새 연락처 이메일" type="email" placeholder="name@company.com" value={quick.email}
            onChange={(e) => setQ("email", e.target.value)} onKeyDown={quickKey} /></label>
          <label>휴대폰<Input aria-label="새 연락처 휴대폰" maxLength={30} placeholder="010-0000-0000" value={quick.mobile}
            onChange={(e) => setQ("mobile", e.target.value)} onKeyDown={quickKey} /></label>
        </div>
        {error && (
          <div className="field-error" role="alert">
            {error}{" "}
            {duplicate && <Button variant="ghost" size="sm" onClick={() => pick(duplicate)}>기존 연락처 선택</Button>}
          </div>
        )}
        <div className="contact-actions">
          <span className="muted">부서·역할 등은 연락처 메뉴에서 입력할 수 있어요</span>
          <span className="spacer" />
          <Button size="sm" onClick={() => setQuick(null)}>취소</Button>
          <Button size="sm" variant="primary" disabled={creating || !quick.name.trim()} onClick={create}>
            {creating ? "만드는 중…" : "만들기"}
          </Button>
        </div>
      </div>
    );
  }

  const activeId = open && optionCount > 0 ? `${listId}-${active}` : undefined;
  const hasLegacy = Boolean(legacy.contact || legacy.email || legacy.phone);
  const row = (c: Contact, i: number) => (
    <div
      key={c.id}
      id={`${listId}-${i}`}
      role="option"
      aria-selected={active === i}
      className={`combo-opt${active === i ? " on" : ""}`}
      onMouseEnter={() => setActive(i)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(c)}
    >
      <span className="combo-name"><Highlight text={c.name} query={query} /></span>
      {c.role === "decision_maker" && <Badge tone="brand" shape="pill">{CONTACT_ROLE_LABEL[c.role]}</Badge>}
      <span className="spacer" />
      <span className="muted">
        {[c.companyId !== companyId && (c.companyId ? companyName.get(c.companyId) : "(회사 없음)"), positionOf(c)].filter(Boolean).join(" · ")}
      </span>
    </div>
  );

  return (
    <div className="company-combo" ref={boxRef}>
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label="담당자"
        placeholder={companyId ? "담당자 검색 또는 새로 만들기" : "이름·이메일로 검색 또는 새로 만들기"}
        value={query}
        maxLength={CONTACT_NAME_MAX + 20}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => (optionCount ? (i + 1) % optionCount : 0));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (optionCount ? (i - 1 + optionCount) % optionCount : 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open && optionCount) choose(active);
          } else if (e.key === "Escape" && open) {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setOpen(false);
          }
        }}
      />
      {open && (name || sameCompany.length > 0) && (
        <div className="combo-pop" id={listId} role="listbox" aria-label="담당자 검색 결과">
          <div className="combo-meta" aria-live="polite">
            {name ? (options.length ? `${options.length}명` : "일치하는 연락처가 없어요") : "이 회사 연락처"}
          </div>
          {sameCompany.length > 0 && name && (
            <div className="combo-group" role="presentation">{companyId ? `${companyName.get(companyId) ?? "이 회사"} 연락처` : ""}</div>
          )}
          {sameCompany.map((c, i) => row(c, i))}
          {others.length > 0 && companyId && <div className="combo-group" role="presentation">다른 회사</div>}
          {others.map((c, i) => row(c, sameCompany.length + i))}
          {canCreate && (
            <div
              id={`${listId}-${options.length}`}
              role="option"
              aria-selected={active === options.length}
              className={`combo-opt combo-create${active === options.length ? " on" : ""}`}
              onMouseEnter={() => setActive(options.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={startCreate}
            >
              ＋ &quot;{name}&quot; 새 연락처로 만들기
            </div>
          )}
        </div>
      )}
      {hasLegacy && !open && (
        <div className="company-suggest" data-testid="legacy-contact">
          <span>
            연락처에 연결되지 않은 담당자: <b>{legacy.contact || "(이름 없음)"}</b>
            <span className="muted"> {[legacy.title, legacy.email, legacy.phone].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={onClearLegacy}>지우기</Button>
        </div>
      )}
    </div>
  );
}
