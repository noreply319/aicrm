"use client";

import { useEffect, useRef, useState } from "react";
import { STAGES } from "@/lib/constants";
import type { Lead, LeadInput, Priority, StageId } from "@/lib/types";

interface Props {
  lead: Lead | null;
  defaultStage: StageId;
  onSave: (input: LeadInput) => void;
  onDelete?: () => void;
  onClose: () => void;
}

const empty = (stage: StageId): LeadInput => ({
  company: "", contact: "", title: "", email: "", phone: "",
  value: 0, closeDate: "", stage, priority: "mid", notes: "",
});

export default function LeadModal({ lead, defaultStage, onSave, onDelete, onClose }: Props) {
  const [form, setForm] = useState<LeadInput>(() => {
    if (!lead) return empty(defaultStage);
    const { id: _id, createdAt: _c, ...rest } = lead;
    return rest;
  });
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
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
          <h2>{lead ? "리드 수정" : "새 리드 등록"}</h2>
        </div>
        <div className="modal-body">
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
