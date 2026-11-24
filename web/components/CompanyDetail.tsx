"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { emptyStats, formatBusinessNumber, type CompanyStats } from "@/lib/company";
import { STAGES } from "@/lib/constants";
import { formatDateTime, formatWon } from "@/lib/format";
import type { Company, Lead, TeamMember } from "@/lib/types";
import { TierBadge } from "./CompanyList";
import { Badge, Button, EmptyState, Icon, Panel, buttonClass } from "./ui";

interface Props {
  company: Company | null;
  ready: boolean;
  stats: CompanyStats | undefined;
  /** 이 회사에 연결된 리드 */
  leads: Lead[];
  team: TeamMember[];
  onEdit: () => void;
  onOpenLead: (id: string) => void;
  onAddLead: () => void;
}

const STAGE_ORDER = new Map(STAGES.map((s, i) => [s.id, i]));
// 진행 중 → 수주 → 실주 순, 같은 그룹 안에서는 단계가 앞선(진척된) 리드 먼저
const groupOf = (l: Lead) => (l.stage === "won" ? 1 : l.stage === "lost" ? 2 : 0);

export default function CompanyDetail({ company, ready, stats, leads, team, onEdit, onOpenLead, onAddLead }: Props) {
  if (!ready) return <div className="loading">불러오는 중…</div>;
  if (!company) {
    return (
      <main className="companies">
        <EmptyState
          icon="🔍"
          title="회사를 찾을 수 없어요"
          description="삭제되었거나 주소가 잘못되었어요."
          action={<Link className={buttonClass()} href="/companies">회사 목록으로</Link>}
        />
      </main>
    );
  }

  const s = stats ?? emptyStats();
  const owner = company.ownerId ? team.find((m) => m.id === company.ownerId)?.name : undefined;
  const sorted = [...leads].sort(
    (a, b) => groupOf(a) - groupOf(b) || (STAGE_ORDER.get(b.stage) ?? 0) - (STAGE_ORDER.get(a.stage) ?? 0) || b.value - a.value
  );
  const info: [string, ReactNode][] = [
    ["업종", company.industry],
    ["규모", company.size && `${company.size}명`],
    ["이메일 도메인", company.emailDomain],
    ["대표 전화", company.phone],
    ["주소", company.address],
    ["사업자번호", company.businessNumber && formatBusinessNumber(company.businessNumber)],
    ["대표자", company.ceoName],
    ["담당 영업", owner],
  ];

  return (
    <main className="companies company-detail">
      <div className="company-head">
        <Link href="/companies" className="muted">← 회사 목록</Link>
        <div className="company-title">
          <h1>{company.name}</h1>
          {company.tier && <TierBadge tier={company.tier} />}
          {company.tags.map((t) => <Badge key={t}>{t}</Badge>)}
          {company.website && (
            <a href={company.website} target="_blank" rel="noopener noreferrer" className="muted">
              <Icon name="link" size={13} /> {company.website.replace(/^https?:\/\//, "")}
            </a>
          )}
          <span className="spacer" />
          <Button icon="edit" onClick={onEdit}>수정</Button>
        </div>
      </div>

      <div className="company-kpis">
        <div className="stat"><div className="label">진행 리드</div><div className="value">{s.open}건</div></div>
        <div className="stat"><div className="label">파이프라인</div><div className="value">{formatWon(s.pipelineValue)}</div></div>
        <div className="stat"><div className="label">수주</div><div className="value">{formatWon(s.wonValue)}</div><div className="muted">{s.won}건</div></div>
        <div className="stat"><div className="label">실주</div><div className="value">{s.lost}건</div></div>
      </div>

      <div className="company-cols">
        <Panel title="회사 정보">
          <dl className="company-info">
            {info.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v || <span className="muted">—</span>}</dd></div>
            ))}
            <div className="full"><dt>메모</dt><dd className="pre">{company.notes || <span className="muted">—</span>}</dd></div>
          </dl>
          <div className="muted company-meta">등록 {formatDateTime(company.createdAt).slice(0, 10)} · 수정 {formatDateTime(company.updatedAt).slice(0, 10)}</div>
        </Panel>
        <Panel
          title={`연결된 리드 ${leads.length}`}
          actions={<Button variant="primary" size="sm" icon="plus" onClick={onAddLead}>이 회사로 리드 추가</Button>}
        >
          {sorted.length === 0 ? (
            <EmptyState small title="연결된 리드가 없어요" />
          ) : (
            <div className="company-leads">
              {sorted.map((l) => {
                const stage = STAGES.find((x) => x.id === l.stage);
                return (
                  <div key={l.id} role="button" tabIndex={0} className="company-lead" onClick={() => onOpenLead(l.id)}
                    onKeyDown={(e) => e.key === "Enter" && onOpenLead(l.id)}>
                    {stage && <Badge color={stage.color} shape="pill">{stage.name}</Badge>}
                    <b>{l.contact || "(담당자 미정)"}</b>
                    <span className="muted ellipsis">{[l.title, l.notes.split("\n")[0]].filter(Boolean).join(" · ")}</span>
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
