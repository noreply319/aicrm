"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Me } from "./types";

/** 로그인 사용자 + 캘린더·Gmail 연동 상태 */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/me"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/login";
  }, []);

  const setCalendarId = useCallback(
    async (calendarId: string) => {
      await api("/api/me", { method: "PATCH", body: JSON.stringify({ calendarId }) });
      await reload();
    },
    [reload]
  );

  const disconnectCalendar = useCallback(async () => {
    await api("/api/calendar/connection", { method: "DELETE" });
    await reload();
  }, [reload]);

  const disconnectGmail = useCallback(async () => {
    await api("/api/gmail/connection", { method: "DELETE" });
    await reload();
  }, [reload]);

  /** 캘린더 API가 연동 만료(409)를 알려주면 화면 상태도 갱신 */
  const markCalendarExpired = useCallback(() => {
    setMe((m) => (m ? { ...m, calendar: { ...m.calendar, state: "expired" } } : m));
  }, []);

  return { me, error, reload, logout, setCalendarId, disconnectCalendar, disconnectGmail, markCalendarExpired };
}
