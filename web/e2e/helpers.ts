import type { APIRequestContext, Page } from "@playwright/test";
import pg from "pg";
import { assertSafeTestDb, TEST_DATABASE_URL } from "../test/setup/config";

/** 각 테스트 전에 테스트 DB를 비운다 */
export async function resetDb() {
  assertSafeTestDb(TEST_DATABASE_URL);
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("TRUNCATE document_sends, documents, document_templates, meeting_notes, lead_events, leads, companies RESTART IDENTITY CASCADE");
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

export async function createCompany(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/companies", { data });
  return (await res.json()) as { id: string; name: string };
}
