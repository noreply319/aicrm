"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { CalendarEvent, CalendarEventInput, ExtractResult, ScheduledMeeting } from "./types";

type EventResult = { event: CalendarEvent; schedule: ScheduledMeeting };

const sortByStart = (list: ScheduledMeeting[]) => [...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt));

/**
 * 다음 미팅 일정 훅: 미팅 노트에서 찾은 후보 + CRM에서 캘린더에 등록한 일정.
 * 캘린더 이벤트 생성·수정·삭제도 여기서 한다 (version이 바뀌면 캘린더 화면이 다시 불러온다).
 */
export function useSchedules() {
  const [schedules, setSchedules] = useState<ScheduledMeeting[]>([]);
  const [version, setVersion] = useState(0);

  const reload = useCallback(async () => {
    try {
      setSchedules(await api<ScheduledMeeting[]>("/api/schedules"));
    } catch {
      // 일정은 부가 정보라 실패해도 다른 화면은 그대로 둔다
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const upsert = useCallback((s: ScheduledMeeting) => {
    setSchedules((prev) => sortByStart([...prev.filter((x) => x.id !== s.id), s]));
  }, []);

  /** 리드 상세를 열 때: 구글에서 바뀐 내용을 반영해 그 리드의 일정을 다시 받는다 */
  const syncLead = useCallback(async (leadId: string) => {
    try {
      const list = await api<ScheduledMeeting[]>(`/api/schedules?leadId=${leadId}&sync=1`);
      setSchedules((prev) => sortByStart([...prev.filter((s) => s.leadId !== leadId), ...list]));
    } catch {}
  }, []);

  /** 저장된 노트에서 다음 미팅 찾기: 확정된 일정은 서버가 캘린더에 자동 등록, 나머지는 후보 */
  const extract = useCallback(async (noteId: string) => {
    const r = await api<ExtractResult>(`/api/meetings/${noteId}/schedule-candidates`, { method: "POST" });
    const found = [...r.registered, ...r.candidates];
    if (found.length) setSchedules((prev) => sortByStart([...prev.filter((s) => !found.some((f) => f.id === s.id)), ...found]));
    if (r.registered.length) setVersion((v) => v + 1);
    return r;
  }, []);

  const dismiss = useCallback(async (id: string) => {
    setSchedules((prev) => prev.filter((s) => s.id !== id));
    try {
      await api(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ status: "dismissed" }) });
    } catch (e) {
      reload();
      throw e;
    }
  }, [reload]);

  const createEvent = useCallback(async (input: CalendarEventInput) => {
    const r = await api<EventResult>("/api/calendar/events", { method: "POST", body: JSON.stringify(input) });
    upsert(r.schedule);
    setVersion((v) => v + 1);
    return r;
  }, [upsert]);

  const updateEvent = useCallback(async (eventId: string, input: CalendarEventInput) => {
    const r = await api<EventResult>(`/api/calendar/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    upsert(r.schedule);
    setVersion((v) => v + 1);
    return r;
  }, [upsert]);

  const deleteEvent = useCallback(async (eventId: string) => {
    await api(`/api/calendar/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    setSchedules((prev) => prev.filter((s) => s.googleEventId !== eventId));
    setVersion((v) => v + 1);
  }, []);

  /** 리드 카드 배지용: 리드별 가장 가까운 앞으로의 등록 일정 */
  const nextByLead = useMemo(() => {
    const now = new Date().toISOString();
    const m: Record<string, ScheduledMeeting> = {};
    for (const s of schedules) {
      if (s.status !== "scheduled" || !s.leadId || s.endsAt < now) continue;
      if (!m[s.leadId] || s.startsAt < m[s.leadId].startsAt) m[s.leadId] = s;
    }
    return m;
  }, [schedules]);

  const candidates = useMemo(() => schedules.filter((s) => s.status === "candidate"), [schedules]);

  /** 리드 삭제 시 DB에서 함께 삭제된(CASCADE) 일정을 화면에서도 제거 */
  const forgetLead = useCallback((leadId: string) => {
    setSchedules((prev) => prev.filter((s) => s.leadId !== leadId));
  }, []);

  return {
    schedules, candidates, nextByLead, version, reload, syncLead, extract, dismiss,
    createEvent, updateEvent, deleteEvent, forgetLead,
  };
}
