import "server-only";
import type { PoolClient } from "pg";
import { idArg, idListArg, leadTarget, str, text, VIA, type AgentTool, type Args, type ExecResult, type ReadTool, type WriteTool } from "./agentToolKit";
import { findUserById, type SessionUser } from "./auth";
import { pool } from "./db";
import { findLeadLite, suggestedStage } from "./docChat";
import { buildFilledState, createFilledDocument, documentEmailDraft, recordDocumentSend, sentLink } from "./docOps";
import { cleanItem, computeTotals, hasItemsTable, ITEM_LIMITS, KIND_LABEL, normalizeStored } from "./docTemplate";
import { documentPdf, getDocument, getTemplate, listDocuments, TEMPLATE_COLUMNS, TEMPLATE_FROM, toTemplate, type LoadedDocument, type TemplateRow } from "./documents";
import { inSavepoint, recordEvent } from "./events";
import { formatWon } from "./format";
import { sendRawMessage } from "./gmail";
import { canSendGmail, GoogleError } from "./google";
import { buildMime, encodedSize, MAIL_TOO_LARGE, MAX_MAIL_BYTES } from "./mime";
import type { AgentChange, DocStatus, DocTemplate, LineItem } from "./types";
import { isDocKind, isMailAddress, parseMailText, parseSendInput } from "./validate";

/**
 * Gmail·견적서/계약서 도구.
 * - 받는 사람 주소는 모델이 정하지 않는다: 서버가 리드 담당자(연결 연락처 → 리드 이메일)와
 *   같은 회사 연락처(참조, id로만 지정)에서 채우고, 주소는 계획 카드(화면)에만 보인다.
 * - 발송은 되돌릴 수 없으므로 승인 때 문서·받는 사람이 계획과 같은지 다시 확인하고, 이미 보낸 문서는 다시 보내지 않는다.
 *   발송 뒤 기록이 실패하면 승인 대기로 남기지 않고 실패로 끝내 다시 승인해도 두 번 보내지 않는다.
 */

const MAX_CC = 10;
const MAX_LIST = 30;

/* ───────── 공통 ───────── */

/** 메일을 보낼 수 있는 사용자 (Gmail 연동 + 발송 권한) */
async function mailUser(userId: string): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }> {
  const user = await findUserById(userId);
  if (!user || !canSendGmail(user)) {
    return { ok: false, error: "메일을 보내려면 Gmail 발송 권한이 필요합니다. 설정 → Gmail에서 다시 연동하세요" };
  }
  return { ok: true, user };
}

type Recipients = { to: string[]; cc: string[]; toLabel: string; ccLabels: string[]; company: string; contact: string };

const mail = (v: string | null | undefined) => {
  const m = (v ?? "").trim().toLowerCase();
  return isMailAddress(m) ? m : null;
};

/** 리드 담당자(받는 사람) + 같은 회사 연락처(참조) 주소 */
async function resolveRecipients(db: PoolClient | typeof pool, leadId: string, ccContactIds: string[]): Promise<Recipients | { error: string }> {
  const lead = (await db.query<{ company: string; companyId: string | null; contact: string; email: string; contactName: string | null; contactEmail: string | null }>(
    `SELECT l.company, l.company_id AS "companyId", l.contact, l.email, c.name AS "contactName", c.email AS "contactEmail"
     FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id WHERE l.id = $1`,
    [leadId]
  )).rows[0];
  if (!lead) return { error: "리드를 찾을 수 없습니다" };
  const to = mail(lead.contactEmail) ?? mail(lead.email);
  const name = lead.contactName || lead.contact || "담당자";
  if (!to) return { error: `${lead.company} 리드 담당자의 이메일이 없습니다. 리드나 연락처 화면에서 이메일을 입력하세요` };

  const ids = [...new Set(ccContactIds)].slice(0, MAX_CC);
  const { rows } = ids.length
    ? await db.query<{ id: string; name: string; email: string; companyId: string | null }>(
        `SELECT id, name, email, company_id AS "companyId" FROM contacts WHERE id = ANY($1)`, [ids]
      )
    : { rows: [] };
  const cc: string[] = [];
  const ccLabels: string[] = [];
  for (const id of ids) {
    const c = rows.find((r) => r.id === id);
    if (!c) return { error: "참조할 연락처를 찾을 수 없습니다" };
    if (!lead.companyId || c.companyId !== lead.companyId) return { error: `${c.name} 님은 ${lead.company} 소속 연락처가 아니라 참조할 수 없습니다` };
    const addr = mail(c.email);
    if (!addr) return { error: `${c.name} 님의 이메일이 없어 참조할 수 없습니다` };
    if (addr !== to && !cc.includes(addr)) {
      cc.push(addr);
      ccLabels.push(`${c.name} <${addr}>`);
    }
  }
  return { to: [to], cc, toLabel: `${name} <${to}>`, ccLabels, company: lead.company, contact: name };
}

const ccArg = (a: Args) => idListArg(a, "ccContactIds");

/** 계획 이후 주소가 바뀌었는지 (연락처 이메일 수정 등) */
const sameRecipients = (r: Recipients, a: Args) => JSON.stringify([r.to, r.cc]) === JSON.stringify([a.to, a.cc]);

const mailChanges = (r: Recipients, subject: string, body: string): AgentChange[] => [
  { field: "받는 사람", after: r.toLabel },
  ...(r.ccLabels.length ? [{ field: "참조", after: r.ccLabels.join(", ") }] : []),
  { field: "제목", after: subject },
  { field: "본문", after: body || undefined },
];

/** 발송 실패 메시지 (구글 에러) — 그 밖의 에러는 다시 던진다 (아직 보내지 않았으므로 승인 대기로 남아도 안전) */
function sendFailure(e: unknown): ExecResult {
  if (!(e instanceof GoogleError)) throw e;
  // 응답 시간 초과는 Gmail이 이미 보냈을 수 있다
  if (e.code === "timeout") {
    return { ok: false, message: "Gmail 응답이 늦어 발송됐는지 알 수 없습니다. 보낸편지함을 확인한 뒤 필요하면 다시 요청하세요" };
  }
  return { ok: false, message: `메일을 보내지 못했습니다: ${e.message}` };
}

const SEND_NOTICE = "승인하면 내 Gmail로 바로 발송되며 되돌릴 수 없습니다. 받는 사람과 본문에 보내면 안 되는 정보가 없는지 확인하세요";

const RECORD_FAILED = "메일은 발송됐지만 기록하지 못했습니다. 다시 보내지 말고 Gmail 보낸편지함을 확인하세요";

/* ───────── 조회 도구 ───────── */

const listTemplates: ReadTool = {
  kind: "read",
  label: "문서 템플릿 조회",
  def: {
    name: "list_templates",
    description: "견적서·계약서 템플릿 목록과 항목(이름·유형·필수 여부)을 조회합니다. fromLead 항목은 리드에서 자동으로 채워지고, private 항목(이메일·전화)은 값을 넘기지 마세요.",
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["quote", "contract"] } } },
  },
  async run(a) {
    const kind = isDocKind(a.kind) ? a.kind : null;
    const { rows } = await pool.query<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM ${TEMPLATE_FROM} WHERE t.archived = false AND ($1::text IS NULL OR t.kind = $1) ORDER BY t.updated_at DESC`,
      [kind]
    );
    return {
      templates: rows.map(toTemplate).map((t) => ({
        id: t.id, kind: t.kind, kindLabel: KIND_LABEL[t.kind], name: t.name, description: t.description || undefined,
        hasLineItems: t.kind === "quote" && hasItemsTable(t.body),
        fields: t.fields.map((f) => ({
          key: f.key, type: f.type, required: f.required,
          ...(f.options.length ? { options: f.options } : {}),
          ...(f.leadSource ? { fromLead: true } : {}),
          ...(f.type === "email" || f.type === "phone" ? { private: true } : {}),
        })),
      })),
    };
  },
};

const DOC_STATUS = new Set<string>(["draft", "completed", "sent"]);

const listDocs: ReadTool = {
  kind: "read",
  label: "작성한 문서 조회",
  def: {
    name: "list_documents",
    description: "작성한 견적서·계약서 목록(최근 수정순 최대 30건)을 조회합니다. 상태: draft 작성 중, completed 완성(발송 가능), sent 발송함.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["quote", "contract"] },
        status: { type: "string", enum: ["draft", "completed", "sent"] },
        query: { type: "string", description: "제목·회사명·문서번호에 포함된 글자" },
        leadId: { type: "string" },
      },
    },
  },
  async run(a) {
    const leadId = idArg(a, "leadId");
    const docs = (await listDocuments({
      kind: isDocKind(a.kind) ? a.kind : null,
      status: DOC_STATUS.has(a.status as string) ? (a.status as DocStatus) : null,
      userId: null,
      q: str(a.query, 100),
    })).filter((d) => !leadId || d.leadId === leadId);
    return {
      count: docs.length,
      documents: docs.slice(0, MAX_LIST).map((d) => ({
        id: d.id, kind: d.kind, title: d.title, docNumber: d.docNumber, leadId: d.leadId ?? undefined, company: d.company || undefined,
        status: d.status, progress: d.progress, sendCount: d.sendCount, sentAt: d.sentAt ?? undefined,
      })),
    };
  },
};

/* ───────── 문서 작성 ───────── */

type DocArgs = { template: DocTemplate; leadId: string | null; title: string; values: Record<string, string>; lineItems: LineItem[] };

/** create_document 인자 검증 (템플릿 항목에 있고 개인정보가 아닌 값만, 품목은 cleanItem) */
async function parseDocArgs(db: PoolClient | typeof pool, a: Args): Promise<{ ok: true; data: DocArgs } | { ok: false; error: string }> {
  const templateId = idArg(a, "templateId");
  const template = templateId ? await getTemplate(templateId, db) : null;
  if (!template || template.archived) return { ok: false, error: "템플릿을 찾을 수 없습니다 (list_templates로 확인하세요)" };
  const leadId = idArg(a, "leadId");
  if (a.leadId && !leadId) return { ok: false, error: "리드 id가 올바르지 않습니다" };

  const values: Record<string, string> = {};
  const raw = a.values && typeof a.values === "object" && !Array.isArray(a.values) ? (a.values as Args) : {};
  for (const [key, v] of Object.entries(raw)) {
    const f = template.fields.find((x) => x.key === key);
    if (!f) return { ok: false, error: `템플릿에 없는 항목입니다: ${key}` };
    if (f.type === "email" || f.type === "phone") continue; // 개인정보 항목은 리드에서만 채운다
    const n = normalizeStored(f, String(v ?? ""));
    if (!n.ok) return { ok: false, error: `항목 "${key}" 값이 올바르지 않습니다` };
    values[key] = String(v ?? "");
  }

  const items = Array.isArray(a.lineItems) ? a.lineItems : [];
  if (items.length > ITEM_LIMITS.count) return { ok: false, error: `품목은 ${ITEM_LIMITS.count}개까지 넣을 수 있습니다` };
  const lineItems: LineItem[] = [];
  for (const it of items) {
    const c = cleanItem(it);
    if (!c) return { ok: false, error: "품목은 이름·수량·단가(원)를 넣으세요" };
    lineItems.push(c);
  }
  return { ok: true, data: { template, leadId, title: str(a.title, 100), values, lineItems } };
}

const createDocTool: WriteTool = {
  kind: "write",
  label: "견적서·계약서 작성",
  def: {
    name: "create_document",
    description:
      "템플릿으로 견적서·계약서를 만드는 실행 계획을 작성합니다(사용자 승인 후 저장). 먼저 list_templates로 템플릿과 항목을 확인하세요. " +
      "리드를 지정하면 회사명·담당자·연락처 항목은 리드에서 채워집니다. 필수 항목이 비면 초안으로 저장됩니다. 발송은 send_document로 따로 요청합니다.",
    parameters: {
      type: "object",
      properties: {
        templateId: { type: "string" },
        leadId: { type: "string" },
        title: { type: "string", description: "문서명 (없으면 템플릿 이름)" },
        values: { type: "object", description: "항목 key → 값 (날짜 YYYY-MM-DD, 금액은 숫자). 이메일·전화 항목은 넣지 마세요", additionalProperties: { type: "string" } },
        lineItems: {
          type: "array",
          description: "견적서 품목",
          items: {
            type: "object",
            properties: { name: { type: "string" }, spec: { type: "string" }, qty: { type: "number" }, unitPrice: { type: "number", description: "단가(원)" } },
            required: ["name", "qty", "unitPrice"],
          },
        },
      },
      required: ["templateId"],
    },
  },
  async prepare(a) {
    const p = await parseDocArgs(pool, a);
    if (!p.ok) return { error: p.error };
    const { template: t, leadId } = p.data;
    const lead = leadId ? await findLeadLite(leadId) : null;
    if (leadId && !lead) return { error: "리드를 찾을 수 없습니다" };

    // 저장할 때와 같은 규칙으로 미리 채워 보고 비는 필수 항목을 카드에 알린다
    const { s, missing } = buildFilledState(t, lead, p.data);
    const items = s.lineItems;
    const totals = items.length ? computeTotals(items, t.lineItems) : null;
    const changes: AgentChange[] = [
      { field: "템플릿", after: `${t.name} (${KIND_LABEL[t.kind]})` },
      { field: "리드", after: lead ? (lead.contact ? `${lead.company} · ${lead.contact}` : lead.company) : "(리드 없음)" },
      { field: "문서명", after: p.data.title || t.name },
      ...Object.entries(p.data.values).filter(([, v]) => v.trim()).map(([k, v]) => ({ field: k, after: text(v) })),
      ...items.map((it, i) => ({ field: `품목 ${i + 1}`, after: `${it.name}${it.spec ? ` (${it.spec})` : ""} · ${it.qty} × ${formatWon(it.unitPrice)}` })),
      ...(totals ? [{ field: "합계", after: `${formatWon(totals.total)} (공급가액 ${formatWon(totals.supply)} + 부가세 ${formatWon(totals.vat)})` }] : []),
    ];
    return {
      title: `${KIND_LABEL[t.kind]} 작성`,
      changes,
      ...(lead ? { target: leadTarget(lead) } : {}),
      notice: missing.length
        ? { tone: "warning", text: `필수 항목 ${missing.length}개(${missing.join(", ")})가 비어 있어 초안으로 저장됩니다. 계약서 메뉴에서 마저 작성하세요` }
        : { tone: "info", text: "완성된 문서로 저장됩니다. 메일 발송은 따로 승인합니다" },
      args: { templateId: t.id, leadId, title: p.data.title, values: p.data.values, lineItems: p.data.lineItems },
    };
  },
  async execute(client, userId, a) {
    const p = await parseDocArgs(client, a);
    if (!p.ok) return { ok: false, message: p.error };
    const r = await createFilledDocument(client, p.data.template, userId, p.data);
    if (!r.ok) return { ok: false, message: r.error };
    const label = KIND_LABEL[p.data.template.kind];
    return {
      ok: true,
      message: r.missing.length ? `${label} 초안을 저장했습니다 (빈 필수 항목: ${r.missing.join(", ")})` : `${label}를 완성했습니다`,
      target: { kind: "document", id: r.id, label: p.data.title || p.data.template.name },
    };
  },
};

/* ───────── 문서 발송 ───────── */

type DocExpect = { rev?: unknown; status?: unknown };

/** 승인 때: 문서를 잠그고 계획과 같은지(아직 안 보냈고 그 뒤 바뀌지 않았는지)·받는 사람 주소가 같은지 확인 */
async function verifyPlannedDocument(
  client: PoolClient, a: Args
): Promise<{ ok: true; doc: LoadedDocument & { leadId: string }; recipients: Recipients } | { ok: false; message: string }> {
  const id = idArg(a, "documentId");
  if (!id) return { ok: false, message: "문서 id가 올바르지 않습니다" };
  await client.query("SELECT 1 FROM documents WHERE id = $1 FOR UPDATE", [id]);
  const doc = await getDocument(id, client);
  if (!doc) return { ok: false, message: "문서를 찾을 수 없습니다" };
  if (doc.status === "sent") return { ok: false, message: "이미 발송한 문서입니다" };
  const expect = (a.expect ?? {}) as DocExpect;
  if (!doc.leadId || doc.rev !== expect.rev || doc.status !== expect.status) {
    return { ok: false, message: "계획을 만든 뒤 문서가 바뀌었습니다. 최신 내용으로 다시 요청하세요" };
  }
  const recipients = await resolveRecipients(client, doc.leadId, ccArg(a));
  if ("error" in recipients) return { ok: false, message: recipients.error };
  if (!sameRecipients(recipients, a)) return { ok: false, message: "계획을 만든 뒤 받는 사람 주소가 바뀌었습니다. 다시 요청하세요" };
  return { ok: true, doc: { ...doc, leadId: doc.leadId }, recipients };
}

const sendDocTool: WriteTool = {
  kind: "write",
  sends: true,
  label: "견적서·계약서 발송",
  def: {
    name: "send_document",
    description:
      "완성한 견적서·계약서를 PDF로 첨부해 리드 담당자에게 보내는 실행 계획을 만듭니다(사용자 승인 후 내 Gmail로 발송, 되돌릴 수 없음). " +
      "받는 사람은 서버가 정합니다. 참조는 같은 회사 연락처 id(ccContactIds)로만 지정하세요. subject·body를 비우면 템플릿 메일 양식을 씁니다.",
    parameters: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        ccContactIds: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["documentId"],
    },
  },
  async prepare(a, userId) {
    const u = await mailUser(userId);
    if (!u.ok) return { error: u.error };
    const id = idArg(a, "documentId");
    const doc = id ? await getDocument(id) : null;
    if (!doc) return { error: "문서를 찾을 수 없습니다 (list_documents로 확인하세요)" };
    if (doc.status === "draft") return { error: "아직 완성하지 않은 문서입니다. 계약서 메뉴에서 빈 항목을 채워 완성하세요" };
    if (doc.status === "sent") return { error: "이미 발송한 문서입니다. 다시 보내려면 계약서 메뉴에서 복제하세요" };
    if (!doc.leadId) return { error: "리드가 없는 문서는 계약서 메뉴에서 받는 사람을 입력해 보내세요" };
    const r = await resolveRecipients(pool, doc.leadId, ccArg(a));
    if ("error" in r) return { error: r.error };

    const draft = await documentEmailDraft(doc);
    const m = parseSendInput({
      to: r.to, cc: r.cc, fileName: draft.fileName,
      subject: typeof a.subject === "string" && a.subject.trim() ? a.subject : draft.subject,
      body: typeof a.body === "string" && a.body.trim() ? a.body : draft.body,
    });
    if (!m.ok) return { error: m.error };
    if (encodedSize(draft.bytes.length) > MAX_MAIL_BYTES) return { error: MAIL_TOO_LARGE };
    return {
      title: `${KIND_LABEL[doc.kind]} 발송`,
      changes: [
        { field: "문서", after: `${doc.docNumber} ${doc.title}` },
        ...mailChanges(r, m.data.subject, m.data.body),
        { field: "첨부", after: `${m.data.fileName} (${draft.pages}쪽, ${Math.ceil(draft.bytes.length / 1024)}KB)` },
      ],
      target: { kind: "document", id: doc.id, label: doc.title },
      danger: true,
      approveLabel: "발송 승인",
      notice: { tone: "warning", text: SEND_NOTICE },
      args: { documentId: doc.id, ccContactIds: ccArg(a), ...m.data, expect: { rev: doc.rev, status: doc.status } satisfies DocExpect },
    };
  },
  async execute(client, userId, a) {
    const u = await mailUser(userId);
    if (!u.ok) return { ok: false, message: u.error };
    const v = await verifyPlannedDocument(client, a);
    if (!v.ok) return v;
    const { doc } = v;
    const m = parseSendInput(a);
    if (!m.ok) return { ok: false, message: m.error };

    const { bytes } = await documentPdf(doc);
    const raw = buildMime({ ...m.data, attachment: { fileName: m.data.fileName, contentType: "application/pdf", data: bytes } });
    if (raw.length > MAX_MAIL_BYTES) return { ok: false, message: MAIL_TOO_LARGE };

    let sent: { id: string; threadId: string };
    try {
      sent = await sendRawMessage(u.user, raw);
    } catch (e) {
      return sendFailure(e);
    }
    try {
      const { lead } = await inSavepoint(client, (c) =>
        recordDocumentSend(c, doc.id, userId, m.data, { id: sent.id, link: sentLink(u.user.email, sent) }, VIA)
      );
      // 발송 후 단계 이동은 별도 계획 카드로 제안 (견적서 → 제안/견적, 계약서 → 협상)
      const stage = lead ? suggestedStage(doc.kind, lead.stage) : null;
      return {
        ok: true,
        message: `${KIND_LABEL[doc.kind]}를 보냈습니다 (받는 사람 ${m.data.to.length + m.data.cc.length}명)`,
        target: { kind: "document", id: doc.id, label: doc.title },
        ...(lead && stage ? { next: [{ tool: "move_lead_stage", args: { leadId: lead.id, stage } }] } : {}),
      };
    } catch (e) {
      console.error("[agent] send_document record", e);
      return { ok: false, message: RECORD_FAILED };
    }
  },
};

/* ───────── 일반 메일 ───────── */

const MAIL_PROPS = {
  leadId: { type: "string", description: "받는 리드 (받는 사람은 리드 담당자)" },
  ccContactIds: { type: "array", items: { type: "string" }, description: "참조할 같은 회사 연락처 id" },
  subject: { type: "string" },
  body: { type: "string", description: "메일 본문 (서명 포함, 일반 텍스트)" },
};

/** 메일 인자 → 받는 사람·제목·본문 */
async function parseMailArgs(db: PoolClient | typeof pool, a: Args) {
  const leadId = idArg(a, "leadId");
  if (!leadId) return { ok: false as const, error: "받는 리드를 지정하세요" };
  const r = await resolveRecipients(db, leadId, ccArg(a));
  if ("error" in r) return { ok: false as const, error: r.error };
  const t = parseMailText(a);
  if (!t.ok) return t;
  if (!t.data.body) return { ok: false as const, error: "메일 본문을 입력하세요" };
  return { ok: true as const, leadId, r, ...t.data };
}

const draftMailTool: WriteTool = {
  kind: "write",
  label: "메일 초안",
  def: {
    name: "draft_email",
    description: "리드 담당자에게 보낼 메일 초안을 카드로 보여줍니다(발송하지 않음). 사용자가 '초안만', '써 줘'처럼 발송을 요청하지 않았을 때 쓰세요.",
    parameters: { type: "object", properties: MAIL_PROPS, required: ["leadId", "subject", "body"] },
  },
  async prepare(a) {
    const p = await parseMailArgs(pool, a);
    if (!p.ok) return { error: p.error };
    return {
      title: "메일 초안",
      changes: mailChanges(p.r, p.subject, p.body),
      draft: true,
      notice: { tone: "info", text: "초안입니다. 보내려면 ‘이대로 보내기 요청’을 누르거나 고칠 내용을 말씀하세요" },
      // 초안은 저장·승인하지 않는다 (execute 없음)
      args: {},
    };
  },
};

const sendMailTool: WriteTool = {
  kind: "write",
  sends: true,
  label: "메일 발송",
  def: {
    name: "send_email",
    description:
      "리드 담당자에게 일반 메일(첨부 없음)을 보내는 실행 계획을 만듭니다(사용자 승인 후 내 Gmail로 발송, 되돌릴 수 없음). " +
      "받는 사람은 서버가 정합니다. 견적서·계약서를 보낼 때는 send_document를 쓰세요.",
    parameters: { type: "object", properties: MAIL_PROPS, required: ["leadId", "subject", "body"] },
  },
  async prepare(a, userId) {
    const u = await mailUser(userId);
    if (!u.ok) return { error: u.error };
    const p = await parseMailArgs(pool, a);
    if (!p.ok) return { error: p.error };
    return {
      title: "메일 발송",
      changes: mailChanges(p.r, p.subject, p.body),
      danger: true,
      approveLabel: "발송 승인",
      notice: { tone: "warning", text: SEND_NOTICE },
      args: { leadId: p.leadId, ccContactIds: ccArg(a), to: p.r.to, cc: p.r.cc, subject: p.subject, body: p.body },
    };
  },
  async execute(client, userId, a) {
    const u = await mailUser(userId);
    if (!u.ok) return { ok: false, message: u.error };
    const p = await parseMailArgs(client, a);
    if (!p.ok) return { ok: false, message: p.error };
    if (!sameRecipients(p.r, a)) return { ok: false, message: "계획을 만든 뒤 받는 사람 주소가 바뀌었습니다. 다시 요청하세요" };

    let sent: { id: string; threadId: string };
    try {
      sent = await sendRawMessage(u.user, buildMime({ to: p.r.to, cc: p.r.cc, subject: p.subject, body: p.body }));
    } catch (e) {
      return sendFailure(e);
    }
    try {
      // 리드 이력: 주소 없이 제목·받는 사람 수만 (Assistant 컨텍스트로 쓰이므로)
      await inSavepoint(client, (c) =>
        recordEvent(c, p.leadId, p.r.company, "email_sent", {
          subject: p.subject, recipients: p.r.to.length + p.r.cc.length, gmailMessageId: sent.id, ...VIA,
        })
      );
    } catch (e) {
      console.error("[agent] send_email record", e);
      return { ok: false, message: RECORD_FAILED };
    }
    return {
      ok: true,
      message: `${p.r.contact} 님에게 메일을 보냈습니다 (받는 사람 ${p.r.to.length + p.r.cc.length}명)`,
      target: { kind: "lead", id: p.leadId, label: p.r.company },
    };
  },
};

export const AGENT_MAIL_TOOLS: AgentTool[] = [listTemplates, listDocs, createDocTool, sendDocTool, draftMailTool, sendMailTool];
