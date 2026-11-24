"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { Contact, ContactInput } from "./types";

/** 409 응답에 담긴 기존 연락처 (같은 이메일) */
export const conflictContact = (e: unknown): Contact | null => {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const b = e.body;
  return b && typeof b === "object" && "contact" in b && b.contact && typeof b.contact === "object" ? (b.contact as Contact) : null;
};

const byName = (a: Contact, b: Contact) => a.name.localeCompare(b.name, "ko");

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setContacts(await api<Contact[]>("/api/contacts"));
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

  const upsert = (c: Contact) => setContacts((prev) => [...prev.filter((x) => x.id !== c.id), c].sort(byName));

  /** 연락처 생성. 실패(같은 이메일 409 등)는 예외 — 폼 안에서 보여준다 */
  const addContact = useCallback(async (input: Partial<ContactInput> & { name: string }) => {
    const created = await api<Contact>("/api/contacts", { method: "POST", body: JSON.stringify(input) });
    upsert(created);
    return created;
  }, []);

  const updateContact = useCallback(
    async (id: string, input: ContactInput) => {
      const prev = contacts.find((c) => c.id === id);
      if (prev) upsert({ ...prev, ...input });
      try {
        const saved = await api<Contact>(`/api/contacts/${id}`, { method: "PATCH", body: JSON.stringify(input) });
        upsert(saved);
        return saved;
      } catch (e) {
        reload();
        throw e;
      }
    },
    [contacts, reload]
  );

  const deleteContact = useCallback(
    async (id: string) => {
      setContacts((prev) => prev.filter((c) => c.id !== id));
      try {
        await api(`/api/contacts/${id}`, { method: "DELETE" });
      } catch (e) {
        reload();
        throw e;
      }
    },
    [reload]
  );

  /** 회사가 삭제되면 소속 연락처는 회사 없음 (서버는 FK SET NULL) */
  const forgetCompany = useCallback((companyId: string) => {
    setContacts((prev) => prev.map((c) => (c.companyId === companyId ? { ...c, companyId: null } : c)));
  }, []);

  return { contacts, ready, error, clearError: () => setError(null), reload, addContact, updateContact, deleteContact, forgetCompany };
}
