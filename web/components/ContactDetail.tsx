"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { emptyStats, type CompanyStats } from "@/lib/company";
import { positionOf } from "@/lib/contact";
import { STAGES } from "@/lib/constants";
import { formatDateTime, formatWon } from "@/lib/format";
import type { Company, Contact, Lead, TeamMember } from "@/lib/types";
import { RoleBadge } from "./ContactList";
import { Avatar, Badge, Button, EmptyState, Icon, Panel, buttonClass } from "./ui";

interface Props {
  contact: Contact | null;
  company: Company | null;
  ready: boolean;
  stats: CompanyStats | undefined;
  /** 이 연락처가 담당자인 리드 */
  leads: Lead[];
  team: TeamMember[];
  onEdit: () => void;
  onOpenLead: (id: string) => void;
  onAddLead: () => void;
}

const STAGE_ORDER = new Map(STAGES.map((s, i) => [s.id, i]));
const groupOf = (l: Lead) => (l.stage === "won" ? 1 : l.stage === "lost" ? 2 : 0);

export default function ContactDetail({ contact, company, ready, stats, leads, team, onEdit, onOpenLead, onAddLead }: Props) {
  if (!ready) return <div className="loading">불러오는 중…</div>;
  if (!contact) {
    return (
      <main className="companies">
        <EmptyState
          icon="🔍"
          title="연락처를 찾을 수 없어요"
          description="삭제되었거나 주소가 잘못되었어요."
          action={<Link className={buttonClass()} href="/contacts">연락처 목록으로</Link>}
        />
      </main>
    );
  }

  const s = stats ?? emptyStats();
  const owner = contact.ownerId ? team.find((m) => m.id === contact.ownerId)?.name : undefined;
  const phone = contact.mobile || contact.officePhone;
  const sorted = [...leads].sort(
    (a, b) => groupOf(a) - groupOf(b) || (STAGE_ORDER.get(b.stage) ?? 0) - (STAGE_ORDER.get(a.stage) ?? 0) || b.value - a.value
  );
  const info: [string, ReactNode][] = [
    ["회사", company && <Link href={`/companies/${company.id}`}>{company.name}</Link>],
    ["부서 · 직함", positionOf(contact)],
    ["이메일", contact.email],
    ["휴대폰", contact.mobile],
    ["유선 전화", contact.officePhone],
    ["LinkedIn", contact.linkedinUrl && (
      <a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer">{contact.linkedinUrl.replace(/^https?:\/\/(www\.)?/, "")}</a>
    )],
    ["담당 영업", owner],
  ];

  return (
    <main className="companies company-detail">
      <div className="company-head">
        <Link href="/contacts" className="muted">← 연락처 목록</Link>
        <div className="company-title">
          <Avatar name={contact.name} size="lg" />
          <div className="contact-title-text">
            <div className="company-title">
              <h1>{contact.name}</h1>
              {contact.role && <RoleBadge role={contact.role} />}
              {contact.tags.map((t) => <Badge key={t}>{t}</Badge>)}
            </div>
            <div className="muted">
              {[company?.name ?? "(회사 없음)", positionOf(contact)].filter(Boolean).join(" · ")}
            </div>
          </div>
          <span className="spacer" />
          {contact.email && <Button size="sm" href={`mailto:${contact.email}`}><Icon name="mail" size={14} /> 메일</Button>}
          {phone && <Button size="sm" href={`tel:${phone.replace(/[^\d+]/g, "")}`}><Icon name="phone" size={14} /> 전화</Button>}
          <Button icon="edit" onClick={onEdit}>수정</Button>
        </div>
      </div>

      <div className="company-cols">
        <Panel title="연락처 정보">
          <dl className="company-info">
            {info.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v || <span className="muted">—</span>}</dd></div>
            ))}
            <div className="full"><dt>메모</dt><dd className="pre">{contact.notes || <span className="muted">—</span>}</dd></div>
          </dl>
          <div className="muted company-meta">등록 {formatDateTime(contact.createdAt).slice(0, 10)} · 수정 {formatDateTime(contact.updatedAt).slice(0, 10)}</div>
        </Panel>
        <Panel
          title={`연결된 리드 ${leads.length}`}
          actions={<Button variant="primary" size="sm" icon="plus" onClick={onAddLead}>이 사람으로 리드 추가</Button>}
        >
          {leads.length > 0 && (
            <div className="muted contact-lead-summary">
              진행 {s.open}건 · 파이프라인 {formatWon(s.pipelineValue)} · 수주 {formatWon(s.wonValue)}
            </div>
          )}
          {sorted.length === 0 ? (
            <EmptyState small title="이 사람이 담당자인 리드가 없어요" />
          ) : (
            <div className="company-leads">
              {sorted.map((l) => {
                const stage = STAGES.find((x) => x.id === l.stage);
                return (
                  <div key={l.id} role="button" tabIndex={0} className="company-lead" onClick={() => onOpenLead(l.id)}
                    onKeyDown={(e) => e.key === "Enter" && onOpenLead(l.id)}>
                    {stage && <Badge color={stage.color} shape="pill">{stage.name}</Badge>}
                    <b>{l.company}</b>
                    <span className="muted ellipsis">{l.notes.split("\n")[0]}</span>
                    <span className="spacer" />
                    <span className="company-lead-value">{formatWon(l.value)}</span>
                    <span className="muted">{l.closeDate ? `~${l.closeDate.slice(5).replace("-", "/")}` : "—"}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}
