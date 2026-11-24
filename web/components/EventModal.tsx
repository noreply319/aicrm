"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatDateTime, fromLocalInput, toLocalInput } from "@/lib/format";
import type { CalendarEvent, CalendarEventInput, Lead, Me } from "@/lib/types";
import { Alert, Button, Checkbox, Field, Input, Modal, ModalFooter, ModalHeader, Select, Textarea } from "./ui";

export type EventModalMode = "new" | "edit" | "view";

interface Props {
  mode: EventModalMode;
  /** 폼 기본값 (start/end: 종일이면 'YYYY-MM-DD', 아니면 ISO) */
  initial: CalendarEventInput;
  /** 보기/수정할 구글 일정 */
  event?: CalendarEvent | null;
  /** CRM에서 등록했고 내 캘린더 일정이면 수정·삭제 가능 */
  editable?: boolean;
  /** 다른 팀원 일정이면 등록자 이름 */
  ownerName?: string;
  /** 미팅 노트에서 찾은 후보 근거 문장 */
  evidence?: string;
  heading?: string;
  leads: Lead[];
  calendarState: Me["calendar"]["state"];
  onSubmit: (input: CalendarEventInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}

const DEFAULT_MINUTES = 60;

/** CalendarEventInput 값 → 입력란 값 (종일: YYYY-MM-DD, 시간: datetime-local) */
const toInput = (v: string, allDay: boolean) => (allDay ? v.slice(0, 10) : v.length === 10 ? `${v}T10:00` : toLocalInput(v));
const addMinutesLocal = (local: string, minutes: number) => toLocalInput(new Date(new Date(local).getTime() + minutes * 60_000).toISOString());

const describeWhen = (e: Pick<CalendarEvent, "start" | "end" | "allDay">) => {
  if (e.allDay) return e.start === e.end ? `${e.start} (종일)` : `${e.start} ~ ${e.end} (종일)`;
  const s = formatDateTime(e.start);
  const end = formatDateTime(e.end);
  return `${s} ~ ${end.slice(0, 10) === s.slice(0, 10) ? end.slice(11) : end}`;
};

/** 일정 등록·수정·보기 모달 */
export default function EventModal({
  mode: initialMode, initial, event, editable, ownerName, evidence, heading, leads, calendarState, onSubmit, onDelete, onClose,
}: Props) {
  const [mode, setMode] = useState(initialMode);
  const [title, setTitle] = useState(initial.title);
  const [allDay, setAllDay] = useState(initial.allDay);
  const [start, setStart] = useState(toInput(initial.start, initial.allDay));
  const [end, setEnd] = useState(toInput(initial.end, initial.allDay));
  const [location, setLocation] = useState(initial.location);
  const [memo, setMemo] = useState(initial.description);
  const [leadId, setLeadId] = useState(initial.leadId ?? "");
  const [invite, setInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedLeads = useMemo(() => [...leads].sort((a, b) => a.company.localeCompare(b.company, "ko")), [leads]);
  const lead = leads.find((l) => l.id === leadId);
  const connected = calendarState === "connected";

  const toggleAllDay = (v: boolean) => {
    setAllDay(v);
    if (v) {
      setStart(start.slice(0, 10));
      setEnd(end.slice(0, 10) < start.slice(0, 10) ? start.slice(0, 10) : end.slice(0, 10));
    } else {
      setStart(`${start.slice(0, 10)}T10:00`);
      setEnd(`${start.slice(0, 10)}T11:00`);
    }
  };

  // 시작을 바꾸면 길이를 유지하며 종료도 옮긴다
  const changeStart = (v: string) => {
    if (!v) return setStart(v);
    if (allDay) {
      setEnd((prev) => (prev < v ? v : prev));
    } else {
      const prevLen = new Date(end).getTime() - new Date(start).getTime();
      const len = Number.isFinite(prevLen) && prevLen > 0 ? prevLen / 60_000 : DEFAULT_MINUTES;
      setEnd(addMinutesLocal(v, len));
    }
    setStart(v);
  };

  const submit = async () => {
    if (!title.trim()) return setError("일정 제목을 입력하세요");
    const s = allDay ? start : fromLocalInput(start);
    const e = allDay ? end : fromLocalInput(end);
    if (!s || !e) return setError(allDay ? "날짜를 입력하세요" : "시작·종료 시각을 입력하세요");
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        ...initial,
        title: title.trim(),
        allDay,
        start: s,
        end: e,
        location: location.trim(),
        description: memo.trim(),
        leadId: leadId || null,
        invite: mode === "new" && invite,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!onDelete || !confirm(`이 일정을 취소할까요?\n구글 캘린더에서도 삭제됩니다.`)) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const viewData = event ?? null;

  const modalTitle = heading ?? (mode === "new" ? "일정 추가" : mode === "edit" ? "일정 수정" : viewData?.title ?? "일정");
  const close = () => !busy && onClose();

  return (
    <Modal label="일정" onClose={close} className="event-modal">
      <ModalHeader
        title={modalTitle}
        onClose={close}
        actions={mode === "view" && editable && <Button size="sm" icon="edit" onClick={() => setMode("edit")}>수정</Button>}
      />

      {mode === "view" && viewData ? (
        <div className="event-view">
          <div className="event-view-row">🕒 {describeWhen(viewData)}</div>
          {viewData.location && <div className="event-view-row">📍 {viewData.location}</div>}
          {viewData.crm?.company && <div className="event-view-row">🔗 {viewData.crm.company}</div>}
          {ownerName && <div className="event-view-row muted">👤 {ownerName}님 캘린더 일정</div>}
          {viewData.description && <div className="event-view-desc">{viewData.description}</div>}
          {!viewData.crm && <p className="muted">CRM에서 등록하지 않은 일정은 구글 캘린더에서 수정하세요.</p>}
        </div>
      ) : (
        <div className="event-form">
          {evidence && (
            <div className="evidence">
              <span className="muted">노트 근거</span> “{evidence}”
            </div>
          )}
          {!connected && (
            <Alert tone="warning">
              {calendarState === "expired" ? "캘린더 연동이 만료되었습니다." : "구글 캘린더가 연동되지 않았습니다."}{" "}
              <Link href="/settings" onClick={onClose}>설정 → Google 연동</Link>에서 연결하면 등록할 수 있습니다.
            </Alert>
          )}
          <Field label="제목 *">
            <Input value={title} maxLength={200} placeholder="예: 한빛소프트 데모 미팅" onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Checkbox label="종일" checked={allDay} onChange={toggleAllDay} />
          <div className="form-grid">
            <Field label={`${allDay ? "시작일" : "시작"} *`}>
              <Input type={allDay ? "date" : "datetime-local"} value={start} onChange={(e) => changeStart(e.target.value)} />
            </Field>
            <Field label={`${allDay ? "종료일" : "종료"} *`}>
              <Input type={allDay ? "date" : "datetime-local"} value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <div className="form-grid">
            <Field label="장소 / 방식">
              <Input value={location} maxLength={300} placeholder="예: 고객사 방문, 화상" onChange={(e) => setLocation(e.target.value)} />
            </Field>
            <Field label="연결 리드">
              <Select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                <option value="">연결 안 함</option>
                {sortedLeads.map((l) => (
                  <option key={l.id} value={l.id}>{l.company}{l.contact ? ` — ${l.contact}` : ""}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="메모">
            <Textarea rows={3} value={memo} maxLength={4000} placeholder="캘린더 일정 설명에 들어갑니다" onChange={(e) => setMemo(e.target.value)} />
          </Field>
          {mode === "new" && lead?.email && (
            <Checkbox
              checked={invite}
              onChange={setInvite}
              label={`담당자(${lead.contact || lead.company})에게 구글 캘린더 초대 메일 보내기`}
            />
          )}
        </div>
      )}

      {error && <Alert tone="danger" className="modal-alert">{error}</Alert>}

      <ModalFooter
        start={
          <>
            {viewData?.htmlLink && (
              <Button href={viewData.htmlLink} target="_blank" rel="noreferrer">구글 캘린더에서 열기 ↗</Button>
            )}
            {editable && onDelete && mode !== "new" && (
              <Button variant="danger" onClick={remove} disabled={busy}>일정 취소</Button>
            )}
          </>
        }
      >
        <Button onClick={onClose} disabled={busy}>{mode === "view" ? "닫기" : "취소"}</Button>
        {mode !== "view" && (
          <Button variant="primary" onClick={submit} disabled={busy || !connected}>
            {busy ? "저장 중…" : mode === "new" ? "캘린더에 등록" : "변경 저장"}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
