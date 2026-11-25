"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SettingsModalContext } from "@/lib/settingsModal";
import { statsByCompany } from "@/lib/company";
import { statsByContact } from "@/lib/contact";
import { ASSISTANT_KEY, CRM_DESCRIPTION_MARK, MOBILE_QUERY, STAGES, stripCrmPrefix } from "@/lib/constants";
import { formatDateTime, fromLocalInput, memoFromDescription } from "@/lib/format";
import { useCompanies } from "@/lib/useCompanies";
import { useContacts } from "@/lib/useContacts";
import { useLeads } from "@/lib/useLeads";
import { useMe } from "@/lib/useMe";
import { useMeetings } from "@/lib/useMeetings";
import { useSchedules } from "@/lib/useSchedules";
import type {
  CalendarEvent, CalendarEventInput, Company, CompanyInput, Contact, ContactInput, LeadInput, MeetingNoteInput, ScheduledMeeting, StageId,
} from "@/lib/types";
import Header from "./Header";
import Sidebar, { type View } from "./Sidebar";
import { Alert, Button, Modal, ModalFooter, ModalHeader } from "./ui";
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
import ContractsView from "./ContractsView";
import CompanyList from "./CompanyList";
import CompanyDetail from "./CompanyDetail";
import CompanyModal from "./CompanyModal";
import ContactList from "./ContactList";
import ContactDetail from "./ContactDetail";
import ContactModal from "./ContactModal";
import type { QuickContact } from "./ContactCombobox";

type ModalState =
  | { open: false }
  | { open: true; leadId: string | null; stage: StageId; tab: LeadModalTab; companyId?: string | null; contactId?: string | null };

/** 회사 등록·수정 모달: companyId null이면 새 회사 */
type CompanyModalState = { open: false } | { open: true; companyId: string | null };

/** 연락처 등록·수정 모달: contactId null이면 새 연락처 (companyId: 새 연락처의 소속 회사) */
type ContactModalState = { open: false } | { open: true; contactId: string | null; companyId?: string | null };

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

/** 첫 화면(/)은 AI Assistant 대화, 파이프라인은 /pipeline */
const viewOf = (pathname: string): View =>
  pathname.startsWith("/pipeline") ? "pipeline"
  : pathname.startsWith("/companies") ? "companies"
  : pathname.startsWith("/contacts") ? "contacts"
  : pathname.startsWith("/meetings") ? "meetings"
    : pathname.startsWith("/contracts") ? "contracts"
    : pathname.startsWith("/calendar") ? "calendar"
        : "assistant";

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
  const router = useRouter();
  const view = viewOf(pathname);
  /** /companies/[id] 의 회사 id */
  const detailCompanyId = view === "companies" ? decodeURIComponent(pathname.split("/")[2] ?? "") || null : null;
  /** /contacts/[id] 의 연락처 id */
  const detailContactId = view === "contacts" ? decodeURIComponent(pathname.split("/")[2] ?? "") || null : null;

  const { leads, ready, error, clearError, reload, addLead, updateLead, deleteLead, moveLead } = useLeads();
  const companiesApi = useCompanies();
  const { companies } = companiesApi;
  const companyStats = useMemo(() => statsByCompany(leads), [leads]);
  const [companyModal, setCompanyModal] = useState<CompanyModalState>({ open: false });
  const contactsApi = useContacts();
  const { contacts } = contactsApi;
  const contactStats = useMemo(() => statsByContact(leads), [leads]);
  const [contactModal, setContactModal] = useState<ContactModalState>({ open: false });
  const meetings = useMeetings();
  const auth = useMe();
  const sched = useSchedules();
  const [eventModal, setEventModal] = useState<EventModalState>({ open: false });
  const [suggestions, setSuggestions] = useState<ScheduledMeeting[]>([]);
  /** 자동 등록하지 못한 이유 (확인 창 안내 문구) */
  const [suggestReason, setSuggestReason] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(true);
  /** 모바일 전체 화면 메뉴 (햄버거 버튼) */
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const [modal, setModal] = useState<ModalState>({ open: false });
  const [noteModal, setNoteModal] = useState<NoteModalState>({ open: false });
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // 처음 상태: 마지막으로 고른 상태 (모바일은 첫 화면에서만 대화를 보여주므로 상관없음).
  // 그 뒤 다음 프레임부터 열기/닫기·메뉴 접기 애니메이션을 켠다 (첫 화면에서 움직이지 않게).
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(ASSISTANT_KEY);
    } catch {}
    if (window.matchMedia(MOBILE_QUERY).matches || saved === "closed") setAssistantOpen(false);
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => document.documentElement.classList.add("ui-anim"));
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const changeAssistant = useCallback((open: boolean) => {
    setAssistantOpen(open);
    try {
      localStorage.setItem(ASSISTANT_KEY, open ? "open" : "closed");
    } catch {}
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

  /** 설정 모달: 프로필 메뉴·안내 링크에서 열거나, /settings 주소(구글 연동 후 돌아옴)로 들어오면 열린다 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const onSettingsPath = pathname.startsWith("/settings");
  useEffect(() => {
    if (onSettingsPath) setSettingsOpen(true);
  }, [onSettingsPath]);

  const openSettings = useCallback(() => {
    // 다른 모달 위에 겹치지 않게 닫고 연다
    setModal({ open: false });
    setEventModal({ open: false });
    setSuggestions([]);
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (onSettingsPath) router.replace("/");
  }, [onSettingsPath, router]);

  const openCompany = useCallback((id: string) => {
    setModal({ open: false });
    setCompanyModal({ open: false });
    router.push(`/companies/${id}`);
  }, [router]);

  const openContact = useCallback((id: string) => {
    setModal({ open: false });
    setContactModal({ open: false });
    router.push(`/contacts/${id}`);
  }, [router]);

  const onAdd = useCallback(() => {
    if (view === "companies") setCompanyModal({ open: true, companyId: null });
    else if (view === "contacts") setContactModal({ open: true, contactId: null });
    else if (view === "meetings") openNewNote();
    else if (view === "calendar") openNewEvent();
    else if (view === "pipeline") openNew();
  }, [view, openNew, openNewNote, openNewEvent]);

  // 'N' 키: 파이프라인에서는 새 리드, 미팅 노트에서는 노트 작성
  // 모달이 늘어나도 의존성 배열 크기가 바뀌지 않게 하나의 값으로 합친다 (HMR 경고 방지)
  const anyModalOpen = modal.open || noteModal.open || eventModal.open || companyModal.open || contactModal.open || settingsOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      if (e.key === "n" && !anyModalOpen && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
        e.preventDefault();
        onAdd();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyModalOpen, onAdd]);

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

  /** 리드 모달에서 이름만으로 회사 생성 (같은 이름이 이미 있으면 그 회사를 선택) */
  const createCompanyFromLead = async (name: string): Promise<Company> => {
    const { company, existing } = await companiesApi.addCompany({ name }, { reuseExisting: true });
    showToast(existing ? `이미 있는 회사 '${company.name}'를 선택했어요` : `회사 '${company.name}'를 만들었어요`);
    return company;
  };

  const editingCompany = companyModal.open && companyModal.companyId
    ? companies.find((c) => c.id === companyModal.companyId) ?? null
    : null;

  const saveCompany = async (input: CompanyInput) => {
    if (!companyModal.open) return;
    if (editingCompany) {
      const renamed = editingCompany.name !== input.name;
      await companiesApi.updateCompany(editingCompany.id, input);
      // 회사명을 바꾸면 서버가 연결 리드의 회사명도 바꾼다 → 리드 다시 불러오기
      if (renamed) reload();
      showToast("회사 정보를 수정했습니다");
      setCompanyModal({ open: false });
    } else {
      const { company } = await companiesApi.addCompany(input);
      showToast("회사를 등록했습니다");
      setCompanyModal({ open: false });
      router.push(`/companies/${company.id}`);
    }
  };

  const removeCompany = async () => {
    if (!editingCompany) return;
    await companiesApi.deleteCompany(editingCompany.id);
    contactsApi.forgetCompany(editingCompany.id);
    setCompanyModal({ open: false });
    showToast("회사를 삭제했습니다");
    router.push("/companies");
  };

  /** 리드 모달에서 담당자를 바로 생성 (회사는 리드의 회사) */
  const createContactFromLead = async (input: QuickContact, companyId: string | null): Promise<Contact> => {
    const contact = await contactsApi.addContact({ ...input, companyId });
    showToast(`연락처 '${contact.name}'을(를) 만들었어요`);
    return contact;
  };

  const editingContact = contactModal.open && contactModal.contactId
    ? contacts.find((c) => c.id === contactModal.contactId) ?? null
    : null;

  const saveContact = async (input: ContactInput) => {
    if (!contactModal.open) return;
    if (editingContact) {
      const copyChanged = (["name", "title", "email", "mobile", "officePhone"] as const).some((k) => editingContact[k] !== input[k]);
      await contactsApi.updateContact(editingContact.id, input);
      // 담당자 사본이 바뀌면 서버가 연결 리드도 바꾼다 → 리드 다시 불러오기
      if (copyChanged && contactStats[editingContact.id]) reload();
      showToast("연락처를 수정했습니다");
      setContactModal({ open: false });
    } else {
      const contact = await contactsApi.addContact(input);
      showToast("연락처를 등록했습니다");
      setContactModal({ open: false });
      // 연락처 메뉴에서 등록했으면 상세로 이동 (회사 상세에서 추가했으면 그 화면에 머문다)
      if (view === "contacts") router.push(`/contacts/${contact.id}`);
    }
  };

  const removeContact = async () => {
    if (!editingContact) return;
    const id = editingContact.id;
    await contactsApi.deleteContact(id);
    setContactModal({ open: false });
    showToast("연락처를 삭제했습니다");
    // 연결 리드는 서버에서 연결만 해제됨 → 리드 다시 불러오기
    if (contactStats[id]) reload();
    if (detailContactId === id) router.push("/contacts");
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

  const bannerError = error ?? meetings.error ?? companiesApi.error ?? contactsApi.error;
  const detailContact = detailContactId ? contacts.find((c) => c.id === detailContactId) ?? null : null;
  const contactTags = useMemo(() => [...new Set(contacts.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b, "ko")), [contacts]);
  const contactOpenLeads = useMemo(
    () => Object.fromEntries(Object.entries(contactStats).map(([k, v]) => [k, v.open])),
    [contactStats]
  );
  const detailCompany = detailCompanyId ? companies.find((c) => c.id === detailCompanyId) ?? null : null;
  const companyIndustries = useMemo(
    () => [...new Set(companies.map((c) => c.industry).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    [companies]
  );
  const companyTags = useMemo(() => [...new Set(companies.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b, "ko")), [companies]);

  return (
    <SettingsModalContext value={openSettings}>
      {/* home: 첫 화면(/) — AI Assistant 대화가 메인 영역 전체를 쓴다.
          ai-open: 다른 화면의 모바일에서 AI 채팅이 메뉴·상단 바·메인 대신 화면 전체를 쓰는 별도 화면이 된다 */}
      <div className={`app-shell${view === "assistant" ? " home" : assistantOpen && view !== "contracts" ? " ai-open" : ""}`}>
        <Sidebar
          view={view}
          me={auth.me}
          onLogout={auth.logout}
          onNavigate={() => {
            // 모바일: 메뉴를 고르면 전체 화면 메뉴를 닫고, AI 채팅이 열려 있었다면 함께 닫는다
            setMenuOpen(false);
            if (assistantOpen && window.matchMedia(MOBILE_QUERY).matches) changeAssistant(false);
          }}
          menuOpen={menuOpen}
          onCloseMenu={closeMenu}
        />
        {/* 모바일 전체 화면 메뉴가 열려 있는 동안 뒤 화면은 포커스·클릭 불가 */}
        <div className="app-main" inert={menuOpen}>
          <Header
            view={view}
            query={query}
            onQuery={setQuery}
            onAdd={onAdd}
            assistantOpen={assistantOpen}
            onToggleAssistant={() => changeAssistant(!assistantOpen)}
            menuOpen={menuOpen}
            onOpenMenu={() => setMenuOpen(true)}
          />
          {/* 왼쪽: 배너·지표·화면 / 오른쪽: AI Assistant (상단 바 아래부터 화면 끝까지 고정) */}
          <div className="workspace">
            <div className="workspace-main">
              {auth.me?.calendar.state === "expired" && !settingsOpen && (
                <Alert tone="warning" banner action={<Button size="sm" href="/api/calendar/connect">다시 연동</Button>}>
                  구글 캘린더 연동이 만료되었습니다. 캘린더 기능을 쓰려면 다시 연동하세요.
                </Alert>
              )}
              {/* 토큰은 캘린더·Gmail 공용이라 캘린더 배너가 있으면 그것만 보여준다 */}
              {auth.me?.gmail.state === "expired" && auth.me.calendar.state !== "expired" && !settingsOpen && (
                <Alert tone="warning" banner action={<Button size="sm" href="/api/gmail/connect">다시 연동</Button>}>
                  Gmail 연동이 만료되었습니다. 리드 이메일을 보려면 다시 연동하세요.
                </Alert>
              )}
              {view === "pipeline" && <StatsBar leads={leads} />}
              {bannerError && (
                <Alert
                  tone="danger"
                  banner
                  action={
                    <Button
                      size="sm"
                      onClick={() => {
                        clearError();
                        meetings.clearError();
                        companiesApi.clearError();
                        contactsApi.clearError();
                        reload();
                        meetings.reload();
                        companiesApi.reload();
                        contactsApi.reload();
                      }}
                    >
                      다시 불러오기
                    </Button>
                  }
                >
                  {bannerError}
                </Alert>
              )}
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
              ) : view === "companies" ? (
                detailCompanyId ? (
                  <CompanyDetail
                    company={detailCompany}
                    ready={companiesApi.ready && ready}
                    stats={detailCompany ? companyStats[detailCompany.id] : undefined}
                    leads={detailCompany ? leads.filter((l) => l.companyId === detailCompany.id) : []}
                    team={companiesApi.team}
                    onEdit={() => detailCompany && setCompanyModal({ open: true, companyId: detailCompany.id })}
                    onOpenLead={(id) => openLead(id)}
                    onAddLead={() => detailCompany && setModal({ open: true, leadId: null, stage: "new", tab: "info", companyId: detailCompany.id })}
                    contacts={detailCompany ? contacts.filter((c) => c.companyId === detailCompany.id) : []}
                    contactOpenLeads={contactOpenLeads}
                    onOpenContact={openContact}
                    onAddContact={() => detailCompany && setContactModal({ open: true, contactId: null, companyId: detailCompany.id })}
                  />
                ) : (
                  <CompanyList
                    companies={companies}
                    stats={companyStats}
                    team={companiesApi.team}
                    meId={auth.me?.id ?? null}
                    query={query}
                    ready={companiesApi.ready && ready}
                    onOpen={openCompany}
                    onNew={() => setCompanyModal({ open: true, companyId: null })}
                  />
                )
              ) : view === "contacts" ? (
                detailContactId ? (
                  <ContactDetail
                    contact={detailContact}
                    company={detailContact?.companyId ? companies.find((c) => c.id === detailContact.companyId) ?? null : null}
                    ready={contactsApi.ready && ready}
                    stats={detailContact ? contactStats[detailContact.id] : undefined}
                    leads={detailContact ? leads.filter((l) => l.contactId === detailContact.id) : []}
                    team={companiesApi.team}
                    onEdit={() => detailContact && setContactModal({ open: true, contactId: detailContact.id })}
                    onOpenLead={(id) => openLead(id)}
                    onAddLead={() => detailContact && setModal({ open: true, leadId: null, stage: "new", tab: "info", contactId: detailContact.id })}
                  />
                ) : (
                  <ContactList
                    contacts={contacts}
                    companies={companies}
                    stats={contactStats}
                    team={companiesApi.team}
                    meId={auth.me?.id ?? null}
                    query={query}
                    ready={contactsApi.ready && ready}
                    onOpen={openContact}
                    onNew={() => setContactModal({ open: true, contactId: null })}
                  />
                )
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
              ) : view === "contracts" ? (
                <ContractsView me={auth.me} onLeadsChanged={reload} onMeChanged={auth.reload} onNotice={showToast} />
              ) : view === "meetings" ? (
                <MeetingList
                  notes={meetings.notes}
                  leads={leads}
                  query={query}
                  ready={meetings.ready && ready}
                  onOpen={(id) => openNote(id)}
                  onNew={() => openNewNote()}
                />
              ) : null}
            </div>
            {/* 닫아도 대화가 유지되도록 언마운트하지 않고 숨긴다 */}
            {/* 계약서 화면은 왼쪽에 문서 작성 Assistant가 따로 있어 조회형 Assistant(다시 열기 탭 포함)를 숨긴다 */}
            <div className="assistant-slot" hidden={view === "contracts"}>
              <AssistantPanel
                open={assistantOpen}
                home={view === "assistant"}
                me={auth.me}
                onOpen={() => changeAssistant(true)}
                onClose={() => changeAssistant(false)}
                onLeadsChanged={reload}
                onNotice={showToast}
              />
            </div>
          </div>
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
            companies={companies}
            companyStats={companyStats}
            defaultCompanyId={modal.companyId ?? null}
            onCreateCompany={createCompanyFromLead}
            onOpenCompany={openCompany}
            contacts={contacts}
            defaultContactId={modal.contactId ?? null}
            onCreateContact={createContactFromLead}
            onOpenContact={openContact}
            onEditContact={(id) => setContactModal({ open: true, contactId: id })}
            onClose={() => setModal({ open: false })}
          />
        )}
        {/* 리드 모달 위에서도 열 수 있도록 리드 모달 다음에 렌더 */}
        {contactModal.open && (
          <ContactModal
            key={contactModal.contactId ?? "new"}
            contact={editingContact}
            contacts={contacts}
            companies={companies}
            companyStats={companyStats}
            team={companiesApi.team}
            allTags={contactTags}
            leadCount={editingContact ? contactStats[editingContact.id]?.total ?? 0 : 0}
            defaultCompanyId={contactModal.companyId ?? null}
            onSave={saveContact}
            onDelete={editingContact ? removeContact : undefined}
            onCreateCompany={createCompanyFromLead}
            onOpenContact={openContact}
            onClose={() => setContactModal({ open: false })}
          />
        )}
        {companyModal.open && (
          <CompanyModal
            key={companyModal.companyId ?? "new"}
            company={editingCompany}
            team={companiesApi.team}
            industries={companyIndustries}
            allTags={companyTags}
            leadCount={editingCompany ? companyStats[editingCompany.id]?.total ?? 0 : 0}
            contactCount={editingCompany ? contacts.filter((c) => c.companyId === editingCompany.id).length : 0}
            onSave={saveCompany}
            onDelete={editingCompany ? removeCompany : undefined}
            onOpenCompany={openCompany}
            onClose={() => setCompanyModal({ open: false })}
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
        {settingsOpen && (
          <Modal label="설정" size="lg" className="settings-modal" onClose={closeSettings}>
            <ModalHeader title="설정" onClose={closeSettings} />
            <SettingsView
              me={auth.me}
              onSetCalendar={auth.setCalendarId}
              onDisconnect={auth.disconnectCalendar}
              onDisconnectGmail={auth.disconnectGmail}
              onLogout={auth.logout}
              onNotice={showToast}
            />
            <ModalFooter>
              <Button onClick={closeSettings}>닫기</Button>
            </ModalFooter>
          </Modal>
        )}
        <Toast message={toast?.msg ?? null} />
      </div>
    </SettingsModalContext>
  );
}
