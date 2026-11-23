"use client";

import { THEME_KEY } from "@/lib/constants";

interface Props {
  query: string;
  onQuery: (q: string) => void;
  onAdd: () => void;
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

export default function Header({ query, onQuery, onAdd }: Props) {
  return (
    <header className="header">
      <div className="brand">
        <div className="logo">◆</div> Pipeline CRM
      </div>
      <div className="search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          placeholder="회사, 담당자, 메모 검색…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="spacer" />
      <button className="btn icon-btn" title="테마 전환" onClick={toggleTheme}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      </button>
      <button className="btn btn-primary" onClick={onAdd}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M12 5v14M5 12h14" />
        </svg>
        새 리드
      </button>
    </header>
  );
}
