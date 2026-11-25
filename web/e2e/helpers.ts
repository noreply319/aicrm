import type { APIRequestContext, Page } from "@playwright/test";
import pg from "pg";
import { assertSafeTestDb, TEST_DATABASE_URL } from "../test/setup/config";

/** 각 테스트 전에 테스트 DB를 비운다 */
export async function resetDb() {
  assertSafeTestDb(TEST_DATABASE_URL);
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("TRUNCATE agent_actions, document_sends, documents, document_templates, meeting_notes, lead_events, leads, contacts, companies RESTART IDENTITY CASCADE");
  } finally {
    await c.end();
  }
}

export async function createLead(request: APIRequestContext, company: string, stage = "new") {
  const res = await request.post("/api/leads", { data: { company, contact: "김민수", value: 30_000_000, stage } });
  return (await res.json()) as { id: string; company: string };
}

/**
 * 가짜 마이크: 실제 마이크 대신 사인파 소리를 내는 스트림으로 getUserMedia를 바꾼다.
 * (전사는 page.route로 가짜 응답을 주므로 소리 내용은 상관없다)
 */
export async function fakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
  });
}

/** 화자 구분 전사 API 가짜 응답 */
export async function fakeTranscribe(page: Page) {
  await page.route("**/api/meetings/transcribe", (route) =>
    route.fulfill({
      json: {
        text: "안녕하세요 네 반갑습니다",
        utterances: [
          { speaker: "A", start: 0, end: 2.5, text: "안녕하세요, 견적 관련 미팅입니다." },
          { speaker: "B", start: 2.6, end: 3, text: "네 반갑습니다." },
        ],
      },
    })
  );
}

/**
 * 노트 저장 후 AI 요청 가짜 응답 (서버가 OpenAI를 부르지 않도록 브라우저에서 가로챔)
 *  - 자동 요약: 저장된 노트를 읽어 요약·다음 액션만 채워 돌려준다
 *  - 다음 미팅 추출: 일정 없음
 */
export const FAKE_SUMMARY = "견적 관련 첫 미팅. 고객이 도입 일정을 문의함.";
export async function fakeNoteAi(page: Page) {
  await page.route("**/api/meetings/*/summarize", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    const note = await (await page.request.get(`/api/meetings/${id}`)).json();
    await route.fulfill({ json: { ...note, summary: FAKE_SUMMARY, nextActions: "- 견적서 발송" } });
  });
  await page.route("**/api/meetings/*/schedule-candidates", (route) =>
    route.fulfill({ json: { registered: [], candidates: [] } })
  );
}

/** 리드 모달: 담당자 콤보박스에서 이름으로 새 연락처를 만들어 선택한다 */
export async function createContactInLead(page: Page, name: string, fields: { title?: string; email?: string } = {}) {
  const combo = page.getByRole("combobox", { name: "담당자" });
  await combo.fill(name);
  await page.getByRole("option", { name: new RegExp(`"${name}" 새 연락처로 만들기`) }).click();
  if (fields.title) await page.getByLabel("새 연락처 직함").fill(fields.title);
  if (fields.email) await page.getByLabel("새 연락처 이메일").fill(fields.email);
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await page.getByTestId("contact-chip").filter({ hasText: name }).waitFor();
}

export async function createContact(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/contacts", { data });
  return (await res.json()) as { id: string; name: string };
}

export async function createCompany(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/companies", { data });
  return (await res.json()) as { id: string; name: string };
}

/**
 * 개발 서버의 Next.js 개발 도구 버튼(왼쪽 아래 "N")을 숨긴다.
 * 모바일 화면 왼쪽 아래 버튼·메뉴를 가려 클릭이 막힐 수 있어 모바일 테스트에서 사용 (운영 빌드에는 없음).
 */
export async function hideDevIndicator(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important; }";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
  });
}

/**
 * Sales Agent 실행 계획을 테스트 DB에 직접 만든다 (OpenAI 없이 승인 흐름 확인용).
 * 테스트 사용자(global-setup) 소유의 "리드 단계 이동" 계획을 저장하고 화면에 보낼 plan을 돌려준다.
 */
export async function createMovePlan(lead: { id: string; company: string }, from: string, to: string) {
  assertSafeTestDb(TEST_DATABASE_URL);
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    const plan = {
      title: "리드 단계 이동",
      changes: [{ field: "단계", before: from === "qualified" ? "니즈 확인" : from, after: to === "negotiation" ? "협상" : to }],
      target: { kind: "lead", id: lead.id, label: lead.company },
      affectsLeads: true,
    };
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO agent_actions (user_id, tool, args, plan)
       SELECT id, 'move_lead_stage', $1, $2 FROM users WHERE google_sub = 'e2e-test-user' RETURNING id`,
      [JSON.stringify({ leadId: lead.id, stage: to, expect: { stage: from } }), JSON.stringify(plan)]
    );
    return { id: rows[0].id, ...plan, status: "pending" as const };
  } finally {
    await c.end();
  }
}
