"use client";

import { useMemo, useState, type MouseEvent } from "react";
import { emptyStats, type CompanyStats } from "@/lib/company";
import { personKey, positionOf } from "@/lib/contact";
import { CONTACT_ROLE_LABEL, CONTACT_ROLES } from "@/lib/constants";
import type { Company, Contact, ContactRole, TeamMember } from "@/lib/types";
import { Badge, Button, EmptyState, Select } from "./ui";

/** 역할 배지 (의사결정자만 강조) */
export function RoleBadge({ role }: { role: ContactRole }) {
  return <Badge tone={role === "decision_maker" ? "brand" : role === "influencer" ? "info" : "neutral"} shape="pill">{CONTACT_ROLE_LABEL[role]}</Badge>;
}

interface Props {
  contacts: Contact[];
  companies: Company[];
  stats: Record<string, CompanyStats>;
  team: TeamMember[];
  meId: string | null;
  query: string;
  ready: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}

type Sort = "name" | "created" | "recent";
const NO_COMPANY = "__none__";

const relative = (ms: number) => {
  if (!ms) return "—";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days < 7) return `${days}일 전`;
  if (days < 30) return `${Math.floor(days / 7)}주 전`;
  return `${Math.floor(days / 30)}달 전`;
};

/** 메일·전화 링크는 행 클릭(상세 이동)과 분리 */
const stop = (e: MouseEvent) => e.stopPropagation();

export default function ContactList({ contacts, companies, stats, team, meId, query, ready, onOpen, onNew }: Props) {
  const [mine, setMine] = useState(false);
  const [role, setRole] = useState<ContactRole | "">("");
  const [company, setCompany] = useState("");
  const [hasOpen, setHasOpen] = useState(false);
  const [sort, setSort] = useState<Sort>("name");

  const ownerName = useMemo(() => new Map(team.map((m) => [m.id, m.name])), [team]);
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  // 필터 목록: 연락처가 있는 회사만
  const companyOptions = useMemo(
    () => companies.filter((c) => contacts.some((x) => x.companyId === c.id)),
    [companies, contacts]
  );

  const visible = useMemo(() => {
    const q = personKey(query.trim());
    const list = contacts.filter((c) => {
      if (mine && c.ownerId !== meId) return false;
      if (role && c.role !== role) return false;
      if (company === NO_COMPANY ? c.companyId !== null : company && c.companyId !== company) return false;
      if (hasOpen && !((stats[c.id]?.open ?? 0) > 0)) return false;
      if (!q) return true;
      const co = c.companyId ? companyName.get(c.companyId) ?? "" : "";
      return [c.name, co, c.email, c.department, c.title, ...c.tags].some((v) => personKey(v).includes(q));
    });
    const st = (c: Contact) => stats[c.id] ?? emptyStats();
    return list.sort((a, b) =>
      sort === "created" ? Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : sort === "recent" ? st(b).lastLeadAt - st(a).lastLeadAt || a.name.localeCompare(b.name, "ko")
          : a.name.localeCompare(b.name, "ko")
    );
  }, [contacts, stats, mine, meId, role, company, hasOpen, query, sort, companyName]);

  if (!ready) return <div className="loading">불러오는 중…</div>;

  return (
    <main className="companies contacts">
      <div className="toolbar">
        <Button size="sm" active={mine} aria-pressed={mine} onClick={() => setMine((v) => !v)}>내 담당만</Button>
        <Select value={role} onChange={(e) => setRole(e.target.value as ContactRole | "")} aria-label="역할 필터">
          <option value="">역할: 전체</option>
          {CONTACT_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </Select>
        <Select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="회사 필터">
          <option value="">회사: 전체</option>
          <option value={NO_COMPANY}>(회사 없음)</option>
          {companyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Button size="sm" active={hasOpen} aria-pressed={hasOpen} onClick={() => setHasOpen((v) => !v)}>진행 리드 있음</Button>
        <span className="spacer" />
        <span className="meetings-count">{visible.length}명</span>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="정렬">
          <option value="name">이름순</option>
          <option value="created">최근 등록순</option>
          <option value="recent">최근 리드순</option>
        </Select>
      </div>

      {contacts.length === 0 ? (
        <EmptyState
          icon="👤"
          title="등록된 연락처가 없어요"
          description="연락처를 등록하거나, 리드를 등록할 때 담당자를 바로 만들 수 있어요."
          action={<Button variant="primary" icon="plus" onClick={onNew}>연락처 등록</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState icon="🔍" title="조건에 맞는 연락처가 없어요" description="검색어나 필터를 바꿔 보세요." />
      ) : (
        <>
          <div className="table-wrap">
          <table className="company-table contact-table">
            <thead>
              <tr>
                <th>이름</th><th>회사</th><th>부서 · 직함</th><th>이메일</th><th>휴대폰</th><th>담당 영업</th><th>태그</th>
                <th className="num">진행 리드</th><th>최근 리드</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const s = stats[c.id] ?? emptyStats();
                const phone = c.mobile || c.officePhone;
                return (
                  <tr key={c.id} tabIndex={0} onClick={() => onOpen(c.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(c.id)}>
                    <td><div className="company-name-cell"><b>{c.name}</b>{c.role && <RoleBadge role={c.role} />}</div></td>
                    <td>{c.companyId ? companyName.get(c.companyId) : <span className="muted">(회사 없음)</span>}</td>
                    <td>{positionOf(c) || <span className="muted">—</span>}</td>
                    <td>{c.email ? <a href={`mailto:${c.email}`} onClick={stop}>{c.email}</a> : <span className="muted">—</span>}</td>
                    <td className="nowrap">{phone ? <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} onClick={stop}>{phone}</a> : <span className="muted">—</span>}</td>
                    <td>{(c.ownerId && ownerName.get(c.ownerId)) || <span className="muted">—</span>}</td>
                    <td><span className="company-tags">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span></td>
                    <td className="num">{s.open}</td>
                    <td className="muted">{relative(s.lastLeadAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {/* 모바일: 카드 목록 (전화·메일 바로 걸기) */}
          <div className="company-cards">
            {visible.map((c) => {
              const phone = c.mobile || c.officePhone;
              return (
                <div key={c.id} role="button" tabIndex={0} className="company-card" onClick={() => onOpen(c.id)}
                  onKeyDown={(e) => e.key === "Enter" && onOpen(c.id)}>
                  <div className="company-name-cell">
                    <b>{c.name}</b>
                    {c.role && <RoleBadge role={c.role} />}
                    <span className="spacer" />
                    {phone && <a className="contact-quick-link" href={`tel:${phone.replace(/[^\d+]/g, "")}`} onClick={stop} aria-label={`${c.name}에게 전화`}>☎</a>}
                    {c.email && <a className="contact-quick-link" href={`mailto:${c.email}`} onClick={stop} aria-label={`${c.name}에게 메일`}>✉</a>}
                  </div>
                  <div className="muted">
                    {[c.companyId ? companyName.get(c.companyId) : "(회사 없음)", positionOf(c)].filter(Boolean).join(" · ")}
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
