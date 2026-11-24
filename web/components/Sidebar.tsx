"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SIDEBAR_AUTO_RAIL_QUERY, SIDEBAR_KEY } from "@/lib/constants";
import { useOpenSettings } from "@/lib/settingsModal";
import type { Me } from "@/lib/types";
import { Avatar, Badge, Icon, type IconName } from "./ui";

export type View = "pipeline" | "meetings" | "calendar";

export const NAV: { view: View; href: string; label: string; icon: IconName }[] = [
  { view: "pipeline", href: "/", label: "파이프라인", icon: "pipeline" },
  { view: "meetings", href: "/meetings", label: "미팅 노트", icon: "notes" },
  { view: "calendar", href: "/calendar", label: "캘린더", icon: "calendar" },
];

interface Props {
  view: View;
  me: Me | null;
  onLogout: () => void;
  /** 모바일 하단 탭의 AI 메뉴: Assistant 열림 상태·토글, 다른 메뉴로 가면 닫기 */
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  onNavigate: () => void;
}

/**
 * 메뉴 접힘 상태: 사용자가 접었거나(저장) 화면이 좁으면(1024px 이하) <html>에 sb-collapsed.
 * 첫 페인트 전 적용은 app/layout.tsx의 스크립트, 이후 변경은 여기서 한다.
 */
function useSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(false);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "collapsed");
    } catch {}
    const mq = window.matchMedia(SIDEBAR_AUTO_RAIL_QUERY);
    setNarrow(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("sb-collapsed", collapsed || narrow);
  }, [collapsed, narrow]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
    } catch {}
  };
  return { collapsed, toggle };
}

/** 왼쪽 메뉴: 브랜드 · 메뉴 · 접기 · 프로필. 1024px 이하 자동 아이콘 레일, 640px 이하 하단 탭 바 */
export default function Sidebar({ view, me, onLogout, assistantOpen, onToggleAssistant, onNavigate }: Props) {
  const { collapsed, toggle } = useSidebarCollapse();
  const toggleLabel = collapsed ? "메뉴 펼치기" : "메뉴 접기";
  return (
    <aside className={`sidebar${assistantOpen ? " ai-open" : ""}`}>
      <div className="brand">
        <div className="logo" aria-hidden>◆</div>
        <span className="brand-text">Pipeline CRM</span>
      </div>
      <div className="side-section">메뉴</div>
      <nav className="side-nav" aria-label="메뉴">
        {/* 모바일 하단 탭 맨 왼쪽: AI Assistant 채팅 (데스크톱은 상단 바 버튼·오른쪽 패널) */}
        <button
          type="button"
          className={`side-link side-ai${assistantOpen ? " on" : ""}`}
          aria-pressed={assistantOpen}
          title="AI Assistant"
          onClick={onToggleAssistant}
        >
          <Icon name="sparkle" size={18} />
          <span className="side-label">AI</span>
        </button>
        {NAV.map((n) => (
          <Link
            key={n.view}
            href={n.href}
            className={`side-link${view === n.view ? " on" : ""}`}
            aria-current={view === n.view ? "page" : undefined}
            title={n.label}
            onClick={onNavigate}
          >
            <Icon name={n.icon} size={18} />
            <span className="side-label">{n.label}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button
          type="button"
          className="side-link side-toggle"
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          <Icon name={collapsed ? "panelLeftOpen" : "panelLeft"} size={18} />
          <span className="side-label" aria-hidden>{toggleLabel}</span>
        </button>
        <UserMenu me={me} onLogout={onLogout} />
      </div>
    </aside>
  );
}

export const STATE_LABEL = { connected: "연동됨", expired: "연동 만료", none: "연동 안 됨" } as const;
export const STATE_TONE = { connected: "success", expired: "warning", none: "neutral" } as const;

/** 프로필 버튼 → 계정·연동 상태·설정(모달)·로그아웃 (위쪽으로 열림) */
function UserMenu({ me, onLogout }: { me: Me | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const openSettings = useOpenSettings();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!me) return null;
  const cal = me.calendar.state;
  const gmail = me.gmail.state;
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-btn" title={me.email} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Avatar name={me.name || me.email} src={me.picture} />
        <span className="user-btn-text">
          <b>{me.name || me.email}</b>
          <span>{me.email}</span>
        </span>
        {(cal === "expired" || gmail === "expired") && <i className="user-dot" title="구글 연동 만료" />}
      </button>
      {open && (
        <div className="user-pop" role="menu">
          <b>{me.name || me.email}</b>
          <div className="muted">{me.email}</div>
          <div className="user-pop-status">
            <div>캘린더 <Badge tone={STATE_TONE[cal]} shape="pill">{STATE_LABEL[cal]}</Badge></div>
            <div>Gmail <Badge tone={STATE_TONE[gmail]} shape="pill">{STATE_LABEL[gmail]}</Badge></div>
          </div>
          <button
            type="button"
            className="user-pop-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openSettings();
            }}
          >
            <Icon name="settings" size={15} /> 설정
          </button>
          <button type="button" className="user-pop-item" role="menuitem" onClick={onLogout}>
            <Icon name="logout" size={15} /> 로그아웃
          </button>
        </div>
      )}
    </div>
  );
}
