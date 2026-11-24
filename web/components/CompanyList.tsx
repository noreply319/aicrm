"use client";

import { useMemo, useState } from "react";
import { companyKey, emptyStats, type CompanyStats } from "@/lib/company";
import { COMPANY_TIERS } from "@/lib/constants";
import { formatWon } from "@/lib/format";
import type { Company, CompanyTier, TeamMember } from "@/lib/types";
import { Badge, Button, EmptyState, Select, type BadgeTone } from "./ui";

/** 등급 배지 색 */
export const TIER_TONE: Record<CompanyTier, BadgeTone> = { A: "brand", B: "info", C: "neutral" };

export function TierBadge({ tier }: { tier: CompanyTier }) {
  return <Badge tone={TIER_TONE[tier]} shape="pill" title={`${tier}등급`}>{tier}</Badge>;
}

interface Props {
  companies: Company[];
  stats: Record<string, CompanyStats>;
  team: TeamMember[];
  meId: string | null;
  query: string;
  ready: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}

type Sort = "pipeline" | "name" | "recent";

/** 상세 정보가 하나도 없는 회사 (리드에서 이름만으로 만든 회사 등) */
export const isBareCompany = (c: Company) =>
  !c.industry && !c.website && !c.emailDomain && !c.size && !c.phone && !c.address && !c.businessNumber && !c.ceoName && !c.notes;

const relative = (ms: number) => {
  if (!ms) return "—";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days < 7) return `${days}일 전`;
  if (days < 30) return `${Math.floor(days / 7)}주 전`;
  return `${Math.floor(days / 30)}달 전`;
};

export default function CompanyList({ companies, stats, team, meId, query, ready, onOpen, onNew }: Props) {
  const [mine, setMine] = useState(false);
  const [tier, setTier] = useState<CompanyTier | "">("");
  const [industry, setIndustry] = useState("");
  const [hasOpen, setHasOpen] = useState(false);
  const [sort, setSort] = useState<Sort>("pipeline");

  const ownerName = useMemo(() => new Map(team.map((m) => [m.id, m.name])), [team]);
  const industries = useMemo(
    () => [...new Set(companies.map((c) => c.industry).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    [companies]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qKey = companyKey(query.trim());
    const list = companies.filter((c) => {
      const s = stats[c.id];
      if (mine && c.ownerId !== meId) return false;
      if (tier && c.tier !== tier) return false;
      if (industry && c.industry !== industry) return false;
      if (hasOpen && !(s && s.open > 0)) return false;
      if (!q) return true;
      return (
        companyKey(c.name).includes(qKey) ||
        [c.industry, c.emailDomain ?? "", ...c.tags].some((v) => v.toLowerCase().includes(q))
      );
    });
    const st = (c: Company) => stats[c.id] ?? emptyStats();
    return list.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name, "ko")
        : sort === "recent" ? Math.max(st(b).lastLeadAt, Date.parse(b.updatedAt)) - Math.max(st(a).lastLeadAt, Date.parse(a.updatedAt))
          : st(b).pipelineValue - st(a).pipelineValue || a.name.localeCompare(b.name, "ko")
    );
  }, [companies, stats, mine, meId, tier, industry, hasOpen, query, sort]);

  if (!ready) return <div className="loading">불러오는 중…</div>;

  return (
    <main className="companies">
      <div className="toolbar">
        <Button size="sm" active={mine} aria-pressed={mine} onClick={() => setMine((v) => !v)}>내 담당만</Button>
        <Select value={tier} onChange={(e) => setTier(e.target.value as CompanyTier | "")} aria-label="등급 필터">
          <option value="">등급: 전체</option>
          {COMPANY_TIERS.map((t) => <option key={t} value={t}>{t}등급</option>)}
        </Select>
        <Select value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="업종 필터">
          <option value="">업종: 전체</option>
          {industries.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>
        <Button size="sm" active={hasOpen} aria-pressed={hasOpen} onClick={() => setHasOpen((v) => !v)}>진행 리드 있음</Button>
        <span className="spacer" />
        <span className="meetings-count">{visible.length}개 회사</span>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="정렬">
          <option value="pipeline">파이프라인 금액순</option>
          <option value="name">이름순</option>
          <option value="recent">최근 변경순</option>
        </Select>
      </div>

      {companies.length === 0 ? (
        <EmptyState
          icon="🏢"
          title="등록된 회사가 없어요"
          description="회사를 등록하거나, 리드를 등록할 때 바로 만들 수 있어요."
          action={<Button variant="primary" icon="plus" onClick={onNew}>회사 등록</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState icon="🔍" title="조건에 맞는 회사가 없어요" description="검색어나 필터를 바꿔 보세요." />
      ) : (
        <>
          <table className="company-table">
            <thead>
              <tr>
                <th>회사명</th><th>업종 · 규모</th><th>담당 영업</th><th>등급</th><th>태그</th>
                <th className="num">진행 리드</th><th className="num">파이프라인</th><th className="num">수주</th><th>최근 리드</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const s = stats[c.id] ?? emptyStats();
                return (
                  <tr key={c.id} tabIndex={0} onClick={() => onOpen(c.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(c.id)}>
                    <td>
                      <div className="company-name-cell">
                        <b>{c.name}</b>
                        {isBareCompany(c) && <Badge tone="warning" shape="pill">정보 미입력</Badge>}
                      </div>
                      {c.emailDomain && <div className="muted">{c.emailDomain}</div>}
                    </td>
                    <td>{[c.industry, c.size && `${c.size}명`].filter(Boolean).join(" · ") || <span className="muted">—</span>}</td>
                    <td>{(c.ownerId && ownerName.get(c.ownerId)) || <span className="muted">—</span>}</td>
                    <td>{c.tier ? <TierBadge tier={c.tier} /> : <span className="muted">—</span>}</td>
                    <td><span className="company-tags">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span></td>
                    <td className="num">{s.open}</td>
                    <td className="num">{s.pipelineValue ? formatWon(s.pipelineValue) : "—"}</td>
                    <td className="num">{s.wonValue ? formatWon(s.wonValue) : "—"}</td>
                    <td className="muted">{relative(s.lastLeadAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* 모바일: 카드 목록 */}
          <div className="company-cards">
            {visible.map((c) => {
              const s = stats[c.id] ?? emptyStats();
              return (
                <div key={c.id} role="button" tabIndex={0} className="company-card" onClick={() => onOpen(c.id)}
                  onKeyDown={(e) => e.key === "Enter" && onOpen(c.id)}>
                  <div className="company-name-cell">
                    <b>{c.name}</b>
                    {c.tier && <TierBadge tier={c.tier} />}
                    {isBareCompany(c) && <Badge tone="warning" shape="pill">정보 미입력</Badge>}
                  </div>
                  <div className="muted">
                    {[c.industry, c.size && `${c.size}명`, c.ownerId && ownerName.get(c.ownerId)].filter(Boolean).join(" · ")}
                  </div>
                  <div className="company-card-foot">
                    <span>진행 {s.open}건</span>
                    <b>{formatWon(s.pipelineValue)}</b>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
