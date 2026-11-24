"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STAGES } from "@/lib/constants";
import { useLeads } from "@/lib/useLeads";
import type { LeadInput, StageId } from "@/lib/types";
import Header from "./Header";
import StatsBar from "./StatsBar";
import Board from "./Board";
import LeadModal from "./LeadModal";
import Toast from "./Toast";
import AssistantPanel from "./AssistantPanel";

type ModalState = { open: false } | { open: true; leadId: string | null; stage: StageId };

export default function CrmApp() {
  const { leads, ready, error, clearError, reload, addLead, updateLead, deleteLead, moveLead } = useLeads();
  const [query, setQuery] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [modal, setModal] = useState<ModalState>({ open: false });
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast({ msg, key: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  const openNew = useCallback((stage: StageId = "new") => {
    setModal({ open: true, leadId: null, stage });
  }, []);

  // 'N' 키로 새 리드 등록
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      if (e.key === "n" && !modal.open && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
        e.preventDefault();
        openNew();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal.open, openNew]);

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
    if (!confirm("이 리드를 삭제할까요?")) return;
    const id = modal.leadId;
    setModal({ open: false });
    try {
      await deleteLead(id);
      showToast("삭제되었습니다");
    } catch {}
  };

  const editingLead = modal.open && modal.leadId ? leads.find((l) => l.id === modal.leadId) ?? null : null;

  return (
    <>
      <Header
        query={query}
        onQuery={setQuery}
        onAdd={() => openNew()}
        assistantOpen={assistantOpen}
        onToggleAssistant={() => setAssistantOpen((v) => !v)}
      />
      <StatsBar leads={leads} />
      {error && (
        <div className="error-banner" role="alert">
          <span>⚠ {error}</span>
          <button className="btn" onClick={() => { clearError(); reload(); }}>다시 불러오기</button>
        </div>
      )}
      <div className="workspace">
        <div className="workspace-main">
          {!ready && <div className="loading">불러오는 중…</div>}
          {ready && (
            <Board
              leads={visibleLeads}
              onMove={handleMove}
              onOpen={(id) => {
                const l = leads.find((x) => x.id === id);
                if (l) setModal({ open: true, leadId: id, stage: l.stage });
              }}
              onAddInStage={openNew}
            />
          )}
        </div>
        {/* 닫아도 대화가 유지되도록 언마운트하지 않고 숨긴다 */}
        <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
      </div>
      {modal.open && (
        <LeadModal
          lead={editingLead}
          defaultStage={modal.stage}
          onSave={handleSave}
          onDelete={editingLead ? handleDelete : undefined}
          onClose={() => setModal({ open: false })}
        />
      )}
      <Toast message={toast?.msg ?? null} />
    </>
  );
}
