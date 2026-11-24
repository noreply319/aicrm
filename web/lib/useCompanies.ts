"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { Company, CompanyInput, TeamMember } from "./types";

/** 409 응답에 담긴 기존 회사 (같은 이름·도메인) */
export const conflictCompany = (e: unknown): Company | null => {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const b = e.body;
  return b && typeof b === "object" && "company" in b && b.company && typeof b.company === "object" ? (b.company as Company) : null;
};

const byName = (a: Company, b: Company) => a.name.localeCompare(b.name, "ko");

export function useCompanies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [list, members] = await Promise.all([api<Company[]>("/api/companies"), api<TeamMember[]>("/api/team")]);
      setCompanies(list);
      setTeam(members);
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

  const upsert = (c: Company) => setCompanies((prev) => [...prev.filter((x) => x.id !== c.id), c].sort(byName));

  /**
   * 회사 생성. 같은 이름의 회사가 이미 있으면(409) 기존 회사를 돌려준다 (existing: true).
   * 다른 실패는 예외 — 폼 안에서 보여주므로 화면 상단 에러 배너는 쓰지 않는다.
   */
  const addCompany = useCallback(async (input: Partial<CompanyInput> & { name: string }, opts?: { reuseExisting?: boolean }) => {
    try {
      const created = await api<Company>("/api/companies", { method: "POST", body: JSON.stringify(input) });
      upsert(created);
      return { company: created, existing: false };
    } catch (e) {
      const existing = conflictCompany(e);
      if (existing && opts?.reuseExisting) {
        upsert(existing);
        return { company: existing, existing: true };
      }
      throw e;
    }
  }, []);

  const updateCompany = useCallback(
    async (id: string, input: CompanyInput) => {
      const prev = companies.find((c) => c.id === id);
      if (prev) upsert({ ...prev, ...input });
      try {
        const saved = await api<Company>(`/api/companies/${id}`, { method: "PATCH", body: JSON.stringify(input) });
        upsert(saved);
        return saved;
      } catch (e) {
        reload();
        throw e;
      }
    },
    [companies, reload]
  );

  const deleteCompany = useCallback(
    async (id: string) => {
      setCompanies((prev) => prev.filter((c) => c.id !== id));
      try {
        await api(`/api/companies/${id}`, { method: "DELETE" });
      } catch (e) {
        reload();
        throw e;
      }
    },
    [reload]
  );

  return { companies, team, ready, error, clearError: () => setError(null), reload, addCompany, updateCompany, deleteCompany };
}
