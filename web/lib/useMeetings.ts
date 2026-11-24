"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { MeetingNote, MeetingNoteInput, MeetingNoteSummary } from "./types";

const PREVIEW_CHARS = 200;

const toSummary = ({ body, ...rest }: MeetingNote): MeetingNoteSummary => ({
  ...rest,
  preview: body.slice(0, PREVIEW_CHARS),
});

// 미팅 일시 최신순
const sortNotes = (notes: MeetingNoteSummary[]) =>
  [...notes].sort((a, b) => b.metAt.localeCompare(a.metAt) || b.createdAt.localeCompare(a.createdAt));

/** 미팅 노트 데이터 훅: 목록은 미리보기만 들고, 상세 본문은 getNote로 조회 */
export function useMeetings() {
  const [notes, setNotes] = useState<MeetingNoteSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setNotes(await api<MeetingNoteSummary[]>("/api/meetings"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const fail = useCallback(
    (e: unknown): never => {
      setError((e as Error).message);
      reload();
      throw e;
    },
    [reload]
  );

  const getNote = useCallback((id: string) => api<MeetingNote>(`/api/meetings/${id}`), []);

  const addNote = useCallback(
    async (input: MeetingNoteInput) => {
      try {
        const created = await api<MeetingNote>("/api/meetings", { method: "POST", body: JSON.stringify(input) });
        setNotes((prev) => sortNotes([...prev, toSummary(created)]));
        return created;
      } catch (e) {
        return fail(e);
      }
    },
    [fail]
  );

  const updateNote = useCallback(
    async (id: string, input: MeetingNoteInput) => {
      setNotes((prev) =>
        sortNotes(prev.map((n) => (n.id === id ? { ...n, ...input, preview: input.body.slice(0, PREVIEW_CHARS) } : n)))
      );
      try {
        const saved = await api<MeetingNote>(`/api/meetings/${id}`, { method: "PATCH", body: JSON.stringify(input) });
        setNotes((prev) => sortNotes(prev.map((n) => (n.id === id ? toSummary(saved) : n))));
        return saved;
      } catch (e) {
        return fail(e);
      }
    },
    [fail]
  );

  const deleteNote = useCallback(
    async (id: string) => {
      setNotes((prev) => prev.filter((n) => n.id !== id));
      try {
        await api(`/api/meetings/${id}`, { method: "DELETE" });
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  /** 리드 삭제 시 DB에서 함께 삭제된(CASCADE) 노트를 화면에서도 제거 */
  const forgetLead = useCallback((leadId: string) => {
    setNotes((prev) => prev.filter((n) => n.leadId !== leadId));
  }, []);

  /** 리드별 노트 개수 (카드 배지·삭제 확인용) */
  const countByLead = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of notes) m[n.leadId] = (m[n.leadId] ?? 0) + 1;
    return m;
  }, [notes]);

  return {
    notes, ready, error, clearError: () => setError(null), reload,
    getNote, addNote, updateNote, deleteNote, forgetLead, countByLead,
  };
}
