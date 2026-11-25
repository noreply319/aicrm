"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { MOBILE_QUERY, SIDEBAR_AUTO_RAIL_QUERY, SIDEBAR_KEY } from "@/lib/constants";
import { useOpenSettings } from "@/lib/settingsModal";
import type { Me } from "@/lib/types";
import { Avatar, Badge, Icon, IconButton, type IconName } from "./ui";

export type View = "assistant" | "agent" | "pipeline" | "companies" | "contacts" | "meetings" | "contracts" | "calendar";

export const NAV: { view: View; href: string; label: string; icon: IconName }[] = [
  { view: "assistant", href: "/", label: "AI Assistant", icon: "sparkle" },
  { view: "agent", href: "/agent", label: "Sales Agent", icon: "agent" },
  { view: "pipeline", href: "/pipeline", label: "파이프라인", icon: "pipeline" },
  { view: "companies", href: "/companies", label: "회사", icon: "building" },
  { view: "contacts", href: "/contacts", label: "연락처", icon: "users" },
  { view: "meetings", href: "/meetings", label: "미팅 노트", icon: "notes" },
  { view: "contracts", href: "/contracts", label: "계약서", icon: "contract" },
  { view: "calendar", href: "/calendar", label: "캘린더", icon: "calendar" },
];

interface Props {
  view: View;
  me: Me | null;
  onLogout: () => void;
  /** 메뉴를 골랐을 때 (모바일: 전체 화면 메뉴·AI 채팅 닫기) */
  onNavigate: () => void;
  /** 모바일(640px 이하): 상단 바 햄버거 버튼으로 여는 전체 화면 메뉴 */
  menuOpen: boolean;
  onCloseMenu: () => void;
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

/**
 * 모바일 전체 화면 메뉴가 열려 있는 동안: Esc로 닫기, 뒤 화면 스크롤 막기, 닫기 버튼에 포커스.
 * 화면이 넓어져(641px 이상) 일반 사이드바가 되면 닫고, 닫힐 때 포커스를 햄버거 버튼으로 되돌린다.
 */
function useMobileMenu(open: boolean, onClose: () => void, menuRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.classList.add("menu-open");
    menuRef.current?.querySelector<HTMLButtonElement>(".side-close")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const mq = window.matchMedia(MOBILE_QUERY);
    const onMq = (e: MediaQueryListEvent) => !e.matches && onClose();
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onMq);
    return () => {
      root.classList.remove("menu-open");
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onMq);
      // 메뉴 안에 포커스가 남아 있으면(닫기 버튼·Esc) 연 버튼으로 되돌린다. 메뉴 이동은 새 화면에 맡긴다
      if (menuRef.current?.contains(document.activeElement)) opener?.focus();
    };
  }, [open, onClose, menuRef]);
}

/**
 * 왼쪽 메뉴: 브랜드 · 메뉴 · 접기 · 프로필. 1024px 이하 자동 아이콘 레일.
 * 640px 이하(모바일)는 평소 숨기고, 상단 바 왼쪽 햄버거 버튼으로 화면 전체를 덮는 메뉴로 연다.
 */
export default function Sidebar({ view, me, onLogout, onNavigate, menuOpen, onCloseMenu }: Props) {
  const { collapsed, toggle } = useSidebarCollapse();
  const toggleLabel = collapsed ? "메뉴 펼치기" : "메뉴 접기";
  const menuRef = useRef<HTMLElement>(null);
  useMobileMenu(menuOpen, onCloseMenu, menuRef);
  return (
    <aside id="app-menu" ref={menuRef} className={`sidebar${menuOpen ? " menu-open" : ""}`}>
      <div className="brand">
        <div className="logo" aria-hidden>◆</div>
        <span className="brand-text">Pipeline CRM</span>
        {/* 모바일 전체 화면 메뉴 닫기 */}
        <IconButton className="side-close" icon="close" label="메뉴 닫기" onClick={onCloseMenu} />
      </div>
      <div className="side-section">메뉴</div>
      <nav className="side-nav" aria-label="메뉴">
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
        <UserMenu me={me} onLogout={onLogout} onOpenSettings={onCloseMenu} />
      </div>
    </aside>
  );
}

export const STATE_LABEL = { connected: "연동됨", expired: "연동 만료", none: "연동 안 됨" } as const;
export const STATE_TONE = { connected: "success", expired: "warning", none: "neutral" } as const;

/** 프로필 버튼 → 계정·연동 상태·설정(모달)·로그아웃 (위쪽으로 열림) */
function UserMenu({ me, onLogout, onOpenSettings }: { me: Me | null; onLogout: () => void; onOpenSettings: () => void }) {
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
              onOpenSettings();
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
