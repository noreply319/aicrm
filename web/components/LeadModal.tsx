"use client";

import { useEffect, useRef, useState } from "react";
import { PRIORITY_LABEL, STAGES } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { Lead, LeadInput, MeetingNoteSummary, Me, Priority, ScheduledMeeting, StageId } from "@/lib/types";
import { CandidateRow } from "./CalendarView";
import LeadEmails from "./LeadEmails";
import NoteListItem from "./NoteListItem";
import { Button, EmptyState, Field, Input, Modal, ModalFooter, ModalHeader, Select, Tabs, Textarea } from "./ui";

export type LeadModalTab = "info" | "notes" | "schedules" | "emails";

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
  /** 이 리드의 다음 미팅 (후보 + 등록된 일정) */
  schedules: ScheduledMeeting[];
  meId: string | null;
  onNewSchedule: () => void;
  /** 후보면 확인 후 등록, 등록된 일정이면 보기/수정 */
  onOpenSchedule: (s: ScheduledMeeting) => void;
  onDismissSchedule: (s: ScheduledMeeting) => void;
  /** 일정 탭을 열 때 구글과 동기화 */
  onSchedulesTab: () => void;
  /** 이메일 탭: Gmail 연동 상태, 내 이메일(Gmail 웹 계정 선택용), 연동 만료 시 상태 갱신 */
  gmailState: Me["gmail"]["state"];
  meEmail: string;
  onGmailExpired: () => void;
  onClose: () => void;
}

const empty = (stage: StageId): LeadInput => ({
  company: "", contact: "", title: "", email: "", phone: "",
  value: 0, closeDate: "", stage, priority: "mid", notes: "",
});

export default function LeadModal({
  lead, defaultStage, notes, initialTab, onSave, onDelete, onNewNote, onOpenNote,
  schedules, meId, onNewSchedule, onOpenSchedule, onDismissSchedule, onSchedulesTab,
  gmailState, meEmail, onGmailExpired, onClose,
}: Props) {
  const [tab, setTab] = useState<LeadModalTab>(lead ? initialTab : "info");
  const [form, setForm] = useState<LeadInput>(() => {
    if (!lead) return empty(defaultStage);
    const { id: _id, createdAt: _c, ...rest } = lead;
    return rest;
  });
  const firstRef = useRef<HTMLInputElement>(null);

  // 일정 탭: 열 때마다 구글에서 바뀐 내용 반영 (콜백이 렌더마다 바뀌어도 탭 전환 때만 실행)
  const syncRef = useRef(onSchedulesTab);
  syncRef.current = onSchedulesTab;
  useEffect(() => {
    if (tab === "schedules") syncRef.current();
  }, [tab]);

  // 처음 열 때 정보 탭이면 회사명 입력에 포커스
  const focusOnOpen = useRef(tab === "info");
  useEffect(() => {
    if (focusOnOpen.current) firstRef.current?.focus();
  }, []);

  const set = <K extends keyof LeadInput>(key: K, value: LeadInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const upcomingCount = schedules.filter((x) => x.status === "scheduled" && x.endsAt >= nowIso()).length;

  return (
    <Modal
      label={lead ? lead.company : "새 리드 등록"}
      onClose={onClose}
      onSubmit={() => onSave({ ...form, company: form.company.trim(), value: Number(form.value) || 0 })}
    >
      <ModalHeader title={lead ? lead.company : "새 리드 등록"} onClose={onClose} />
      {lead && (
        <Tabs
          className="modal-tabs"
          value={tab}
          onChange={setTab}
          items={[
            { id: "info", label: "리드 정보" },
            { id: "notes", label: `미팅 노트 (${notes.length})` },
            { id: "schedules", label: `다음 미팅 (${upcomingCount})` },
            { id: "emails", label: "이메일" },
          ]}
        />
      )}
      {tab === "notes" && (
        <div className="lead-notes">
          <div className="lead-notes-head">
            <span className="muted">미팅 일시 최신순</span>
            <span className="spacer" />
            <Button variant="primary" size="sm" icon="plus" onClick={onNewNote}>노트 작성</Button>
          </div>
          {notes.length === 0 ? (
            <EmptyState small icon="🗂" title="이 리드의 미팅 노트가 없습니다" />
          ) : (
            <div className="note-list">
              {notes.map((n) => (
                <NoteListItem key={n.id} note={n} onClick={() => onOpenNote(n.id)} />
              ))}
            </div>
          )}
        </div>
      )}
      {tab === "schedules" && (
        <LeadSchedules
          schedules={schedules}
          meId={meId}
          onNew={onNewSchedule}
          onOpen={onOpenSchedule}
          onDismiss={onDismissSchedule}
        />
      )}
      {tab === "emails" && lead && (
        <LeadEmails
          leadId={lead.id}
          leadEmail={lead.email}
          gmailState={gmailState}
          meEmail={meEmail}
          onExpired={onGmailExpired}
        />
      )}
      <div className="modal-body" hidden={tab !== "info"}>
        <Field label="회사명 *" full>
          <Input ref={firstRef} required placeholder="예: 에이아이랩스"
            value={form.company} onChange={(e) => set("company", e.target.value)} />
        </Field>
        <Field label="담당자">
          <Input placeholder="홍길동" value={form.contact} onChange={(e) => set("contact", e.target.value)} />
        </Field>
        <Field label="직책">
          <Input placeholder="구매팀장" value={form.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="이메일">
          <Input type="email" placeholder="name@company.com" value={form.email}
            onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="전화번호">
          <Input placeholder="010-0000-0000" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="예상 금액 (원)">
          <Input type="number" min={0} step={10000} placeholder="10000000"
            value={form.value || ""} onChange={(e) => set("value", Number(e.target.value))} />
        </Field>
        <Field label="예상 마감일">
          <Input type="date" value={form.closeDate} onChange={(e) => set("closeDate", e.target.value)} />
        </Field>
        <Field label="단계">
          <Select value={form.stage} onChange={(e) => set("stage", e.target.value as StageId)}>
            {STAGES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="우선순위">
          <Select value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
              <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
            ))}
          </Select>
        </Field>
        <Field label="메모" full>
          <Textarea placeholder="리드 관련 메모" value={form.notes}
            onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
      <ModalFooter start={onDelete && <Button variant="danger" onClick={onDelete}>삭제</Button>}>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" type="submit">저장</Button>
      </ModalFooter>
    </Modal>
  );
}

const nowIso = () => new Date().toISOString();

/** 리드 상세 → 다음 미팅 탭: 확인 필요 후보, 예정 미팅, 지난 미팅 */
function LeadSchedules({
  schedules, meId, onNew, onOpen, onDismiss,
}: {
  schedules: ScheduledMeeting[];
  meId: string | null;
  onNew: () => void;
  onOpen: (s: ScheduledMeeting) => void;
  onDismiss: (s: ScheduledMeeting) => void;
}) {
  const now = nowIso();
  const candidates = schedules.filter((s) => s.status === "candidate");
  const upcoming = schedules.filter((s) => s.status === "scheduled" && s.endsAt >= now);
  const past = schedules.filter((s) => s.status === "scheduled" && s.endsAt < now).reverse();
  const when = (s: ScheduledMeeting) =>
    s.allDay ? `${formatDateTime(s.startsAt).slice(0, 10)} 종일` : formatDateTime(s.startsAt);

  const row = (s: ScheduledMeeting) => (
    <button key={s.id} type="button" className="schedule-item" onClick={() => onOpen(s)}>
      <span className="schedule-when">{when(s)}</span>
      <span className="schedule-title">{s.title}</span>
      {s.location && <span className="muted">📍 {s.location}</span>}
      <span className="spacer" />
      <span className="muted">{s.userId === meId ? "내 캘린더" : `${s.ownerName || "팀원"}님`}</span>
    </button>
  );

  return (
    <div className="lead-notes">
      <div className="lead-notes-head">
        <span className="muted">구글 캘린더에 등록된 미팅과 미팅 노트에서 찾은 후보</span>
        <span className="spacer" />
        <Button variant="primary" size="sm" icon="plus" onClick={onNew}>일정 추가</Button>
      </div>
      {candidates.length > 0 && (
        <div className="schedule-group">
          <h4>확인 필요</h4>
          {candidates.map((c) => (
            <CandidateRow key={c.id} candidate={c} company="" onConfirm={onOpen} onDismiss={onDismiss} />
          ))}
        </div>
      )}
      {upcoming.length === 0 && candidates.length === 0 ? (
        <EmptyState small icon="🗓" title="예정된 미팅이 없습니다" />
      ) : (
        upcoming.length > 0 && (
          <div className="schedule-group">
            <h4>예정</h4>
            {upcoming.map(row)}
          </div>
        )
      )}
      {past.length > 0 && (
        <div className="schedule-group">
          <h4>지난 미팅</h4>
          {past.slice(0, 5).map(row)}
        </div>
      )}
    </div>
  );
}
