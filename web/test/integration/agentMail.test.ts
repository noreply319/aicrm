import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Gmail 발송은 가짜로 대체 (구글 호출 없음)
const gmail = vi.hoisted(() => ({ sent: [] as string[], fail: false }));
vi.mock("@/lib/gmail", async (orig) => ({
  ...(await orig<typeof import("@/lib/gmail")>()),
  sendRawMessage: async (_u: unknown, raw: string) => {
    if (gmail.fail) {
      const { GoogleError } = await import("@/lib/google");
      throw new GoogleError("Gmail 발송 실패", 502);
    }
    gmail.sent.push(raw);
    return { id: `msg${gmail.sent.length}`, threadId: "thr" };
  },
}));

import { POST as CREATE_COMPANY } from "@/app/api/companies/route";
import { POST as CREATE_CONTACT } from "@/app/api/contacts/route";
import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { POST as LOAD_DEFAULTS } from "@/app/api/templates/defaults/route";
import { decideAction, savePlan } from "@/lib/agent";
import type { PreparedPlan } from "@/lib/agentToolKit";
import { AGENT_TOOLS } from "@/lib/agentTools";
import { pool } from "@/lib/db";
import type { Company, Contact, Lead } from "@/lib/types";
import { closeDb, events, leadInput, req, resetDb } from "./helpers";

const ME = "00000000-0000-4000-8000-0000000000d1";
const NO_SEND = "00000000-0000-4000-8000-0000000000d2";
const SCOPES = "openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

beforeEach(async () => {
  await resetDb();
  await pool.query(
    `INSERT INTO users (id, google_sub, email, name, google_refresh_token, gmail_enabled, google_scopes) VALUES
       ($1, 'mail-me', 'me@nomargin.kr', '홍길동', 'enc', true, $3), ($2, 'mail-nosend', 'no@nomargin.kr', '읽기만', 'enc', true, 'openid')
     ON CONFLICT (id) DO UPDATE SET google_refresh_token = EXCLUDED.google_refresh_token, gmail_enabled = true,
       google_scopes = EXCLUDED.google_scopes, calendar_expired = false`,
    [ME, NO_SEND, SCOPES]
  );
  gmail.sent = [];
  gmail.fail = false;
});
afterAll(closeDb);

const json = async <T>(r: Response) => (await r.json()) as T;
const company = async (name: string, emailDomain?: string) => json<Company>(await CREATE_COMPANY(req("POST", { name, emailDomain })));
const contact = async (body: Record<string, unknown>) => json<Contact>(await CREATE_CONTACT(req("POST", body)));
const lead = async (over = {}) => json<Lead>(await CREATE_LEAD(req("POST", leadInput(over))));
const quoteTemplate = async () => {
  await LOAD_DEFAULTS();
  return (await pool.query<{ id: string }>("SELECT id FROM document_templates WHERE kind = 'quote' LIMIT 1")).rows[0].id;
};

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

const ITEMS = [{ name: "CRM 라이선스", qty: 10, unitPrice: 50_000 }, { name: "초기 세팅", spec: "1식", qty: 1, unitPrice: 1_500_000 }];

describe("Sales Agent 견적서·계약서", () => {
  it("견적서 작성: 리드에서 회사·담당자 채움 + 품목·합계 카드 → 승인 시 완성 문서", async () => {
    const l = await lead({ company: "에이스상사", contact: "김민수", email: "kim@ace.co.kr", stage: "qualified" });
    const templateId = await quoteTemplate();
    const p = await plan("create_document", { templateId, leadId: l.id, values: { 유효기간: "30일" }, lineItems: ITEMS });
    expect(p.changes).toContainEqual({ field: "합계", after: "₩2,200,000 (공급가액 ₩2,000,000 + 부가세 ₩200,000)" });
    expect(p.notice?.tone).toBe("info");

    const r = await decideAction(p.id, ME, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "done", message: "견적서를 완성했습니다", target: { kind: "document" } } });
    const doc = (await pool.query("SELECT status, lead_id, field_values, line_items FROM documents")).rows[0];
    expect(doc).toMatchObject({ status: "completed", lead_id: l.id, field_values: { 회사명: "에이스상사", 담당자: "김민수", 유효기간: "30일" } });
    expect(doc.line_items).toHaveLength(2);
  });

  it("필수 항목이 비면 초안으로 저장한다고 카드에 알리고 초안으로 저장", async () => {
    const l = await lead({ company: "초안상사" });
    const p = await plan("create_document", { templateId: await quoteTemplate(), leadId: l.id, lineItems: ITEMS });
    expect(p.notice).toMatchObject({ tone: "warning", text: expect.stringContaining("유효기간") });
    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { message: expect.stringContaining("초안") } });
    expect((await pool.query("SELECT status FROM documents")).rows[0].status).toBe("draft");
  });

  it("문서 발송: 받는 사람은 서버가 리드에서 → 승인 시 Gmail 발송 + document_sends + document_sent + 단계 이동 카드", async () => {
    const co = await company("에이스상사", "ace.co.kr");
    const boss = await contact({ name: "이부장", companyId: co.id, email: "boss@ace.co.kr" });
    const l = await lead({ companyId: co.id, company: "", contact: "김민수", email: "kim@ace.co.kr", stage: "qualified" });
    const created = await plan("create_document", { templateId: await quoteTemplate(), leadId: l.id, values: { 유효기간: "30일" }, lineItems: ITEMS });
    await decideAction(created.id, ME, "approve");
    const docId = (await pool.query("SELECT id FROM documents")).rows[0].id;

    const p = await plan("send_document", { documentId: docId, ccContactIds: [boss.id] });
    expect(p).toMatchObject({ danger: true, approveLabel: "발송 승인" });
    expect(p.changes).toContainEqual({ field: "받는 사람", after: "김민수 <kim@ace.co.kr>" });
    expect(p.changes).toContainEqual({ field: "참조", after: "이부장 <boss@ace.co.kr>" });

    const r = await decideAction(p.id, ME, "approve");
    expect(r).toMatchObject({ ok: true, plan: { status: "done" } });
    if (!r.ok) throw new Error();
    expect(r.followUps).toHaveLength(1);
    expect(r.followUps?.[0]).toMatchObject({ status: "pending", title: "리드 단계 이동", changes: [{ after: "제안/견적" }] });

    expect(gmail.sent).toHaveLength(1);
    expect(gmail.sent[0]).toContain("To: kim@ace.co.kr");
    expect(gmail.sent[0]).toContain("Cc: boss@ace.co.kr");
    expect(gmail.sent[0]).toContain("application/pdf");
    expect((await pool.query("SELECT status FROM documents WHERE id=$1", [docId])).rows[0].status).toBe("sent");
    expect((await pool.query("SELECT to_addrs, cc_addrs FROM document_sends")).rows[0]).toEqual({ to_addrs: ["kim@ace.co.kr"], cc_addrs: ["boss@ace.co.kr"] });
    const ev = (await events(l.id)).find((e) => e.type === "document_sent");
    expect(ev?.changes).toMatchObject({ recipients: 2, via: "agent" });
    expect(JSON.stringify(ev?.changes)).not.toContain("@"); // 이력에 주소 없음

    // 이미 보낸 문서는 다시 계획을 만들지 않는다
    expect(await prepare("send_document", { documentId: docId })).toMatchObject({ error: expect.stringContaining("이미 발송") });
  });

  it("다른 회사 연락처는 참조할 수 없고, 발송 권한이 없으면 계획을 만들지 않는다", async () => {
    const other = await company("다른회사");
    const stranger = await contact({ name: "외부인", companyId: other.id, email: "x@other.com" });
    const co = await company("우리고객");
    const l = await lead({ companyId: co.id, company: "", email: "kim@client.co.kr" });
    expect(await prepare("send_email", { leadId: l.id, subject: "안녕하세요", body: "본문", ccContactIds: [stranger.id] }))
      .toMatchObject({ error: expect.stringContaining("소속 연락처가 아니라") });
    expect(await prepare("send_email", { leadId: l.id, subject: "안녕하세요", body: "본문" }, NO_SEND))
      .toMatchObject({ error: expect.stringContaining("발송 권한") });
  });
});

describe("Sales Agent 일반 메일", () => {
  it("메일 발송: 승인 시 첨부 없는 메일 + email_sent(주소 없이)", async () => {
    const l = await lead({ company: "메일상사", contact: "박지훈", email: "park@mail.co.kr" });
    const p = await plan("send_email", { leadId: l.id, subject: "미팅 감사드립니다", body: "어제 미팅 감사합니다.\n홍길동 드림" });
    expect(p.changes).toEqual([
      { field: "받는 사람", after: "박지훈 <park@mail.co.kr>" },
      { field: "제목", after: "미팅 감사드립니다" },
      { field: "본문", after: "어제 미팅 감사합니다.\n홍길동 드림" },
    ]);

    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "done" } });
    expect(gmail.sent[0]).toContain("Content-Type: text/plain");
    expect(gmail.sent[0]).not.toContain("multipart");
    const ev = (await events(l.id)).at(-1);
    expect(ev).toMatchObject({ type: "email_sent", changes: { subject: "미팅 감사드립니다", recipients: 1, via: "agent" } });
  });

  it("Gmail 실패면 failed, 다시 승인해도 409 (두 번 보내지 않음)", async () => {
    const l = await lead({ email: "kim@fail.co.kr" });
    const p = await plan("send_email", { leadId: l.id, subject: "제목", body: "본문" });
    gmail.fail = true;
    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "failed", message: expect.stringContaining("보내지 못했습니다") } });
    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: false, status: 409 });
  });

  it("계획 후 담당자 주소가 바뀌면 발송하지 않는다", async () => {
    const l = await lead({ email: "old@co.kr" });
    const p = await plan("send_email", { leadId: l.id, subject: "제목", body: "본문" });
    await pool.query("UPDATE leads SET email='new@co.kr' WHERE id=$1", [l.id]);
    expect(await decideAction(p.id, ME, "approve")).toMatchObject({ ok: true, plan: { status: "failed", message: expect.stringContaining("주소가 바뀌었습니다") } });
    expect(gmail.sent).toHaveLength(0);
  });

  it("초안은 저장하지 않는 초안 카드 (draft)", async () => {
    const l = await lead({ email: "kim@draft.co.kr" });
    const p = await prepare("draft_email", { leadId: l.id, subject: "제목", body: "본문" });
    expect(p).toMatchObject({ draft: true, title: "메일 초안" });
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_actions")).rows[0].n).toBe(0);
  });
});
