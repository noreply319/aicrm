import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// 구글 캘린더·AI(요약·후보 찾기)는 가짜로 대체 (외부 호출 없음)
const google = vi.hoisted(() => ({ calls: [] as { op: string; eventId?: string; title?: string; notify?: boolean; attendees?: string[] }[], n: 0 }));
vi.mock("@/lib/calendar", async (orig) => {
  const real = await orig<typeof import("@/lib/calendar")>();
  const ev = (id: string, input: { title: string; allDay: boolean; start: string; end: string; location: string }) => ({
    id, title: input.title, allDay: input.allDay, start: input.start, end: input.end, location: input.location,
    description: "", htmlLink: `https://calendar.google.com/${id}`, crm: null,
  });
  return {
    ...real,
    insertEvent: async (_u: unknown, input: Parameters<typeof real.insertEvent>[1], extra: { attendees?: string[] }) => {
      const id = `gev${++google.n}`;
      google.calls.push({ op: "insert", eventId: id, title: input.title, attendees: extra.attendees ?? [] });
      return { ...ev(id, input), calendarId: "primary" };
    },
    patchEvent: async (_u: unknown, eventId: string, _c: unknown, input: Parameters<typeof real.patchEvent>[3], extra: { notify: boolean }) => {
      google.calls.push({ op: "patch", eventId, title: input.title, notify: extra.notify });
      return ev(eventId, input);
    },
    deleteEvent: async (_u: unknown, eventId: string, _c: unknown, notify: boolean) => {
      google.calls.push({ op: "delete", eventId, notify });
    },
  };
});
const ai = vi.hoisted(() => ({ summarized: [] as string[], candidates: 0 }));
vi.mock("@/lib/noteOps", async (orig) => ({
  ...(await orig<typeof import("@/lib/noteOps")>()),
  summarizeAndSaveNote: async (id: string) => {
    ai.summarized.push(id);
    return { ok: true, note: null };
  },
}));
vi.mock("@/lib/schedules", async (orig) => ({
  ...(await orig<typeof import("@/lib/schedules")>()),
  createCandidatesForNote: async () => Array.from({ length: ai.candidates }, () => ({})),
}));

import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { decideAction, savePlan } from "@/lib/agent";
import type { PreparedPlan } from "@/lib/agentToolKit";
import { AGENT_TOOLS } from "@/lib/agentTools";
import { pool } from "@/lib/db";
import type { Lead } from "@/lib/types";
import { closeDb, events, leadInput, req, resetDb } from "./helpers";

const ME = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";

beforeEach(async () => {
  await resetDb();
  await pool.query("DELETE FROM scheduled_meetings");
  // ME: 캘린더 연동됨 / OTHER: 미연동
  await pool.query(
    `INSERT INTO users (id, google_sub, email, name, google_refresh_token, calendar_enabled) VALUES
       ($1, 'meet-me', 'me@test.com', '나', 'enc', true), ($2, 'meet-other', 'other@test.com', '동료', NULL, false)
     ON CONFLICT (id) DO UPDATE SET google_refresh_token = EXCLUDED.google_refresh_token, calendar_enabled = EXCLUDED.calendar_enabled, calendar_expired = false`,
    [ME, OTHER]
  );
  google.calls = [];
  google.n = 0;
  ai.summarized = [];
  ai.candidates = 0;
});
afterAll(closeDb);

const lead = async (over = {}) => (await (await CREATE_LEAD(req("POST", leadInput(over)))).json()) as Lead;

async function prepare(tool: string, args: Record<string, unknown>, userId = ME) {
  const t = AGENT_TOOLS[tool];
  if (t.kind !== "write") throw new Error("write tool only");
  return t.prepare(args, userId);
}
async function plan(tool: string, args: Record<string, unknown>, userId = ME) {
  const p = await prepare(tool, args, userId);
  if ("error" in p) throw new Error(p.error);
  return savePlan(userId, tool, p as PreparedPlan);
}

describe("Sales Agent 미팅 노트", () => {
  it("노트 작성: 확정 날짜 카드 → 승인 시 저장 + note_created(via: agent) + 후속 AI 요약·후보 찾기", async () => {
    const l = await lead({ company: "노트상사", contact: "김민수" });
    ai.candidates = 1;
    const p = await plan("create_meeting_note", { leadId: l.id, title: "도입 미팅", date: "2026-12-01", time: "14:00", body: "견적 요청. 다음 주 화요일 3시 재미팅" });
    expect(p.changes).toContainEqual({ field: "미팅 일시", after: "2026-12-01(화) 14:00" });
    expect(p.notice?.text).toContain("AI 요약");

    const r = await decideAction(p.id, ME, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "done", target: { kind: "note" } } });
    if (!r.ok) throw new Error();
    expect(r.plan.message).toBe("미팅 노트를 저장했습니다 · AI 요약 완료 · 다음 미팅 후보 1건 (캘린더 메뉴에서 확정)");
    const note = (await pool.query("SELECT id, met_at FROM meeting_notes WHERE lead_id=$1", [l.id])).rows[0];
    expect(new Date(note.met_at).toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(ai.summarized).toEqual([note.id]);
    expect((await events(l.id)).at(-1)).toMatchObject({ type: "note_created", changes: { via: "assistant" } });
    expect(google.calls).toEqual([]); // 후보는 캘린더에 등록하지 않는다
  });

  it("검색은 이메일·전화번호를 가려서 돌려준다", async () => {
    const l = await lead({ company: "검색상사" });
    await pool.query(
      `INSERT INTO meeting_notes (lead_id, title, met_at, body, source, summary) VALUES ($1, '킥오프', now(), '연락 kim@a.com 010-1234-5678', 'manual', '요약 kim@a.com')`,
      [l.id]
    );
    const t = AGENT_TOOLS.search_meeting_notes;
    if (t.kind !== "read") throw new Error();
    const r = (await t.run({ query: "연락" }, ME)) as { notes: { summary: string }[] };
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0].summary).toBe("요약 [이메일]");
  });
});

describe("Sales Agent 캘린더", () => {
  it("일정 등록: 승인 시 구글 등록 + scheduled_meetings + meeting_scheduled(via: agent)", async () => {
    const l = await lead({ company: "일정상사" });
    const p = await plan("create_calendar_event", { title: "제안 미팅", date: "2026-12-02", startTime: "14:00", leadId: l.id });
    expect(p.changes).toContainEqual({ field: "일시", after: "2026-12-02(수) 14:00~15:00" });
    expect(p.danger).toBeFalsy();

    const r = await decideAction(p.id, ME, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "done", target: { kind: "event" } } });
    expect(google.calls).toEqual([{ op: "insert", eventId: "gev1", title: "제안 미팅", attendees: [] }]);
    const row = (await pool.query("SELECT status, user_id, google_event_id FROM scheduled_meetings WHERE lead_id=$1", [l.id])).rows[0];
    expect(row).toEqual({ status: "scheduled", user_id: ME, google_event_id: "gev1" });
    expect((await events(l.id)).at(-1)).toMatchObject({ type: "meeting_scheduled", changes: { via: "assistant" } });
  });

  it("초대는 요청 시에만: 위험 표시 + 리드 이메일로 초대, 이메일 없으면 계획을 만들지 않는다", async () => {
    const noEmail = await lead({ company: "무메일", email: "" });
    expect(await prepare("create_calendar_event", { title: "미팅", date: "2026-12-03", startTime: "10:00", leadId: noEmail.id, invite: true }))
      .toMatchObject({ error: expect.stringContaining("이메일이 없어") });

    const l = await lead({ company: "초대상사", contact: "박지훈", email: "park@invite.co.kr" });
    const p = await plan("create_calendar_event", { title: "미팅", date: "2026-12-03", startTime: "10:00", leadId: l.id, invite: true });
    expect(p.danger).toBe(true);
    expect(p.notice).toEqual({ tone: "warning", text: "승인하면 리드 담당자(박지훈)에게 구글 캘린더 초대 메일이 발송됩니다" });
    await decideAction(p.id, ME, "approve");
    expect(google.calls[0].attendees).toEqual(["park@invite.co.kr"]);
  });

  it("캘린더 미연동이면 계획을 만들지 않는다", async () => {
    expect(await prepare("create_calendar_event", { title: "미팅", date: "2026-12-03" }, OTHER))
      .toMatchObject({ error: expect.stringContaining("연동되지 않았습니다") });
  });

  it("일정 변경: 날짜만 바꾸면 시간 유지 → 구글 patch + meeting_rescheduled, 다른 사람 일정은 불가", async () => {
    const l = await lead({ company: "변경상사" });
    await decideAction((await plan("create_calendar_event", { title: "미팅", date: "2026-12-02", startTime: "14:00", leadId: l.id })).id, ME, "approve");
    const id = (await pool.query("SELECT id FROM scheduled_meetings WHERE lead_id=$1", [l.id])).rows[0].id;

    expect(await prepare("update_calendar_event", { scheduleId: id, date: "2026-12-04" }, OTHER)).toMatchObject({ error: expect.any(String) });
    const p = await plan("update_calendar_event", { scheduleId: id, date: "2026-12-04" });
    expect(p.changes).toEqual([{ field: "일시", before: "2026-12-02(수) 14:00~15:00", after: "2026-12-04(금) 14:00~15:00" }]);

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done" } });
    expect(google.calls.at(-1)).toMatchObject({ op: "patch", eventId: "gev1", notify: false });
    expect((await events(l.id)).at(-1)).toMatchObject({ type: "meeting_rescheduled", changes: { via: "assistant" } });
  });

  it("여러 날 종일·자정을 넘는 일정: 제목만 바꾸면 기간 유지, 날짜만 바꾸면 같은 길이로 이동", async () => {
    // 12/5~12/7 종일
    await decideAction((await plan("create_calendar_event", { title: "워크숍", date: "2026-12-05" })).id, ME, "approve");
    const multi = (await pool.query("SELECT id FROM scheduled_meetings WHERE title='워크숍'")).rows[0].id;
    await pool.query("UPDATE scheduled_meetings SET ends_at = '2026-12-07T15:00:00Z' WHERE id=$1", [multi]); // 12/8 00:00 KST
    const p1 = await plan("update_calendar_event", { scheduleId: multi, title: "팀 워크숍" });
    expect(p1.changes).toEqual([{ field: "제목", before: "워크숍", after: "팀 워크숍" }]);
    const p2 = await prepare("update_calendar_event", { scheduleId: multi, date: "2026-12-12" });
    if ("error" in p2) throw new Error(p2.error);
    expect(p2.changes).toContainEqual({ field: "일시", before: "2026-12-05(토)~2026-12-07(월) 종일", after: "2026-12-12(토)~2026-12-14(월) 종일" });

    // 22:00~다음 날 01:00
    const night = await plan("create_calendar_event", { title: "야간 점검", date: "2026-12-10", startTime: "22:00", endTime: "01:00" });
    expect(night.changes).toContainEqual({ field: "일시", after: "2026-12-10(목) 22:00~2026-12-11 01:00" });
    await decideAction(night.id, ME, "approve");
    const nightId = (await pool.query("SELECT id FROM scheduled_meetings WHERE title='야간 점검'")).rows[0].id;
    const p3 = await plan("update_calendar_event", { scheduleId: nightId, location: "본사" });
    expect(p3.changes).toEqual([{ field: "장소", before: undefined, after: "본사" }]);
  });

  it("계획 후 일정이 바뀌었으면 실행하지 않고 failed (구글 호출 없음)", async () => {
    await decideAction((await plan("create_calendar_event", { title: "미팅", date: "2026-12-02", startTime: "14:00" })).id, ME, "approve");
    const id = (await pool.query("SELECT id FROM scheduled_meetings")).rows[0].id;
    const p = await plan("cancel_calendar_event", { scheduleId: id });
    expect(p.danger).toBe(true);
    await pool.query("UPDATE scheduled_meetings SET title='다른 제목' WHERE id=$1", [id]);
    const before = google.calls.length;

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "failed", message: expect.stringContaining("일정이 바뀌었습니다") } });
    expect(google.calls).toHaveLength(before);
  });

  it("일정 취소: 구글 삭제 + canceled + meeting_canceled(via: agent)", async () => {
    const l = await lead({ company: "취소상사" });
    await decideAction((await plan("create_calendar_event", { title: "미팅", date: "2026-12-05", leadId: l.id })).id, ME, "approve");
    const id = (await pool.query("SELECT id FROM scheduled_meetings WHERE lead_id=$1", [l.id])).rows[0].id;
    const p = await plan("cancel_calendar_event", { scheduleId: id });
    expect(p.changes[1]).toEqual({ field: "일시", before: "2026-12-05(토) 종일" });

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done" } });
    expect(google.calls.at(-1)).toEqual({ op: "delete", eventId: "gev1", notify: false });
    expect((await pool.query("SELECT status FROM scheduled_meetings WHERE id=$1", [id])).rows[0].status).toBe("canceled");
    expect((await events(l.id)).at(-1)).toMatchObject({ type: "meeting_canceled", changes: { via: "assistant" } });
  });
});
