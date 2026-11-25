import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { runAgent } from "@/lib/agent";
import { findUserById } from "@/lib/auth";
import { pool } from "@/lib/db";
import type { ChatMessage, Lead } from "@/lib/types";
import { closeDb, leadInput, req, resetDb } from "./helpers";

/** AI 컨텍스트: 질문·최근 대화에 나온 리드는 오래된 이력까지, 나머지는 최근 기간만 */

const ME = "00000000-0000-4000-8000-0000000000c9";

beforeEach(async () => {
  await resetDb();
  process.env.OPENAI_API_KEY = "test-key";
  await pool.query(
    `INSERT INTO users (id, google_sub, email, name) VALUES ($1, 'ctx-me', 'ctx@test.local', '김영업') ON CONFLICT (id) DO NOTHING`,
    [ME]
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

const lead = async (over = {}) => (await (await CREATE_LEAD(req("POST", leadInput(over)))).json()) as Lead;

/** 오래된 이력 한 건 (days일 전) */
async function oldEvent(l: Lead, days: number, marker: string) {
  await pool.query(
    `INSERT INTO lead_events (lead_id, company, type, changes, created_at) VALUES ($1, $2, 'updated', $3, now() - make_interval(days => $4))`,
    [l.id, l.company, JSON.stringify({ notes: { from: "", to: marker } }), days]
  );
}

/** 시스템 프롬프트(컨텍스트 포함)를 받아 온다 */
async function systemPrompt(messages: ChatMessage[]) {
  const bodies: { messages: { content: string }[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }));
  const user = await findUserById(ME);
  await runAgent(messages, user!, () => {}, "assistant");
  return bodies[0].messages[0].content;
}

describe("AI Assistant 컨텍스트", () => {
  it("질문에 나온 회사((주)·공백 무시)의 오래된 이력은 넣고, 다른 리드의 오래된 이력은 뺀다", async () => {
    const ns = await lead({ company: "(주)엔에스 컴퍼니" });
    const other = await lead({ company: "옛날상사" });
    await oldEvent(ns, 200, "엔에스-오래된-메모");
    await oldEvent(other, 200, "옛날상사-오래된-메모");
    await oldEvent(other, 5, "옛날상사-최근-메모");

    const prompt = await systemPrompt([{ role: "user", content: "엔에스컴퍼니 이력 알려줘" }]);
    expect(prompt).toContain("엔에스-오래된-메모");
    expect(prompt).not.toContain("옛날상사-오래된-메모");
    expect(prompt).toContain("옛날상사-최근-메모"); // 최근 기간 이력은 그대로
  });

  it("이어지는 질문(\"그 회사\")도 최근 대화에 나온 회사의 기록을 넣는다", async () => {
    const ns = await lead({ company: "(주)엔에스 컴퍼니" });
    await oldEvent(ns, 200, "엔에스-오래된-메모");
    const prompt = await systemPrompt([
      { role: "user", content: "엔에스 컴퍼니 단계는?" },
      { role: "assistant", content: "제안/견적 단계입니다" },
      { role: "user", content: "그 회사 예전 메모는?" },
    ]);
    expect(prompt).toContain("엔에스-오래된-메모");
  });
});
