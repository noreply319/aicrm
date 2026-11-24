"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Me } from "@/lib/types";
import { Avatar, Badge, Icon, type IconName } from "./ui";

export type View = "pipeline" | "companies" | "contacts" | "meetings" | "calendar" | "settings";

export const NAV: { view: View; href: string; label: string; icon: IconName }[] = [
  { view: "pipeline", href: "/", label: "파이프라인", icon: "pipeline" },
  { view: "companies", href: "/companies", label: "회사", icon: "building" },
  { view: "contacts", href: "/contacts", label: "연락처", icon: "users" },
  { view: "meetings", href: "/meetings", label: "미팅 노트", icon: "notes" },
  { view: "calendar", href: "/calendar", label: "캘린더", icon: "calendar" },
  { view: "settings", href: "/settings", label: "설정", icon: "settings" },
];

interface Props {
  view: View;
  me: Me | null;
  onLogout: () => void;
}

/** 왼쪽 메뉴: 브랜드 · 메뉴 · 프로필. 1024px 이하 아이콘 레일, 640px 이하 하단 탭 바 */
export default function Sidebar({ view, me, onLogout }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo" aria-hidden>◆</div>
        <span className="brand-text">Pipeline CRM</span>
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
          >
            <Icon name={n.icon} size={18} />
            <span className="side-label">{n.label}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-foot">
        <UserMenu me={me} onLogout={onLogout} />
      </div>
    </aside>
  );
}

export const STATE_LABEL = { connected: "연동됨", expired: "연동 만료", none: "연동 안 됨" } as const;
export const STATE_TONE = { connected: "success", expired: "warning", none: "neutral" } as const;

/** 프로필 버튼 → 계정·연동 상태·로그아웃 (위쪽으로 열림) */
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
          <Link href="/settings" className="user-pop-item" onClick={() => setOpen(false)}>
            <Icon name="settings" size={15} /> 설정
          </Link>
          <button type="button" className="user-pop-item" onClick={onLogout}>
            <Icon name="logout" size={15} /> 로그아웃
          </button>
        </div>
      )}
    </div>
  );
}
