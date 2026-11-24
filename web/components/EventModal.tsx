"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatDateTime, fromLocalInput, toLocalInput } from "@/lib/format";
import type { CalendarEvent, CalendarEventInput, Lead, Me } from "@/lib/types";

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

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

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal event-modal" role="dialog" aria-modal="true" aria-label="일정">
        <div className="modal-head">
          <h2>{heading ?? (mode === "new" ? "일정 추가" : mode === "edit" ? "일정 수정" : viewData?.title ?? "일정")}</h2>
          <span className="spacer" />
          {mode === "view" && editable && (
            <button type="button" className="btn btn-sm" onClick={() => setMode("edit")}>✎ 수정</button>
          )}
        </div>

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
              <div className="modal-warn">
                {calendarState === "expired" ? "캘린더 연동이 만료되었습니다." : "구글 캘린더가 연동되지 않았습니다."}{" "}
                <Link href="/settings" onClick={onClose}>설정 → Google 연동</Link>에서 연결하면 등록할 수 있습니다.
              </div>
            )}
            <div className="field">
              <label>제목 *</label>
              <input value={title} maxLength={200} placeholder="예: 한빛소프트 데모 미팅" onChange={(e) => setTitle(e.target.value)} autoFocus />
            </div>
            <label className="check">
              <input type="checkbox" checked={allDay} onChange={(e) => toggleAllDay(e.target.checked)} /> 종일
            </label>
            <div className="event-form-grid">
              <div className="field">
                <label>{allDay ? "시작일" : "시작"} *</label>
                <input type={allDay ? "date" : "datetime-local"} value={start} onChange={(e) => changeStart(e.target.value)} />
              </div>
              <div className="field">
                <label>{allDay ? "종료일" : "종료"} *</label>
                <input type={allDay ? "date" : "datetime-local"} value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <div className="event-form-grid">
              <div className="field">
                <label>장소 / 방식</label>
                <input value={location} maxLength={300} placeholder="예: 고객사 방문, 화상" onChange={(e) => setLocation(e.target.value)} />
              </div>
              <div className="field">
                <label>연결 리드</label>
                <select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                  <option value="">연결 안 함</option>
                  {sortedLeads.map((l) => (
                    <option key={l.id} value={l.id}>{l.company}{l.contact ? ` — ${l.contact}` : ""}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label>메모</label>
              <textarea rows={3} value={memo} maxLength={4000} placeholder="캘린더 일정 설명에 들어갑니다" onChange={(e) => setMemo(e.target.value)} />
            </div>
            {mode === "new" && lead?.email && (
              <label className="check">
                <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
                담당자({lead.contact || lead.company})에게 구글 캘린더 초대 메일 보내기
              </label>
            )}
          </div>
        )}

        {error && <div className="modal-error" role="alert">⚠ {error}</div>}

        <div className="modal-foot">
          {viewData?.htmlLink && (
            <a className="btn" href={viewData.htmlLink} target="_blank" rel="noreferrer">구글 캘린더에서 열기 ↗</a>
          )}
          {editable && onDelete && mode !== "new" && (
            <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>일정 취소</button>
          )}
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{mode === "view" ? "닫기" : "취소"}</button>
          {mode !== "view" && (
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !connected}>
              {busy ? "저장 중…" : mode === "new" ? "캘린더에 등록" : "변경 저장"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
