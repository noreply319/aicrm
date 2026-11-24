import { pool } from "@/lib/db";
import type { Lead, MeetingNote } from "@/lib/types";

/** 테스트 사이 데이터 초기화 */
export async function resetDb() {
  await pool.query("TRUNCATE document_sends, documents, document_templates, meeting_notes, lead_events, leads, contacts, companies RESTART IDENTITY CASCADE");
}

export async function closeDb() {
  await pool.end();
}

/** Route Handler 호출용 Request */
export function req(method: string, body?: unknown, url = "http://test.local/api") {
  return new Request(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 동적 라우트 컨텍스트 ({ params: Promise }) */
export const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

export async function events(leadId?: string) {
  const { rows } = await pool.query<{ type: string; changes: Record<string, unknown> }>(
    `SELECT type, changes FROM lead_events ${leadId ? "WHERE lead_id = $1" : ""} ORDER BY id`,
    leadId ? [leadId] : []
  );
  return rows;
}

export const leadInput = (over: Partial<Lead> = {}) => ({
  company: "테스트상사",
  contact: "홍길동",
  title: "팀장",
  email: "hong@test.com",
  phone: "010-1234-5678",
  value: 1_000_000,
  closeDate: "2026-12-31",
  stage: "new",
  priority: "mid",
  notes: "",
  ...over,
});

export const noteInput = (over: Partial<MeetingNote> = {}) => ({
  leadId: null as string | null,
  title: "테스트 미팅",
  metAt: "2026-11-24T05:00:00.000Z",
  body: "[00:00~05:00]\n화자 1: 견적 요청드립니다.",
  source: "recording",
  summary: "",
  nextActions: "",
  ...over,
});
