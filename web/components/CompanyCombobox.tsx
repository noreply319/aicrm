"use client";

import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { emailDomain, searchCompanies, type CompanyStats } from "@/lib/company";
import { COMPANY_NAME_MAX, COMPANY_SEARCH_LIMIT } from "@/lib/constants";
import type { Company } from "@/lib/types";
import { Badge, Button, Icon, IconButton, Input } from "./ui";

interface Props {
  companies: Company[];
  stats: Record<string, CompanyStats>;
  /** 선택된 회사 id (없으면 null) */
  value: string | null;
  onChange: (company: Company | null) => void;
  /** 이름만으로 회사 생성 → 만든(또는 같은 이름의 기존) 회사 */
  onCreate: (name: string) => Promise<Company>;
  /** 리드 이메일: 회사 미선택 시 같은 도메인의 회사를 추천 */
  leadEmail: string;
  /** 리드 수정 모달: 회사 상세로 이동 */
  onOpenCompany?: (id: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}

/** 일치하는 부분을 굵게 (정규화 전 원래 이름에서 대소문자 무시로 찾는다) */
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

/**
 * 리드 모달의 회사 선택: 검색 → 드롭다운 선택, 없으면 "새 회사로 생성".
 * ARIA combobox 패턴 (↑↓ 이동, Enter 선택, Esc 닫기).
 */
export default function CompanyCombobox({
  companies, stats, value, onChange, onCreate, leadEmail, onOpenCompany, inputRef,
}: Props) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이 모달에서 새로 만든 회사 ("새 회사" 배지) */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const localInput = useRef<HTMLInputElement>(null);

  const selected = value ? companies.find((c) => c.id === value) ?? null : null;
  const { results, exact } = useMemo(() => searchCompanies(companies, query, COMPANY_SEARCH_LIMIT), [companies, query]);
  const name = query.trim().replace(/\s+/g, " ");
  const canCreate = Boolean(name) && !exact && name.length <= COMPANY_NAME_MAX;
  const optionCount = results.length + (canCreate ? 1 : 0);

  // 결과가 바뀌면 첫 항목 강조. 일치하는 회사가 없으면 "새 회사로 생성"이 첫 항목.
  useEffect(() => setActive(0), [query]);

  // 바깥 클릭 시 닫기
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // 회사 미선택 + 리드 이메일 도메인이 회사 도메인과 같으면 추천
  const suggestion = useMemo(() => {
    if (selected) return null;
    const d = emailDomain(leadEmail);
    return d ? companies.find((c) => c.emailDomain === d) ?? null : null;
  }, [selected, leadEmail, companies]);

  const pick = (c: Company) => {
    onChange(c);
    setQuery("");
    setOpen(false);
    setError(null);
  };

  const create = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    setError(null);
    try {
      const c = await onCreate(name);
      setCreatedId(c.id);
      pick(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const choose = (i: number) => {
    if (i < results.length) pick(results[i]);
    else if (canCreate) create();
  };

  const clear = () => {
    onChange(null);
    setOpen(true);
    // 칩이 입력란으로 바뀐 뒤 포커스
    setTimeout(() => localInput.current?.focus(), 0);
  };

  if (selected) {
    const s = stats[selected.id];
    return (
      <div className="company-combo">
        <div className="company-chip" data-testid="company-chip">
          <Icon name="building" size={16} />
          <b>{selected.name}</b>
          {createdId === selected.id && <Badge tone="brand" shape="pill">새 회사</Badge>}
          {(selected.industry || selected.tier) && (
            <span className="muted">{[selected.industry, selected.tier && `${selected.tier}등급`].filter(Boolean).join(" · ")}</span>
          )}
          {s && s.open > 0 && <span className="muted">진행 {s.open}</span>}
          <span className="spacer" />
          {onOpenCompany && createdId !== selected.id && (
            <Button variant="ghost" size="sm" onClick={() => onOpenCompany(selected.id)}>회사 정보 →</Button>
          )}
          <IconButton icon="close" size="sm" label="다른 회사 선택" onClick={clear} />
        </div>
        {createdId === selected.id && <div className="field-note">상세 정보는 회사 메뉴에서 입력할 수 있어요</div>}
      </div>
    );
  }

  const activeId = open && optionCount > 0 ? `${listId}-${active}` : undefined;

  return (
    <div className="company-combo" ref={boxRef}>
      <Input
        ref={(el) => {
          localInput.current = el;
          if (typeof inputRef === "function") inputRef(el);
          else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label="회사"
        placeholder="회사 검색 또는 새로 만들기"
        value={query}
        maxLength={COMPANY_NAME_MAX + 20}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setError(null);
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
            // 폼 제출 대신 선택/생성
            e.preventDefault();
            if (open && optionCount) choose(active);
          } else if (e.key === "Escape" && open) {
            // 모달 닫기보다 드롭다운 닫기를 먼저
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setOpen(false);
          }
        }}
      />
      {open && (
        <div className="combo-pop" id={listId} role="listbox" aria-label="회사 검색 결과">
          <div className="combo-meta" aria-live="polite">
            {name ? (results.length ? `${results.length}개 회사` : "일치하는 회사가 없어요") : companies.length ? "회사를 검색하세요" : "등록된 회사가 없어요"}
          </div>
          {results.map((c, i) => {
            const s = stats[c.id];
            return (
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
                {exact?.id === c.id && <Badge tone="brand" shape="pill">일치</Badge>}
                <span className="spacer" />
                <span className="muted">{[c.industry, `진행 ${s?.open ?? 0}`].filter(Boolean).join(" · ")}</span>
              </div>
            );
          })}
          {canCreate && (
            <div
              id={`${listId}-${results.length}`}
              role="option"
              aria-selected={active === results.length}
              className={`combo-opt combo-create${active === results.length ? " on" : ""}`}
              onMouseEnter={() => setActive(results.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={create}
            >
              {creating ? "만드는 중…" : <>＋ &quot;{name}&quot; 새 회사로 생성</>}
            </div>
          )}
          {error && <div className="combo-error" role="alert">{error}</div>}
        </div>
      )}
      {suggestion && !open && (
        <div className="company-suggest">
          💡 이메일 도메인이 같은 회사: <b>{suggestion.name}</b>
          <span className="muted">({suggestion.emailDomain})</span>
          <span className="spacer" />
          <Button size="sm" onClick={() => pick(suggestion)}>선택</Button>
        </div>
      )}
    </div>
  );
}
