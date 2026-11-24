import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 로그인 사용자·Gmail 발송은 가짜로 대체 (구글 호출 없음)
const fakeUser = {
  id: "00000000-0000-4000-8000-0000000000aa", email: "me@nomargin.kr", name: "홍길동", picture: "",
  refreshToken: "enc", calendarExpired: false, calendarEnabled: false, gmailEnabled: true, calendarId: "primary",
  googleSub: "sub", googleScopes: "openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
};
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  getSessionUser: async () => auth.user,
}));
const gmail = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("@/lib/gmail", async (orig) => ({
  ...(await orig<typeof import("@/lib/gmail")>()),
  sendRawMessage: async (_u: unknown, raw: string) => {
    gmail.sent.push(raw);
    return { id: "msg1", threadId: "thr1" };
  },
}));

import { POST as CREATE_LEAD } from "@/app/api/leads/route";
import { GET as LIST_TEMPLATES, POST as CREATE_TEMPLATE } from "@/app/api/templates/route";
import { POST as LOAD_DEFAULTS } from "@/app/api/templates/defaults/route";
import { GET as LIST_DOCS, POST as CREATE_DOC } from "@/app/api/documents/route";
import { DELETE as DELETE_DOC, PATCH as PATCH_DOC } from "@/app/api/documents/[id]/route";
import { POST as CHAT } from "@/app/api/documents/[id]/chat/route";
import { GET as PDF } from "@/app/api/documents/[id]/pdf/route";
import { GET as DRAFT } from "@/app/api/documents/[id]/email-draft/route";
import { POST as SEND } from "@/app/api/documents/[id]/send/route";
import { pool } from "@/lib/db";
import type { DocChatResult, DocEmailDraft, DocTemplate, DocumentRecord, Lead } from "@/lib/types";
import { closeDb, ctx, events, leadInput, req, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  await pool.query(
    `INSERT INTO users (id, google_sub, email, name) VALUES ($1, 'doc-test-sub', $2, $3) ON CONFLICT (id) DO NOTHING`,
    [fakeUser.id, fakeUser.email, fakeUser.name]
  );
  auth.user = fakeUser;
  gmail.sent = [];
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

const json = async <T,>(r: Response) => (await r.json()) as T;
const newLead = async (over: Partial<Lead> = {}) =>
  json<Lead>(await CREATE_LEAD(req("POST", leadInput({ company: "에이스상사", contact: "김민수", email: "kim@ace.co.kr", phone: "010-1111-2222", value: 12_000_000, stage: "qualified", ...over }))));
const defaults = async () => {
  await LOAD_DEFAULTS();
  const list = await json<DocTemplate[]>(await LIST_TEMPLATES(req("GET", undefined, "http://test.local/api/templates")));
  return { contract: list.find((t) => t.kind === "contract")!, quote: list.find((t) => t.kind === "quote")! };
};
const newDoc = async (templateId: string) => json<DocumentRecord>(await CREATE_DOC(req("POST", { templateId })));
const chat = async (id: string, body: Record<string, string>) => {
  const res = await CHAT(req("POST", body), ctx(id));
  expect(res.status).toBe(200);
  return (await json<DocChatResult>(res)).document;
};
const lastAssistant = (d: DocumentRecord) => d.messages.filter((m) => m.role === "assistant").at(-1)!;

/** OpenAI 가짜 응답 (요청 본문 기록) */
function fakeOpenAi(content: unknown) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  }));
  return calls;
}

describe("템플릿", () => {
  it("기본 템플릿은 한 번만 추가된다", async () => {
    expect((await json<DocTemplate[]>(await LOAD_DEFAULTS())).length).toBe(2);
    expect((await json<DocTemplate[]>(await LOAD_DEFAULTS())).length).toBe(0);
  });

  it("본문의 {{항목}}으로 항목을 정리하고, 선택지 보기가 없으면 400", async () => {
    const base = { kind: "contract", name: "NDA", description: "", body: "{{회사명}} {{문서번호}} {{계약일}}", emailSubject: "{{회사명}}", emailBody: "", lineItems: null };
    const ok = await CREATE_TEMPLATE(req("POST", { ...base, fields: [{ key: "없어진 항목" }] }));
    expect(ok.status).toBe(201);
    expect((await json<DocTemplate>(ok)).fields.map((f) => f.key)).toEqual(["회사명", "계약일"]);

    const bad = await CREATE_TEMPLATE(req("POST", { ...base, fields: [{ key: "회사명", type: "choice", options: [] }] }));
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toContain("선택지");
  });
});

describe("계약서 작성 대화", () => {
  it("리드 선택 → 자동 채움 → 하나씩 질문 → 종료일 자동 계산 → 빈칸 확인 → 완성 (AI 호출 없음)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const lead = await newLead();
    const { contract } = await defaults();

    let d = await newDoc(contract.id);
    expect(d.docNumber).toMatch(/^C-\d{4}-0001$/);
    expect(d.step).toEqual({ type: "lead" });
    expect(lastAssistant(d).quick?.some((q) => q.action === "select_lead" && q.value === lead.id)).toBe(true);
    expect((await newDoc(contract.id)).docNumber).toMatch(/-0002$/);

    d = await chat(d.id, { action: "select_lead", value: lead.id });
    expect(d.leadId).toBe(lead.id);
    expect(d.values).toMatchObject({ 회사명: "에이스상사", 담당자: "김민수", "담당자 이메일": "kim@ace.co.kr", "이용 요금": "12000000" });
    expect(d.step).toEqual({ type: "field", key: "서비스명" });
    expect(lastAssistant(d).quick?.map((q) => q.label)).toEqual(["Pipeline CRM", "Pipeline CRM Pro"]);

    d = await chat(d.id, { action: "answer", value: "Pipeline CRM" });
    expect(d.step).toEqual({ type: "field", key: "계약 시작일" });
    d = await chat(d.id, { message: "2026-12-01부터" });
    d = await chat(d.id, { message: "1년" });
    expect(d.values["계약 종료일"]).toBe("2027-11-30");
    expect(d.step).toEqual({ type: "field", key: "결제 방식" }); // 종료일은 계산돼서 묻지 않음
    d = await chat(d.id, { message: "연 일시불로요" });
    expect(d.values["결제 방식"]).toBe("연 일시불");

    d = await chat(d.id, { message: "완료" });
    expect(d.step).toMatchObject({ type: "confirm_complete", missing: ["고객 대표자", "계약일"] });
    d = await chat(d.id, { action: "complete_blank" });
    expect(d.status).toBe("completed");
    expect(lastAssistant(d).kind).toBe("result");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("규칙으로 못 읽는 수정 요청은 AI로 해석하되, 이메일·전화번호·다른 값은 보내지 않는다", async () => {
    const lead = await newLead();
    const { contract } = await defaults();
    let d = await newDoc(contract.id);
    d = await chat(d.id, { action: "select_lead", value: lead.id });

    const calls = fakeOpenAi({ intent: "edit", updates: [{ key: "이용 요금", value: "11000000" }, { key: "담당자 이메일", value: "x@evil.com" }] });
    d = await chat(d.id, { message: "아 금액은 1,100만원으로 바꿔줘 연락은 010-9999-8888" });
    expect(d.values["이용 요금"]).toBe("11000000");
    expect(d.values["담당자 이메일"]).toBe("kim@ace.co.kr"); // AI는 이메일 항목을 바꿀 수 없다
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("kim@ace.co.kr");
    expect(calls[0]).not.toContain("010-9999-8888");
    expect(calls[0]).not.toContain("에이스상사");
    expect(calls[0]).not.toContain("담당자 이메일");
    expect(d.step).toEqual({ type: "field", key: "서비스명" }); // 수정 후 원래 질문으로
  });

  it("직접 수정: 형식이 틀리면 400, 맞으면 반영하고 지금 묻던 항목이면 다음 질문으로", async () => {
    const { contract } = await defaults();
    let d = await newDoc(contract.id);
    d = await chat(d.id, { action: "no_lead" });
    expect(d.step).toEqual({ type: "field", key: "회사명" });
    expect((await PATCH_DOC(req("PATCH", { values: { 계약일: "아무 때나" } }), ctx(d.id))).status).toBe(400);
    const r = await json<DocChatResult>(await PATCH_DOC(req("PATCH", { values: { 회사명: "블루웨이브" } }), ctx(d.id)));
    expect(r.changed).toEqual(["회사명"]);
    expect(r.document.step).toEqual({ type: "field", key: "서비스명" });
  });
});

describe("견적서", () => {
  it("품목 문장 → 행 추가, 합계 계산, 품목 없이 완료 불가", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { quote } = await defaults();
    let d = await newDoc(quote.id);
    d = await chat(d.id, { action: "no_lead" });
    expect(d.step).toEqual({ type: "items" });
    d = await chat(d.id, { action: "items_done" });
    expect(d.step).toEqual({ type: "items" });

    d = await chat(d.id, { message: "CRM 라이선스 20개 단가 60만원" });
    d = await chat(d.id, { message: "초기 세팅 1식 150만원" });
    expect(d.lineItems).toEqual([
      { name: "CRM 라이선스", spec: "", qty: 20, unitPrice: 600_000 },
      { name: "초기 세팅", spec: "1식", qty: 1, unitPrice: 1_500_000 },
    ]);
    expect(lastAssistant(d).text).toContain("더 추가할 품목");
    expect(d.messages.some((m) => m.text.includes("합계 14,850,000원"))).toBe(true);
    d = await chat(d.id, { message: "끝" });
    expect(d.step).toEqual({ type: "field", key: "회사명" });
  });
});

describe("PDF · 메일 발송", () => {
  async function completedDoc() {
    const lead = await newLead();
    const { contract } = await defaults();
    let d = await newDoc(contract.id);
    d = await chat(d.id, { action: "select_lead", value: lead.id });
    d = await chat(d.id, { action: "complete" });
    d = await chat(d.id, { action: "complete_blank" });
    return { d, lead };
  }

  it("PDF 다운로드", async () => {
    const { d } = await completedDoc();
    const res = await PDF(req("GET", undefined, "http://test.local/api"), ctx(d.id));
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(encodeURIComponent("계약서_에이스상사_"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("메일 기본값: 받는 사람 = 리드 이메일, 제목·본문에 값 채움", async () => {
    const { d } = await completedDoc();
    const draft = await json<DocEmailDraft>(await DRAFT(req("GET"), ctx(d.id)));
    expect(draft).toMatchObject({ from: "me@nomargin.kr", to: ["kim@ace.co.kr"], subject: "[에이스상사] SaaS 서비스 이용 계약서 송부드립니다" });
    expect(draft.body).toContain("김민수 님, 안녕하세요.");
    expect(draft.fileName).toMatch(/^계약서_에이스상사_\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(draft.size).toBeGreaterThan(10_000);
  });

  it("발송 → 기록·상태·리드 이력(주소 없이) → 단계 이동 제안 → 이동", async () => {
    const { d, lead } = await completedDoc();
    const res = await SEND(req("POST", { to: ["kim@ace.co.kr"], cc: "boss@ace.co.kr", subject: "계약서 송부", body: "첨부합니다", fileName: "계약서.pdf" }), ctx(d.id));
    expect(res.status).toBe(200);
    const sent = (await json<DocChatResult>(res)).document;
    expect(sent.status).toBe("sent");
    expect(sent.sendCount).toBe(1);
    expect(gmail.sent[0]).toContain("To: kim@ace.co.kr");
    expect(gmail.sent[0]).toContain("Cc: boss@ace.co.kr");

    const ev = (await events(lead.id)).filter((e) => e.type === "document_sent");
    expect(ev).toHaveLength(1);
    expect(ev[0].changes).toMatchObject({ kind: "contract", docNumber: d.docNumber, recipients: 2 });
    expect(JSON.stringify(ev[0].changes)).not.toContain("@");

    const suggest = lastAssistant(sent);
    expect(suggest.quick?.[0]).toMatchObject({ action: "move_stage", value: "negotiation" });
    const moved = await CHAT(req("POST", { action: "move_stage", value: "negotiation" }), ctx(d.id));
    expect((await json<DocChatResult>(moved)).leadChanged).toBe(true);
    expect((await pool.query("SELECT stage FROM leads WHERE id = $1", [lead.id])).rows[0].stage).toBe("negotiation");
    expect((await events(lead.id)).at(-1)?.type).toBe("moved");

    // 발송한 문서는 수정·삭제 불가
    expect((await PATCH_DOC(req("PATCH", { values: { 회사명: "x" } }), ctx(d.id))).status).toBe(409);
    expect((await DELETE_DOC(req("DELETE"), ctx(d.id))).status).toBe(409);
    const list = await json<{ status: string }[]>(await LIST_DOCS(req("GET", undefined, "http://test.local/api/documents?status=sent")));
    expect(list).toHaveLength(1);
  });

  it("완성 전·발송 권한 없음·주소 오류는 발송하지 않는다", async () => {
    const { contract } = await defaults();
    const draft = await newDoc(contract.id);
    const body = { to: ["kim@ace.co.kr"], subject: "s", body: "b", fileName: "a.pdf" };
    expect((await SEND(req("POST", body), ctx(draft.id))).status).toBe(409);

    const { d } = await completedDoc();
    auth.user = { ...fakeUser, googleScopes: "https://www.googleapis.com/auth/gmail.readonly" };
    const noScope = await SEND(req("POST", body), ctx(d.id));
    expect(noScope.status).toBe(409);
    expect((await json<{ code: string }>(noScope)).code).toBe("no_send_scope");

    auth.user = fakeUser;
    expect((await SEND(req("POST", { ...body, to: ["kim@ace.co.kr\r\nBcc: x@y.com"] }), ctx(d.id))).status).toBe(400);
    expect(gmail.sent).toHaveLength(0);
  });
});
