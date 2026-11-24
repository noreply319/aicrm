"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { CRM_DESCRIPTION_MARK, STAGES, stripCrmPrefix } from "@/lib/constants";
import { formatDateTime, fromLocalInput, memoFromDescription } from "@/lib/format";
import { useLeads } from "@/lib/useLeads";
import { useMe } from "@/lib/useMe";
import { useMeetings } from "@/lib/useMeetings";
import { useSchedules } from "@/lib/useSchedules";
import type {
  CalendarEvent, CalendarEventInput, LeadInput, MeetingNoteInput, ScheduledMeeting, StageId,
} from "@/lib/types";
import Header, { type View } from "./Header";
import StatsBar from "./StatsBar";
import Board from "./Board";
import LeadModal, { type LeadModalTab } from "./LeadModal";
import MeetingList from "./MeetingList";
import MeetingNoteModal from "./MeetingNoteModal";
import Toast from "./Toast";
import AssistantPanel from "./AssistantPanel";
import CalendarView from "./CalendarView";
import EventModal, { type EventModalMode } from "./EventModal";
import ScheduleSuggestModal from "./ScheduleSuggestModal";
import SettingsView from "./SettingsView";

type ModalState = { open: false } | { open: true; leadId: string | null; stage: StageId; tab: LeadModalTab };

type NoteModalState =
  | { open: false }
  | {
      open: true;
      noteId: string | null;
      leadId: string | null;
      lockLead: boolean;
      /** 리드 상세에서 열었으면 닫을 때 그 리드의 미팅 노트 탭으로 돌아간다 */
      returnToLead: string | null;
    };

type EventModalState =
  | { open: false }
  | {
      open: true;
      mode: EventModalMode;
      initial: CalendarEventInput;
      /** 수정할 구글 일정 id (새 일정이면 null) */
      eventId: string | null;
      event: CalendarEvent | null;
      editable: boolean;
      ownerName?: string;
      evidence?: string;
      heading?: string;
      /** 리드 상세에서 열었으면 닫을 때 그 리드의 다음 미팅 탭으로 돌아간다 */
      returnToLead: string | null;
    };

const viewOf = (pathname: string): View =>
  pathname.startsWith("/meetings") ? "meetings"
    : pathname.startsWith("/calendar") ? "calendar"
      : pathname.startsWith("/settings") ? "settings"
        : "pipeline";

const pad = (n: number) => String(n).padStart(2, "0");
const localYmd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const emptyEventInput = (): CalendarEventInput => ({
  title: "", allDay: false, start: "", end: "", location: "", description: "",
  leadId: null, noteId: null, scheduleId: null, invite: false,
});

/** 저장된 일정(후보 포함) → 일정 폼 값 */
const scheduleInput = (s: ScheduledMeeting): CalendarEventInput => ({
  ...emptyEventInput(),
  title: s.title,
  allDay: s.allDay,
  // 종일 일정은 한국 시간 자정 기준으로 저장되어 있다 → 날짜만
  start: s.allDay ? formatDateTime(s.startsAt).slice(0, 10) : s.startsAt,
  end: s.allDay ? formatDateTime(new Date(new Date(s.endsAt).getTime() - 1).toISOString()).slice(0, 10) : s.endsAt,
  location: s.location,
  description: s.memo,
  leadId: s.leadId,
  noteId: s.noteId,
  scheduleId: s.status === "candidate" ? s.id : null,
});

export default function CrmApp() {
  const pathname = usePathname();
  const view = viewOf(pathname);

  const { leads, ready, error, clearError, reload, addLead, updateLead, deleteLead, moveLead } = useLeads();
  const meetings = useMeetings();
  const auth = useMe();
  const sched = useSchedules();
  const [eventModal, setEventModal] = useState<EventModalState>({ open: false });
  const [suggestions, setSuggestions] = useState<ScheduledMeeting[]>([]);
  /** 자동 등록하지 못한 이유 (확인 창 안내 문구) */
  const [suggestReason, setSuggestReason] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [modal, setModal] = useState<ModalState>({ open: false });
  const [noteModal, setNoteModal] = useState<NoteModalState>({ open: false });
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // 좁은 화면에서는 Assistant가 화면을 덮으므로 처음엔 닫아 둔다
  useEffect(() => {
    if (window.matchMedia("(max-width: 960px)").matches) setAssistantOpen(false);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast({ msg, key: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  const openNew = useCallback((stage: StageId = "new") => {
    setModal({ open: true, leadId: null, stage, tab: "info" });
  }, []);

  const openLead = useCallback(
    (id: string, tab: LeadModalTab = "info") => {
      const l = leads.find((x) => x.id === id);
      if (l) setModal({ open: true, leadId: id, stage: l.stage, tab });
    },
    [leads]
  );

  const openNewNote = useCallback((leadId: string | null = null, fromLead = false) => {
    setModal({ open: false });
    setNoteModal({ open: true, noteId: null, leadId, lockLead: fromLead, returnToLead: fromLead ? leadId : null });
  }, []);

  const openNote = useCallback((noteId: string, fromLeadId: string | null = null) => {
    setModal({ open: false });
    setNoteModal({ open: true, noteId, leadId: null, lockLead: false, returnToLead: fromLeadId });
  }, []);

  /** 새 일정: date(YYYY-MM-DD)의 오전 10시~11시, 리드가 있으면 "{회사명} 미팅" */
  const openNewEvent = useCallback(
    (date: string = localYmd(), leadId: string | null = null) => {
      const company = leadId ? leads.find((l) => l.id === leadId)?.company : undefined;
      setModal({ open: false });
      setEventModal({
        open: true,
        mode: "new",
        initial: {
          ...emptyEventInput(),
          title: company ? `${company} 미팅` : "",
          start: fromLocalInput(`${date}T10:00`),
          end: fromLocalInput(`${date}T11:00`),
          leadId,
        },
        eventId: null,
        event: null,
        editable: true,
        returnToLead: leadId,
      });
    },
    [leads]
  );

  /** 캘린더 화면에서 일정 클릭: CRM에서 등록한 일정만 수정 가능 */
  const openEvent = useCallback((e: CalendarEvent) => {
    setEventModal({
      open: true,
      mode: "view",
      initial: {
        ...emptyEventInput(),
        // 구글 제목의 [AI CRM] 표시는 폼에서 빼고, 저장할 때 서버가 다시 붙인다
        title: e.crm ? stripCrmPrefix(e.title) : e.title,
        allDay: e.allDay,
        start: e.start,
        end: e.end,
        location: e.location,
        description: e.crm ? memoFromDescription(e.description, CRM_DESCRIPTION_MARK) : e.description,
        leadId: e.crm?.leadId ?? null,
        noteId: e.crm?.noteId ?? null,
      },
      eventId: e.id,
      event: e,
      editable: Boolean(e.crm),
      returnToLead: null,
    });
  }, []);

  /** 후보면 확인 후 등록, 등록된 일정이면 보기 (내 일정만 수정 가능) */
  const openSchedule = useCallback(
    (s: ScheduledMeeting, fromLeadId: string | null = null) => {
      setModal({ open: false });
      const input = scheduleInput(s);
      if (s.status === "candidate") {
        setEventModal({
          open: true, mode: "new", initial: input, eventId: null, event: null, editable: true,
          evidence: s.evidence, heading: "다음 미팅 등록", returnToLead: fromLeadId,
        });
        return;
      }
      const company = s.leadId ? leads.find((l) => l.id === s.leadId)?.company ?? null : null;
      const mine = s.userId === auth.me?.id;
      setEventModal({
        open: true,
        mode: "view",
        initial: input,
        eventId: s.googleEventId,
        event: {
          id: s.googleEventId ?? s.id,
          title: s.title,
          start: input.start,
          end: input.end,
          allDay: s.allDay,
          location: s.location,
          description: s.memo,
          htmlLink: mine ? s.htmlLink : "",
          crm: { scheduleId: s.id, leadId: s.leadId, company, noteId: s.noteId },
        },
        editable: mine && Boolean(s.googleEventId),
        ownerName: mine ? undefined : s.ownerName || "팀원",
        returnToLead: fromLeadId,
      });
    },
    [leads, auth.me?.id]
  );

  const onAdd = useCallback(() => {
    if (view === "meetings") openNewNote();
    else if (view === "calendar") openNewEvent();
    else if (view === "pipeline") openNew();
  }, [view, openNew, openNewNote, openNewEvent]);

  // 'N' 키: 파이프라인에서는 새 리드, 미팅 노트에서는 노트 작성
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      if (e.key === "n" && !modal.open && !noteModal.open && !eventModal.open && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
        e.preventDefault();
        onAdd();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal.open, noteModal.open, eventModal.open, onAdd]);

  const visibleLeads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) =>
      [l.company, l.contact, l.title, l.notes, l.email].some((v) =>
        (v || "").toLowerCase().includes(q)
      )
    );
  }, [leads, query]);

  const handleMove = async (id: string, stage: StageId, beforeId: string | null) => {
    const lead = leads.find((l) => l.id === id);
    if (!lead) return;
    try {
      await moveLead(id, stage, beforeId);
      if (lead.stage !== stage) {
        const name = STAGES.find((s) => s.id === stage)?.name;
        showToast(`${lead.company} → ${name}${stage === "won" ? " 🎉" : ""}`);
      }
    } catch {}
  };

  const handleSave = async (input: LeadInput) => {
    if (!modal.open) return;
    try {
      if (modal.leadId) {
        await updateLead(modal.leadId, input);
        showToast("리드가 수정되었습니다");
      } else {
        await addLead(input);
        showToast("새 리드가 등록되었습니다");
      }
      setModal({ open: false });
    } catch {}
  };

  const handleDelete = async () => {
    if (!modal.open || !modal.leadId) return;
    const id = modal.leadId;
    const n = meetings.countByLead[id] ?? 0;
    if (!confirm(`이 리드를 삭제할까요?${n ? `\n미팅 노트 ${n}개도 함께 삭제됩니다.` : ""}`)) return;
    setModal({ open: false });
    try {
      await deleteLead(id);
      meetings.forgetLead(id);
      sched.forgetLead(id);
      showToast("삭제되었습니다");
    } catch {}
  };

  /** 미팅 완료 후 자동 요약. 작성 화면을 닫아도 서버에서 끝나고 목록이 갱신된다. */
  const handleAutoSummarize = async (id: string) => {
    const saved = await meetings.summarizeNote(id);
    showToast("AI 요약이 완료되었습니다");
    return saved;
  };

  const handleSaveNote = async (input: MeetingNoteInput, id: string | null, opts?: { auto?: boolean }) => {
    const saved = id ? await meetings.updateNote(id, input) : await meetings.addNote(input);
    showToast(
      opts?.auto
        ? "녹음이 끝나 미팅 노트가 자동 저장되었습니다"
        : id ? "미팅 노트가 수정되었습니다" : "미팅 노트가 저장되었습니다"
    );
    // 직접 저장하면 다음 미팅을 찾아 날짜·시간이 정해진 일정은 확인 없이 캘린더에 자동 등록한다
    // (저장은 기다리지 않음, 녹음 자동 저장은 제외). 시간 미정 등 등록하지 못한 일정만 확인 창으로 묻는다.
    if (!opts?.auto) {
      sched
        .extract(saved.id)
        .then((r) => {
          if (r.registered.length) {
            const first = r.registered[0];
            showToast(
              r.registered.length === 1
                ? `다음 미팅을 캘린더에 자동 등록했습니다: ${formatDateTime(first.startsAt)} ${first.title}`
                : `다음 미팅 ${r.registered.length}건을 캘린더에 자동 등록했습니다`
            );
          }
          if (r.candidates.length) {
            setSuggestReason(r.calendarError);
            setSuggestions((prev) => [...prev, ...r.candidates.filter((f) => !prev.some((p) => p.id === f.id))]);
          }
        })
        .catch((e: Error) => console.warn("[schedules] extract", e.message));
    }
    return saved;
  };

  const handleDeleteNote = async (id: string) => {
    await meetings.deleteNote(id);
    showToast("미팅 노트가 삭제되었습니다");
  };

  const closeNoteModal = () => {
    const back = noteModal.open ? noteModal.returnToLead : null;
    setNoteModal({ open: false });
    if (back) openLead(back, "notes");
  };

  const editingLead = modal.open && modal.leadId ? leads.find((l) => l.id === modal.leadId) ?? null : null;
  const leadNotes = useMemo(
    () => (editingLead ? meetings.notes.filter((n) => n.leadId === editingLead.id) : []),
    [editingLead, meetings.notes]
  );

  const submitEvent = async (input: CalendarEventInput) => {
    if (!eventModal.open) return;
    const back = eventModal.returnToLead;
    if (eventModal.eventId) {
      await sched.updateEvent(eventModal.eventId, input);
      showToast("일정을 변경했습니다");
    } else {
      await sched.createEvent(input);
      setSuggestions((prev) => prev.filter((s) => s.id !== input.scheduleId));
      showToast("구글 캘린더에 등록했습니다");
    }
    setEventModal({ open: false });
    if (back) openLead(back, "schedules");
  };

  const removeEvent = async () => {
    if (!eventModal.open || !eventModal.eventId) return;
    const back = eventModal.returnToLead;
    await sched.deleteEvent(eventModal.eventId);
    showToast("일정을 취소했습니다");
    setEventModal({ open: false });
    if (back) openLead(back, "schedules");
  };

  const closeEventModal = () => {
    const back = eventModal.open ? eventModal.returnToLead : null;
    setEventModal({ open: false });
    if (back) openLead(back, "schedules");
  };

  const dismissSchedule = async (s: ScheduledMeeting) => {
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    try {
      await sched.dismiss(s.id);
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const companyOf = (leadId: string | null) => (leadId ? leads.find((l) => l.id === leadId)?.company ?? "" : "");
  const nextMeetings = useMemo(
    () => Object.fromEntries(Object.entries(sched.nextByLead).map(([k, v]) => [k, v.startsAt])),
    [sched.nextByLead]
  );
  const leadSchedules = useMemo(
    () => (editingLead ? sched.schedules.filter((s) => s.leadId === editingLead.id) : []),
    [editingLead, sched.schedules]
  );

  const bannerError = error ?? meetings.error;

  return (
    <>
      <Header
        view={view}
        query={query}
        onQuery={setQuery}
        onAdd={onAdd}
        assistantOpen={assistantOpen}
        onToggleAssistant={() => setAssistantOpen((v) => !v)}
        me={auth.me}
        onLogout={auth.logout}
      />
      {auth.me?.calendar.state === "expired" && view !== "settings" && (
        <div className="error-banner warn-banner" role="status">
          <span>⚠ 구글 캘린더 연동이 만료되었습니다. 캘린더 기능을 쓰려면 다시 연동하세요.</span>
          <a className="btn" href="/api/calendar/connect">다시 연동</a>
        </div>
      )}
      {/* 토큰은 캘린더·Gmail 공용이라 캘린더 배너가 있으면 그것만 보여준다 */}
      {auth.me?.gmail.state === "expired" && auth.me.calendar.state !== "expired" && view !== "settings" && (
        <div className="error-banner warn-banner" role="status">
          <span>⚠ Gmail 연동이 만료되었습니다. 리드 이메일을 보려면 다시 연동하세요.</span>
          <a className="btn" href="/api/gmail/connect">다시 연동</a>
        </div>
      )}
      {view === "pipeline" && <StatsBar leads={leads} />}
      {bannerError && (
        <div className="error-banner" role="alert">
          <span>⚠ {bannerError}</span>
          <button
            className="btn"
            onClick={() => {
              clearError();
              meetings.clearError();
              reload();
              meetings.reload();
            }}
          >
            다시 불러오기
          </button>
        </div>
      )}
      <div className="workspace">
        <div className="workspace-main">
          {view === "pipeline" ? (
            <>
              {!ready && <div className="loading">불러오는 중…</div>}
              {ready && (
                <Board
                  leads={visibleLeads}
                  noteCounts={meetings.countByLead}
                  nextMeetings={nextMeetings}
                  onMove={handleMove}
                  onOpen={(id) => openLead(id)}
                  onAddInStage={openNew}
                />
              )}
            </>
          ) : view === "calendar" ? (
            <CalendarView
              me={auth.me}
              leads={leads}
              candidates={sched.candidates}
              query={query}
              version={sched.version}
              onNew={(date) => openNewEvent(date)}
              onOpenEvent={openEvent}
              onConfirmCandidate={(s) => openSchedule(s)}
              onDismissCandidate={dismissSchedule}
              onExpired={auth.reload}
            />
          ) : view === "settings" ? (
            <SettingsView
              me={auth.me}
              onSetCalendar={auth.setCalendarId}
              onDisconnect={auth.disconnectCalendar}
              onDisconnectGmail={auth.disconnectGmail}
              onLogout={auth.logout}
              onNotice={showToast}
            />
          ) : (
            <MeetingList
              notes={meetings.notes}
              leads={leads}
              query={query}
              ready={meetings.ready && ready}
              onOpen={(id) => openNote(id)}
              onNew={() => openNewNote()}
            />
          )}
        </div>
        {/* 닫아도 대화가 유지되도록 언마운트하지 않고 숨긴다 */}
        <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
      </div>
      {modal.open && (
        <LeadModal
          key={modal.leadId ?? "new"}
          lead={editingLead}
          defaultStage={modal.stage}
          notes={leadNotes}
          initialTab={modal.tab}
          onSave={handleSave}
          onDelete={editingLead ? handleDelete : undefined}
          onNewNote={() => editingLead && openNewNote(editingLead.id, true)}
          onOpenNote={(id) => openNote(id, editingLead?.id ?? null)}
          schedules={leadSchedules}
          meId={auth.me?.id ?? null}
          onNewSchedule={() => editingLead && openNewEvent(localYmd(), editingLead.id)}
          onOpenSchedule={(s) => openSchedule(s, editingLead?.id ?? null)}
          onDismissSchedule={dismissSchedule}
          onSchedulesTab={() => editingLead && sched.syncLead(editingLead.id)}
          gmailState={auth.me?.gmail.state ?? "none"}
          meEmail={auth.me?.email ?? ""}
          onGmailExpired={auth.reload}
          onClose={() => setModal({ open: false })}
        />
      )}
      {noteModal.open && (
        <MeetingNoteModal
          key={noteModal.noteId ?? "new"}
          noteId={noteModal.noteId}
          leadId={noteModal.leadId}
          lockLead={noteModal.lockLead}
          leads={leads}
          getNote={meetings.getNote}
          onSave={handleSaveNote}
          onAutoSummarize={handleAutoSummarize}
          onDelete={handleDeleteNote}
          onOpenLead={(leadId) => {
            setNoteModal({ open: false });
            openLead(leadId, "notes");
          }}
          onClose={closeNoteModal}
        />
      )}
      {suggestions.length > 0 && !eventModal.open && (
        <ScheduleSuggestModal
          candidates={suggestions}
          reason={suggestReason}
          company={companyOf}
          calendarState={auth.me?.calendar.state ?? "none"}
          onConfirm={(s) => openSchedule(s)}
          onDismiss={dismissSchedule}
          onLater={(s) => setSuggestions((prev) => prev.filter((x) => x.id !== s.id))}
          onClose={() => setSuggestions([])}
        />
      )}
      {eventModal.open && (
        <EventModal
          key={eventModal.eventId ?? eventModal.initial.scheduleId ?? "new"}
          mode={eventModal.mode}
          initial={eventModal.initial}
          event={eventModal.event}
          editable={eventModal.editable}
          ownerName={eventModal.ownerName}
          evidence={eventModal.evidence}
          heading={eventModal.heading}
          leads={leads}
          calendarState={auth.me?.calendar.state ?? "none"}
          onSubmit={submitEvent}
          onDelete={eventModal.editable && eventModal.eventId ? removeEvent : undefined}
          onClose={closeEventModal}
        />
      )}
      <Toast message={toast?.msg ?? null} />
    </>
  );
}
