"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { THEME_KEY } from "@/lib/constants";
import type { Me } from "@/lib/types";

export type View = "pipeline" | "meetings" | "calendar" | "settings";

interface Props {
  view: View;
  query: string;
  onQuery: (q: string) => void;
  onAdd: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  me: Me | null;
  onLogout: () => void;
}

function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.dataset.theme
    ? root.dataset.theme === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  const next = isDark ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}
}

const NAV: { view: View; href: string; label: string }[] = [
  { view: "pipeline", href: "/", label: "파이프라인" },
  { view: "meetings", href: "/meetings", label: "미팅 노트" },
  { view: "calendar", href: "/calendar", label: "캘린더" },
  { view: "settings", href: "/settings", label: "설정" },
];

const ADD_LABEL: Partial<Record<View, string>> = { pipeline: "새 리드", meetings: "노트 작성", calendar: "일정 추가" };
const SEARCH_PLACEHOLDER: Partial<Record<View, string>> = {
  pipeline: "회사, 담당자, 메모 검색…",
  meetings: "제목, 본문, 회사명 검색…",
  calendar: "일정 제목, 장소, 회사명 검색…",
};

export default function Header({ view, query, onQuery, onAdd, assistantOpen, onToggleAssistant, me, onLogout }: Props) {
  const addLabel = ADD_LABEL[view];
  const searchPlaceholder = SEARCH_PLACEHOLDER[view];
  return (
    <header className="header">
      <div className="brand">
        <div className="logo">◆</div> Pipeline CRM
      </div>
      <nav className="nav-tabs" aria-label="메뉴">
        {NAV.map((n) => (
          <Link
            key={n.view}
            href={n.href}
            className={view === n.view ? "on" : ""}
            aria-current={view === n.view ? "page" : undefined}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      {searchPlaceholder && <div className="search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>}
      <div className="spacer header-spacer" />
      <div className="header-actions">
        <button className="btn icon-btn" title="테마 전환" onClick={toggleTheme}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        </button>
        <button
          className={`btn${assistantOpen ? " btn-active" : ""}`}
          title="AI Assistant 열기/닫기"
          aria-pressed={assistantOpen}
          onClick={onToggleAssistant}
        >
          <span className="assistant-badge">AI</span>
          <span className="hide-mobile">Assistant</span>
        </button>
        {addLabel && (
          <button className="btn btn-primary hide-mobile" onClick={onAdd}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {addLabel}
          </button>
        )}
        <UserMenu me={me} onLogout={onLogout} />
      </div>
      {/* 모바일: 오른쪽 아래 플로팅 버튼 */}
      {addLabel && (
        <button className="fab" onClick={onAdd} aria-label={addLabel} title={addLabel}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
    </header>
  );
}

/** 프로필 버튼 → 계정·캘린더 상태·로그아웃 */
function UserMenu({ me, onLogout }: { me: Me | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!me) return null;
  const initial = (me.name || me.email).slice(0, 1).toUpperCase();
  const cal = me.calendar.state;
  const gmail = me.gmail.state;
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-btn" title={me.email} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {me.picture ? <img src={me.picture} alt="" referrerPolicy="no-referrer" /> : <span>{initial}</span>}
        {(cal === "expired" || gmail === "expired") && <i className="user-dot" title="구글 연동 만료" />}
      </button>
      {open && (
        <div className="user-pop" role="menu">
          <b>{me.name || me.email}</b>
          <div className="muted">{me.email}</div>
          <div className="user-pop-cal">
            📅 캘린더 {cal === "connected" ? "연동됨" : cal === "expired" ? "연동 만료" : "연동 안 됨"}
          </div>
          <div className="user-pop-cal">
            ✉️ Gmail {gmail === "connected" ? "연동됨" : gmail === "expired" ? "연동 만료" : "연동 안 됨"}
          </div>
          <Link href="/settings" className="user-pop-item" onClick={() => setOpen(false)}>설정</Link>
          <button type="button" className="user-pop-item" onClick={onLogout}>로그아웃</button>
        </div>
      )}
    </div>
  );
}
