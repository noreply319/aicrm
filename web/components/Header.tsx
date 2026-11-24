"use client";

import { THEME_KEY } from "@/lib/constants";
import { NAV, type View } from "./Sidebar";
import { Badge, Button, Icon, IconButton, Input } from "./ui";

export type { View };

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

const ADD_LABEL: Partial<Record<View, string>> = { pipeline: "새 리드", companies: "회사 등록", contacts: "연락처 등록", meetings: "노트 작성", calendar: "일정 추가" };
const SEARCH_PLACEHOLDER: Partial<Record<View, string>> = {
  pipeline: "회사, 담당자, 메모 검색…",
  companies: "회사명, 업종, 도메인, 태그 검색…",
  contacts: "이름, 회사, 이메일, 부서, 태그 검색…",
  meetings: "제목, 본문, 회사명 검색…",
  calendar: "일정 제목, 장소, 회사명 검색…",
};

/** 상단 바: 화면 제목 · 검색 · 테마 · AI Assistant · 추가 버튼 (메뉴는 왼쪽 Sidebar) */
export default function Header({ view, query, onQuery, onAdd, assistantOpen, onToggleAssistant }: Props) {
  const addLabel = ADD_LABEL[view];
  const searchPlaceholder = SEARCH_PLACEHOLDER[view];
  const title = NAV.find((n) => n.view === view)?.label;
  return (
    <header className="topbar">
      <h1 className="page-title">{title}</h1>
      {searchPlaceholder && (
        <div className="search">
          <Icon name="search" size={15} />
          <Input
            type="search"
            aria-label="검색"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </div>
      )}
      <div className="spacer" />
      <div className="header-actions">
        <IconButton icon="moon" label="테마 전환" onClick={toggleTheme} />
        <Button
          active={assistantOpen}
          title="AI Assistant 열기/닫기"
          aria-pressed={assistantOpen}
          onClick={onToggleAssistant}
        >
          <Badge tone="brand">AI</Badge>
          <span className="hide-mobile">Assistant</span>
        </Button>
        {addLabel && (
          <Button variant="primary" icon="plus" className="hide-mobile" onClick={onAdd}>
            {addLabel}
          </Button>
        )}
      </div>
      {/* 모바일: 오른쪽 아래 플로팅 버튼 */}
      {addLabel && (
        <button type="button" className="fab" onClick={onAdd} aria-label={addLabel} title={addLabel}>
          <Icon name="plus" size={22} strokeWidth={2.4} />
        </button>
      )}
    </header>
  );
}
