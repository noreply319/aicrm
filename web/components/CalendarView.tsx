"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { CalendarEvent, Lead, Me, ScheduledMeeting } from "@/lib/types";

interface Props {
  me: Me | null;
  leads: Lead[];
  candidates: ScheduledMeeting[];
  query: string;
  /** 일정이 바뀌면 증가 → 다시 불러오기 */
  version: number;
  onNew: (date: string) => void;
  onOpenEvent: (event: CalendarEvent) => void;
  onConfirmCandidate: (s: ScheduledMeeting) => void;
  onDismissCandidate: (s: ScheduledMeeting) => void;
  onExpired: () => void;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (n: number) => String(n).padStart(2, "0");
/** 브라우저 로컬 날짜 'YYYY-MM-DD' */
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDaysLocal = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

/** 이 일정이 걸쳐 있는 날짜들 (로컬 날짜, 최대 31일) */
function eventDays(e: CalendarEvent): string[] {
  const first = e.allDay ? e.start : ymd(new Date(e.start));
  // 시간 일정이 자정에 끝나면 그날은 포함하지 않는다
  const endDate = e.allDay ? e.end : ymd(new Date(new Date(e.end).getTime() - 1));
  const days: string[] = [];
  for (let d = first; d <= endDate && days.length < 31; d = addDaysLocal(d, 1)) days.push(d);
  return days.length ? days : [first];
}

const timeLabel = (e: CalendarEvent) => (e.allDay ? "" : formatDateTime(e.start).slice(11));

export default function CalendarView({
  me, leads, candidates, query, version, onNew, onOpenEvent, onConfirmCandidate, onDismissCandidate, onExpired,
}: Props) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => ymd(new Date()));

  const connected = me?.calendar.state === "connected";
  const today = ymd(new Date());

  // 6주(42일) 격자: 월의 첫 주 일요일부터
  const gridStart = useMemo(() => {
    const d = new Date(month);
    d.setDate(1 - d.getDay());
    return ymd(d);
  }, [month]);
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => addDaysLocal(gridStart, i)), [gridStart]);

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      setEvents(await api<CalendarEvent[]>(`/api/calendar/events?start=${days[0]}&end=${days[41]}`));
      setError(null);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      if (msg.includes("만료") || msg.includes("다시 연동")) onExpired();
    } finally {
      setLoading(false);
    }
  }, [connected, days, onExpired]);

  useEffect(() => {
    load();
  }, [load, version]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? events.filter((e) => [e.title, e.location, e.crm?.company ?? ""].some((v) => v.toLowerCase().includes(q))) : events;
  }, [events, query]);

  const byDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const e of visible) for (const d of eventDays(e)) (m[d] ??= []).push(e);
    // 종일 일정 먼저, 그다음 시작 시각순
    for (const list of Object.values(m)) {
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
    }
    return m;
  }, [visible]);

  const moveMonth = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));
  const goToday = () => {
    const d = new Date();
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelected(ymd(d));
  };

  const leadName = (id: string | null) => (id ? leads.find((l) => l.id === id)?.company ?? "" : "");
  const selectedEvents = byDay[selected] ?? [];

  if (me && !connected) {
    return (
      <div className="calendar">
        <div className="empty-state">
          <div className="empty-icon">📅</div>
          <b>{me.calendar.state === "expired" ? "구글 캘린더 연동이 만료되었습니다" : "구글 캘린더가 연동되지 않았습니다"}</b>
          <p className="muted">
            {me.calendar.state === "expired"
              ? "테스트 상태의 구글 앱은 7일마다 다시 연동해야 합니다."
              : "연동하면 내 캘린더 일정을 보고, 미팅 노트의 다음 미팅을 바로 등록할 수 있습니다."}
          </p>
          <a className="btn btn-primary" href="/api/calendar/connect">Google 캘린더 연동</a>
        </div>
        {candidates.length > 0 && (
          <CandidateList candidates={candidates} leadName={leadName} onConfirm={onConfirmCandidate} onDismiss={onDismissCandidate} />
        )}
      </div>
    );
  }

  return (
    <div className="calendar">
      <div className="calendar-toolbar">
        <button type="button" className="btn icon-btn" onClick={() => moveMonth(-1)} aria-label="이전 달">‹</button>
        <button type="button" className="btn btn-sm" onClick={goToday}>오늘</button>
        <button type="button" className="btn icon-btn" onClick={() => moveMonth(1)} aria-label="다음 달">›</button>
        <h2>{month.getFullYear()}년 {month.getMonth() + 1}월</h2>
        {loading && <span className="muted">불러오는 중…</span>}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={load} title="새로고침">↻</button>
        <button type="button" className="btn btn-primary" onClick={() => onNew(selected)}>＋ 일정 추가</button>
      </div>

      {error && <div className="calendar-error" role="alert">⚠ {error}</div>}

      {candidates.length > 0 && (
        <CandidateList candidates={candidates} leadName={leadName} onConfirm={onConfirmCandidate} onDismiss={onDismissCandidate} />
      )}

      <div className="month-grid" role="grid">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={`month-weekday${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}>{w}</div>
        ))}
        {days.map((d) => {
          const list = byDay[d] ?? [];
          const inMonth = Number(d.slice(5, 7)) === month.getMonth() + 1;
          const dow = new Date(`${d}T00:00:00`).getDay();
          return (
            <div
              key={d}
              role="gridcell"
              className={`month-day${inMonth ? "" : " out"}${d === today ? " today" : ""}${d === selected ? " selected" : ""}`}
              onClick={() => setSelected(d)}
              onDoubleClick={() => onNew(d)}
            >
              <div className={`month-date${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}`}>{Number(d.slice(8))}</div>
              {list.slice(0, 3).map((e) => (
                <button
                  key={`${e.id}-${d}`}
                  type="button"
                  className={`event-chip${e.crm ? " crm" : ""}${e.allDay ? " all-day" : ""}`}
                  title={`${timeLabel(e)} ${e.title}`.trim()}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onOpenEvent(e);
                  }}
                >
                  {timeLabel(e) && <span className="event-time">{timeLabel(e)}</span>}
                  {e.title}
                </button>
              ))}
              {list.length > 3 && <div className="event-more">+{list.length - 3}개</div>}
            </div>
          );
        })}
      </div>

      <section className="day-list">
        <div className="day-list-head">
          <b>{selected.slice(5).replace("-", "월 ")}일 ({WEEKDAYS[new Date(`${selected}T00:00:00`).getDay()]})</b>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => onNew(selected)}>＋ 이 날 일정 추가</button>
        </div>
        {selectedEvents.length === 0 ? (
          <p className="muted">일정이 없습니다.</p>
        ) : (
          <ul>
            {selectedEvents.map((e) => (
              <li key={e.id}>
                <button type="button" className="day-event" onClick={() => onOpenEvent(e)}>
                  <span className="event-time">{e.allDay ? "종일" : `${timeLabel(e)}–${formatDateTime(e.end).slice(11)}`}</span>
                  <span className="day-event-title">{e.title}</span>
                  {e.crm?.company && <span className="crm-pill">{e.crm.company}</span>}
                  {e.location && <span className="muted">📍 {e.location}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CandidateList({
  candidates, leadName, onConfirm, onDismiss,
}: {
  candidates: ScheduledMeeting[];
  leadName: (id: string | null) => string;
  onConfirm: (s: ScheduledMeeting) => void;
  onDismiss: (s: ScheduledMeeting) => void;
}) {
  return (
    <section className="candidates">
      <div className="candidates-head">
        <b>🗓 확인이 필요한 다음 미팅 {candidates.length}건</b>
        <span className="muted">미팅 노트에서 찾은 일정입니다. 확정하면 캘린더에 등록됩니다.</span>
      </div>
      {candidates.map((c) => (
        <CandidateRow key={c.id} candidate={c} company={leadName(c.leadId)} onConfirm={onConfirm} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

/** 일정 후보 한 줄 (캘린더 화면·리드 상세·노트 저장 후 확인 창에서 공용) */
export function CandidateRow({
  candidate: c, company, onConfirm, onDismiss, onLater,
}: {
  candidate: ScheduledMeeting;
  company: string;
  onConfirm: (s: ScheduledMeeting) => void;
  onDismiss: (s: ScheduledMeeting) => void;
  onLater?: (s: ScheduledMeeting) => void;
}) {
  const when = c.allDay ? `${formatDateTime(c.startsAt).slice(0, 10)} · 시간 미정` : formatDateTime(c.startsAt);
  return (
    <div className="candidate">
      <div className="candidate-main">
        <div className="candidate-title">
          {c.title}
          {c.certainty === "tentative" && <span className="tentative-pill">확인 필요</span>}
        </div>
        <div className="muted">
          📅 {when}
          {c.location ? ` · 📍 ${c.location}` : ""}
          {company ? ` · 🔗 ${company}` : " · 리드 미지정"}
        </div>
        {c.evidence && <div className="candidate-evidence">“{c.evidence}”</div>}
      </div>
      <div className="candidate-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onConfirm(c)}>확인 후 등록</button>
        {onLater && <button type="button" className="btn btn-sm" onClick={() => onLater(c)}>나중에</button>}
        <button type="button" className="btn btn-sm" onClick={() => onDismiss(c)}>무시</button>
      </div>
    </div>
  );
}
