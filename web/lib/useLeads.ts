"use client";

import { useCallback, useEffect, useState } from "react";
import type { Lead, LeadInput, StageId } from "./types";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `요청 실패 (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function useLeads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLeads(await api<Lead[]>("/api/leads"));
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

  // 실패 시 서버 상태로 되돌리고 에러를 다시 던진다
  const fail = useCallback(
    (e: unknown): never => {
      setError((e as Error).message);
      reload();
      throw e;
    },
    [reload]
  );

  const addLead = useCallback(
    async (input: LeadInput) => {
      try {
        const created = await api<Lead>("/api/leads", { method: "POST", body: JSON.stringify(input) });
        setLeads((prev) => [...prev, created]);
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  const updateLead = useCallback(
    async (id: string, input: LeadInput) => {
      setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...input } : l)));
      try {
        const saved = await api<Lead>(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify(input) });
        setLeads((prev) => prev.map((l) => (l.id === id ? saved : l)));
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  const deleteLead = useCallback(
    async (id: string) => {
      setLeads((prev) => prev.filter((l) => l.id !== id));
      try {
        await api(`/api/leads/${id}`, { method: "DELETE" });
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  /** 리드를 stage로 옮기고, beforeId 카드 앞에 배치한다 (null이면 맨 뒤). 화면은 즉시 반영. */
  const moveLead = useCallback(
    async (id: string, stage: StageId, beforeId: string | null) => {
      setLeads((prev) => {
        const lead = prev.find((l) => l.id === id);
        if (!lead) return prev;
        const rest = prev.filter((l) => l.id !== id);
        const moved = { ...lead, stage };
        const idx = beforeId ? rest.findIndex((l) => l.id === beforeId) : -1;
        if (idx >= 0) rest.splice(idx, 0, moved);
        else rest.push(moved);
        return rest;
      });
      try {
        await api(`/api/leads/${id}/move`, { method: "POST", body: JSON.stringify({ stage, beforeId }) });
      } catch (e) {
        fail(e);
      }
    },
    [fail]
  );

  return { leads, ready, error, clearError: () => setError(null), reload, addLead, updateLead, deleteLead, moveLead };
}
