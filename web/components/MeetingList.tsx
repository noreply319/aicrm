"use client";

import { useMemo, useState } from "react";
import type { Lead, MeetingNoteSummary } from "@/lib/types";
import NoteListItem from "./NoteListItem";
import { Button, EmptyState, Select } from "./ui";

interface Props {
  notes: MeetingNoteSummary[];
  leads: Lead[];
  query: string;
  ready: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}

type Period = "all" | "7" | "30" | "90";

// 리드 필터: "" 전체, UNASSIGNED 리드 미지정, 그 외 리드 id
const UNASSIGNED = "__unassigned__";

const PERIODS: { id: Period; label: string }[] = [
  { id: "all", label: "전체 기간" },
  { id: "7", label: "최근 7일" },
  { id: "30", label: "최근 30일" },
  { id: "90", label: "최근 90일" },
];

export default function MeetingList({ notes, leads, query, ready, onOpen, onNew }: Props) {
  const [leadFilter, setLeadFilter] = useState("");
  const [period, setPeriod] = useState<Period>("all");

  const leadById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);

  // 노트가 있는 리드만 필터 옵션으로
  const leadOptions = useMemo(() => {
    const ids = new Set(notes.map((n) => n.leadId));
    return leads.filter((l) => ids.has(l.id)).sort((a, b) => a.company.localeCompare(b.company, "ko"));
  }, [notes, leads]);

  const unassignedCount = useMemo(() => notes.filter((n) => n.leadId === null).length, [notes]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const since = period === "all" ? 0 : Date.now() - Number(period) * 86_400_000;
    return notes.filter((n) => {
      if (leadFilter === UNASSIGNED ? n.leadId !== null : leadFilter && n.leadId !== leadFilter) return false;
      if (since && new Date(n.metAt).getTime() < since) return false;
      if (!q) return true;
      const company = (n.leadId && leadById.get(n.leadId)?.company) || "";
      return [n.title, n.preview, n.summary, n.nextActions, company].some((v) => v.toLowerCase().includes(q));
    });
  }, [notes, leadFilter, period, query, leadById]);

  if (!ready) return <div className="loading">불러오는 중…</div>;

  return (
    <main className="meetings">
      <div className="toolbar">
        <Select value={leadFilter} onChange={(e) => setLeadFilter(e.target.value)} aria-label="리드 필터">
          <option value="">리드: 전체</option>
          {unassignedCount > 0 && <option value={UNASSIGNED}>리드 미지정 ({unassignedCount})</option>}
          {leadOptions.map((l) => (
            <option key={l.id} value={l.id}>{l.company}</option>
          ))}
        </Select>
        <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="기간 필터">
          {PERIODS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </Select>
        <span className="spacer" />
        <span className="meetings-count">총 {visible.length}건 · 미팅 일시 최신순</span>
      </div>

      {notes.length === 0 ? (
        <EmptyState
          icon="📝"
          title="아직 미팅 노트가 없습니다"
          description="미팅을 녹음하거나 회의록을 붙여넣어 기록해 보세요."
          action={<Button variant="primary" icon="plus" onClick={onNew}>노트 작성</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState icon="🔍" title="조건에 맞는 노트가 없습니다" description="검색어나 필터를 바꿔 보세요." />
      ) : (
        <div className="note-list">
          {visible.map((n) => (
            <NoteListItem
              key={n.id}
              note={n}
              lead={n.leadId ? leadById.get(n.leadId) : undefined}
              onClick={() => onOpen(n.id)}
            />
          ))}
        </div>
      )}
    </main>
  );
}
