"use client";

import Link from "next/link";
import { THEME_KEY } from "@/lib/constants";

export type View = "pipeline" | "meetings";

interface Props {
  view: View;
  query: string;
  onQuery: (q: string) => void;
  onAdd: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
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
];

export default function Header({ view, query, onQuery, onAdd, assistantOpen, onToggleAssistant }: Props) {
  const addLabel = view === "meetings" ? "노트 작성" : "새 리드";
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
      <div className="search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          placeholder={view === "meetings" ? "제목, 본문, 회사명 검색…" : "회사, 담당자, 메모 검색…"}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
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
        <button className="btn btn-primary hide-mobile" onClick={onAdd}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {addLabel}
        </button>
      </div>
      {/* 모바일: 오른쪽 아래 플로팅 버튼 */}
      <button className="fab" onClick={onAdd} aria-label={addLabel} title={addLabel}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </header>
  );
}
