import "server-only";
import type { PoolClient } from "pg";
import { afterSendMessages, fillFromInput, findLeadLite, insertDocument, type LeadLite } from "./docChat";
import { fillText, KIND_LABEL } from "./docTemplate";
import { documentPdf, docContext, fileNameOf, getDocument, kindLabel, publicDocument, saveState, stateOf, type DocState, type LoadedDocument } from "./documents";
import { recordEvent } from "./events";
import type { DocChatResult, DocTemplate, LineItem, StageId } from "./types";

/**
 * 문서 생성·메일 초안·발송 기록 로직 (Route Handler와 Sales Agent가 같은 코드를 쓴다).
 * 모두 호출한 쪽 트랜잭션 client로 실행한다.
 */

/** 템플릿 + 리드 + 항목 값 + 품목 → 채운 문서 상태 + 비어 있는 필수 항목 (저장 전 카드 미리보기에도 쓴다) */
export function buildFilledState(
  template: DocTemplate, lead: LeadLite | null,
  input: { title?: string; values: Record<string, string>; lineItems: LineItem[] }
): { s: DocState; missing: string[] } {
  const s: DocState = {
    leadId: null, title: input.title || template.name, values: {}, lineItems: [], skipped: [], messages: [], step: { type: "lead" }, status: "draft",
  };
  s.messages.push({ role: "assistant", text: `AI Assistant로 ${KIND_LABEL[template.kind]}를 작성했어요.`, at: new Date().toISOString(), kind: "info" });
  const missing = fillFromInput({ ...template, lineItemsConfig: template.lineItems, status: "draft" }, s, {
    lead, values: input.values, lineItems: input.lineItems,
  });
  return { s, missing };
}

/** 템플릿 + 리드 + 항목 값 + 품목으로 문서 만들기. 필수 항목이 비면 초안 → { id, missing } */
export async function createFilledDocument(
  client: PoolClient, template: DocTemplate, userId: string | null,
  input: { leadId: string | null; title?: string; values: Record<string, string>; lineItems: LineItem[] }
): Promise<{ ok: true; id: string; missing: string[] } | { ok: false; error: string }> {
  const lead = input.leadId ? await findLeadLite(input.leadId, client) : null;
  if (input.leadId && !lead) return { ok: false, error: "리드를 찾을 수 없습니다" };
  const { s, missing } = buildFilledState(template, lead, input);
  const id = await insertDocument(client, template, s, userId);
  return { ok: true, id, missing };
}

/** 메일 양식에 빈 값을 넣고 남은 "[]"·"()"·중복 공백 정리 */
const cleanMailText = (t: string) => t.replace(/\[\s*\]|\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/^ +| +$/gm, "").trim();

/** 메일 작성 기본값: 제목·본문(템플릿 메일 양식에 값 채움)·첨부 파일 정보 */
export async function documentEmailDraft(doc: LoadedDocument) {
  const ctx = docContext(doc);
  const { bytes, pages } = await documentPdf(doc);
  return {
    // 제목은 한 줄로
    subject: cleanMailText(fillText(doc.emailSubject || "{{문서명}} 송부드립니다", ctx)).replace(/\n+/g, " "),
    body: cleanMailText(fillText(doc.emailBody, ctx)),
    fileName: fileNameOf(doc),
    bytes,
    pages,
  };
}

/**
 * 발송 성공 후 기록: 문서 상태 sent·발송 후 대화(단계 이동 제안)·document_sends(주소)·리드 이력 document_sent(받는 사람 수만).
 * meta는 리드 이력에 함께 남길 값.
 */
export async function recordDocumentSend(
  c: PoolClient,
  id: string,
  userId: string,
  m: { to: string[]; cc: string[]; subject: string; fileName: string },
  sent: { id: string; link: string },
  meta: Record<string, unknown> = {}
): Promise<{ result: DocChatResult; lead: { id: string; company: string; stage: StageId } | null }> {
  await c.query("SELECT 1 FROM documents WHERE id = $1 FOR UPDATE", [id]);
  const cur = (await getDocument(id, c))!;
  const lead = cur.leadId
    ? (await c.query<{ company: string; stage: StageId }>("SELECT company, stage FROM leads WHERE id = $1", [cur.leadId])).rows[0] ?? null
    : null;
  const s = stateOf(cur);
  afterSendMessages(s, cur.kind, m.to, sent.link, lead);
  s.status = "sent";
  s.step = { type: "done" };
  await saveState(c, id, cur.rev, s);
  await c.query("UPDATE documents SET sent_at = now() WHERE id = $1", [id]);
  await c.query(
    `INSERT INTO document_sends (document_id, user_id, to_addrs, cc_addrs, subject, file_name, gmail_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, userId, m.to, m.cc, m.subject, m.fileName, sent.id]
  );
  if (cur.leadId && lead) {
    await recordEvent(c, cur.leadId, lead.company, "document_sent", {
      kind: cur.kind, kindLabel: kindLabel(cur.kind), title: cur.title, docNumber: cur.docNumber,
      documentId: id, recipients: m.to.length + m.cc.length, ...meta,
    });
  }
  return {
    result: { document: publicDocument((await getDocument(id, c))!), changed: [] },
    lead: cur.leadId && lead ? { id: cur.leadId, ...lead } : null,
  };
}

/** Gmail 보낸편지함 링크 */
export const sentLink = (email: string, sent: { id: string; threadId: string }) =>
  `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#sent/${sent.threadId || sent.id}`;
