"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { STAGES } from "@/lib/constants";
import { useLeads } from "@/lib/useLeads";
import { useMeetings } from "@/lib/useMeetings";
import type { LeadInput, MeetingNoteInput, StageId } from "@/lib/types";
import Header, { type View } from "./Header";
import StatsBar from "./StatsBar";
import Board from "./Board";
import LeadModal, { type LeadModalTab } from "./LeadModal";
import MeetingList from "./MeetingList";
import MeetingNoteModal from "./MeetingNoteModal";
import Toast from "./Toast";
import AssistantPanel from "./AssistantPanel";

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

export default function CrmApp() {
  const pathname = usePathname();
  const view: View = pathname.startsWith("/meetings") ? "meetings" : "pipeline";

  const { leads, ready, error, clearError, reload, addLead, updateLead, deleteLead, moveLead } = useLeads();
  const meetings = useMeetings();
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

  const onAdd = useCallback(() => (view === "meetings" ? openNewNote() : openNew()), [view, openNew, openNewNote]);

  // 'N' 키: 파이프라인에서는 새 리드, 미팅 노트에서는 노트 작성
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      if (e.key === "n" && !modal.open && !noteModal.open && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
        e.preventDefault();
        onAdd();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal.open, noteModal.open, onAdd]);

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
      showToast("삭제되었습니다");
    } catch {}
  };

  const handleSaveNote = async (input: MeetingNoteInput, id: string | null, opts?: { auto?: boolean }) => {
    const saved = id ? await meetings.updateNote(id, input) : await meetings.addNote(input);
    showToast(
      opts?.auto
        ? "녹음이 끝나 미팅 노트가 자동 저장되었습니다"
        : id ? "미팅 노트가 수정되었습니다" : "미팅 노트가 저장되었습니다"
    );
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
      />
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
                  onMove={handleMove}
                  onOpen={(id) => openLead(id)}
                  onAddInStage={openNew}
                />
              )}
            </>
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
          onDelete={handleDeleteNote}
          onOpenLead={(leadId) => {
            setNoteModal({ open: false });
            openLead(leadId, "notes");
          }}
          onClose={closeNoteModal}
        />
      )}
      <Toast message={toast?.msg ?? null} />
    </>
  );
}
