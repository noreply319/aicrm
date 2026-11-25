import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Gmail 발송은 가짜 (발송 한도 확인용)
const gmail = vi.hoisted(() => ({ sent: 0 }));
vi.mock("@/lib/gmail", async (orig) => ({
  ...(await orig<typeof import("@/lib/gmail")>()),
  sendRawMessage: async () => ({ id: `msg${++gmail.sent}`, threadId: "thr" }),
}));

import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { decideAction, savePlan } from "@/lib/agent";
import { AGENT_LIMITS, planQuotaError, redactOldActions, requestLimitError } from "@/lib/agentLimits";
import type { PreparedPlan } from "@/lib/agentToolKit";
import { AGENT_TOOLS } from "@/lib/agentTools";
import { pool } from "@/lib/db";
import type { Lead } from "@/lib/types";
import { closeDb, leadInput, req, resetDb } from "./helpers";

const ME = "00000000-0000-4000-8000-0000000000e1";

beforeEach(async () => {
  await resetDb();
  await pool.query(
    `INSERT INTO users (id, google_sub, email, name, google_refresh_token, gmail_enabled, google_scopes)
     VALUES ($1, 'limit-me', 'me@nomargin.kr', '홍길동', 'enc', true, 'https://www.googleapis.com/auth/gmail.send')
     ON CONFLICT (id) DO NOTHING`,
    [ME]
  );
  gmail.sent = 0;
});
afterAll(closeDb);

const lead = async (over = {}) => (await (await CREATE_LEAD(req("POST", leadInput(over)))).json()) as Lead;
async function plan(tool: string, args: Record<string, unknown>) {
  const t = AGENT_TOOLS[tool];
  if (t.kind !== "write") throw new Error("write tool only");
  const p = await t.prepare(args, ME);
  if ("error" in p) throw new Error(p.error);
  return savePlan(ME, tool, p as PreparedPlan);
}

describe("Sales Agent 사용량 제한", () => {
  it("1분 요청 수가 한도를 넘으면 안내 문구", async () => {
    for (let i = 0; i < AGENT_LIMITS.requestsPerMinute; i++) expect(await requestLimitError(ME)).toBeNull();
    expect(await requestLimitError(ME)).toContain("요청이 너무 많습니다");
    await pool.query("UPDATE agent_requests SET created_at = now() - interval '2 minutes'");
    expect(await requestLimitError(ME)).toBeNull();
  });

  it("요청당 계획 수·승인 대기 수 한도", async () => {
    expect(await planQuotaError(ME, AGENT_LIMITS.plansPerRequest)).toContain(`${AGENT_LIMITS.plansPerRequest}개까지`);
    const l = await lead({ stage: "new" });
    for (let i = 0; i < AGENT_LIMITS.pendingPlans; i++) await plan("update_lead", { leadId: l.id, value: 1000 + i });
    expect(await planQuotaError(ME, 0)).toContain("승인 대기 중인 계획");
  });

  it("발송 한도에 닿으면 승인 429, 계획은 승인 대기로 남는다", async () => {
    const l = await lead({ email: "kim@limit.co.kr" });
    // 한도만큼 이미 발송한 것으로 기록
    for (let i = 0; i < AGENT_LIMITS.sendsPerHour; i++) {
      await pool.query(
        `INSERT INTO agent_actions (user_id, tool, args, plan, status, executed_at) VALUES ($1, 'send_email', '{}', '{"title":"메일 발송","changes":[]}', 'done', now())`,
        [ME]
      );
    }
    const p = await plan("send_email", { leadId: l.id, subject: "제목", body: "본문" });
    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: false, status: 429 });
    expect((await pool.query("SELECT status FROM agent_actions WHERE id=$1", [p.id])).rows[0].status).toBe("pending");
    expect(gmail.sent).toBe(0);
  });
});

describe("Sales Agent 감사 기록", () => {
  it("실행하면 executed_at·result(대상) 기록", async () => {
    const l = await lead({ stage: "new" });
    const p = await plan("move_lead_stage", { leadId: l.id, stage: "contacted" });
    await decideAction(p.id, ME, "approve");
    const row = (await pool.query("SELECT executed_at, result FROM agent_actions WHERE id=$1", [p.id])).rows[0];
    expect(row.executed_at).not.toBeNull();
    expect(row.result).toMatchObject({ ok: true, target: { kind: "lead", id: l.id } });
  });

  it("90일 지난 계획은 args·카드 전/후를 지우고 제목·대상·결과는 남긴다", async () => {
    const l = await lead({ email: "kim@old.co.kr" });
    const p = await plan("send_email", { leadId: l.id, subject: "오래된 메일", body: "본문" });
    await pool.query("UPDATE agent_actions SET created_at = now() - interval '91 days', message = '결과' WHERE id=$1", [p.id]);
    expect(await redactOldActions()).toBe(1);
    const row = (await pool.query("SELECT args, plan, message, redacted_at FROM agent_actions WHERE id=$1", [p.id])).rows[0];
    expect(row.args).toEqual({});
    expect(row.plan).toEqual({ title: "메일 발송", changes: [] }); // send_email 카드에는 대상(target)이 없다
    expect(JSON.stringify(row)).not.toContain("kim@old.co.kr");
    expect(row.message).toBe("결과");
    expect(row.redacted_at).not.toBeNull();
  });
});
