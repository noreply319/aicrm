"use client";

import { useEffect, useRef, useState } from "react";
import { STAGES } from "@/lib/constants";
import type { Lead, LeadInput, MeetingNoteSummary, Priority, StageId } from "@/lib/types";
import NoteListItem from "./NoteListItem";

export type LeadModalTab = "info" | "notes";

interface Props {
  lead: Lead | null;
  defaultStage: StageId;
  /** 이 리드의 미팅 노트 (최신순) */
  notes: MeetingNoteSummary[];
  initialTab: LeadModalTab;
  onSave: (input: LeadInput) => void;
  onDelete?: () => void;
  onNewNote: () => void;
  onOpenNote: (id: string) => void;
  onClose: () => void;
}

const empty = (stage: StageId): LeadInput => ({
  company: "", contact: "", title: "", email: "", phone: "",
  value: 0, closeDate: "", stage, priority: "mid", notes: "",
});

export default function LeadModal({
  lead, defaultStage, notes, initialTab, onSave, onDelete, onNewNote, onOpenNote, onClose,
}: Props) {
  const [tab, setTab] = useState<LeadModalTab>(lead ? initialTab : "info");
  const [form, setForm] = useState<LeadInput>(() => {
    if (!lead) return empty(defaultStage);
    const { id: _id, createdAt: _c, ...rest } = lead;
    return rest;
  });
  const firstRef = useRef<HTMLInputElement>(null);

  // 처음 열 때 정보 탭이면 회사명 입력에 포커스
  const focusOnOpen = useRef(tab === "info");
  useEffect(() => {
    if (focusOnOpen.current) firstRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof LeadInput>(key: K, value: LeadInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...form, company: form.company.trim(), value: Number(form.value) || 0 });
        }}
      >
        <div className="modal-head">
          <h2>{lead ? lead.company : "새 리드 등록"}</h2>
        </div>
        {lead && (
          <div className="seg-tabs modal-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "info"} className={tab === "info" ? "on" : ""} onClick={() => setTab("info")}>
              리드 정보
            </button>
            <button type="button" role="tab" aria-selected={tab === "notes"} className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
              미팅 노트 ({notes.length})
            </button>
          </div>
        )}
        {tab === "notes" && (
          <div className="lead-notes">
            <div className="lead-notes-head">
              <span className="muted">미팅 일시 최신순</span>
              <span className="spacer" />
              <button type="button" className="btn btn-primary btn-sm" onClick={onNewNote}>＋ 노트 작성</button>
            </div>
            {notes.length === 0 ? (
              <div className="empty-state small">
                <div className="empty-icon">🗂</div>
                <b>이 리드의 미팅 노트가 없습니다</b>
              </div>
            ) : (
              <div className="note-list">
                {notes.map((n) => (
                  <NoteListItem key={n.id} note={n} onClick={() => onOpenNote(n.id)} />
                ))}
              </div>
            )}
          </div>
        )}
        <div className="modal-body" hidden={tab !== "info"}>
          <div className="field full">
            <label>회사명 *</label>
            <input ref={firstRef} required placeholder="예: 에이아이랩스"
              value={form.company} onChange={(e) => set("company", e.target.value)} />
          </div>
          <div className="field">
            <label>담당자</label>
            <input placeholder="홍길동" value={form.contact} onChange={(e) => set("contact", e.target.value)} />
          </div>
          <div className="field">
            <label>직책</label>
            <input placeholder="구매팀장" value={form.title} onChange={(e) => set("title", e.target.value)} />
          </div>
          <div className="field">
            <label>이메일</label>
            <input type="email" placeholder="name@company.com" value={form.email}
              onChange={(e) => set("email", e.target.value)} />
          </div>
          <div className="field">
            <label>전화번호</label>
            <input placeholder="010-0000-0000" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </div>
          <div className="field">
            <label>예상 금액 (원)</label>
            <input type="number" min={0} step={10000} placeholder="10000000"
              value={form.value || ""} onChange={(e) => set("value", Number(e.target.value))} />
          </div>
          <div className="field">
            <label>예상 마감일</label>
            <input type="date" value={form.closeDate} onChange={(e) => set("closeDate", e.target.value)} />
          </div>
          <div className="field">
            <label>단계</label>
            <select value={form.stage} onChange={(e) => set("stage", e.target.value as StageId)}>
              {STAGES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>우선순위</label>
            <select value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
              <option value="high">높음</option>
              <option value="mid">보통</option>
              <option value="low">낮음</option>
            </select>
          </div>
          <div className="field full">
            <label>메모</label>
            <textarea placeholder="리드 관련 메모" value={form.notes}
              onChange={(e) => set("notes", e.target.value)} />
          </div>
        </div>
        <div className="modal-foot">
          {onDelete && <button type="button" className="btn btn-danger" onClick={onDelete}>삭제</button>}
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>취소</button>
          <button type="submit" className="btn btn-primary">저장</button>
        </div>
      </form>
    </div>
  );
}
