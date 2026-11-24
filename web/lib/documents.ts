import "server-only";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { contextOf, docFileName, KIND_LABEL, progressOf, todayKst, type DocContext } from "./docTemplate";
import { renderPdf } from "./pdf";
import type {
  DocKind, DocMessage, DocStatus, DocStep, DocTemplate, DocTemplateInput, DocumentRecord, DocumentSummary, LineItem, LineItemsConfig,
  TemplateField,
} from "./types";

/** 템플릿·문서 DB 조회/매핑 (서버 전용) */

export const TEMPLATE_COLUMNS = `
  t.id, t.kind, t.name, t.description, t.body, t.fields, t.line_items AS "lineItems",
  t.email_subject AS "emailSubject", t.email_body AS "emailBody", t.archived,
  t.updated_at AS "updatedAt", coalesce(nullif(u.name, ''), u.email, '') AS "updatedByName",
  (SELECT count(*) FROM documents d WHERE d.template_id = t.id)::int AS "documentCount"`;
export const TEMPLATE_FROM = "document_templates t LEFT JOIN users u ON u.id = t.updated_by";

export type TemplateRow = Omit<DocTemplate, "updatedAt"> & { updatedAt: Date };
export const toTemplate = (r: TemplateRow): DocTemplate => ({ ...r, updatedAt: r.updatedAt.toISOString() });

export async function getTemplate(id: string, client: PoolClient | typeof pool = pool): Promise<DocTemplate | null> {
  const { rows } = await client.query<TemplateRow>(`SELECT ${TEMPLATE_COLUMNS} FROM ${TEMPLATE_FROM} WHERE t.id = $1`, [id]);
  return rows[0] ? toTemplate(rows[0]) : null;
}

export async function insertTemplate(d: DocTemplateInput, userId: string | null): Promise<DocTemplate> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO document_templates (kind, name, description, body, fields, line_items, email_subject, email_body, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
    [d.kind, d.name, d.description, d.body, JSON.stringify(d.fields), d.lineItems ? JSON.stringify(d.lineItems) : null, d.emailSubject, d.emailBody, userId]
  );
  return (await getTemplate(rows[0].id))!;
}

const SUMMARY_COLUMNS = `
  d.id, d.template_id AS "templateId", d.kind, d.title, d.doc_number AS "docNumber", d.lead_id AS "leadId",
  coalesce(l.company, '') AS company, d.status, d.created_by AS "createdBy",
  coalesce(nullif(u.name, ''), u.email, '') AS "createdByName", coalesce(u.email, '') AS "createdByEmail",
  d.updated_at AS "updatedAt", d.sent_at AS "sentAt", d.fields, d.field_values AS "values",
  (SELECT count(*) FROM document_sends s WHERE s.document_id = d.id)::int AS "sendCount"`;
const FULL_COLUMNS = `${SUMMARY_COLUMNS},
  d.body, d.line_items_config AS "lineItemsConfig", d.email_subject AS "emailSubject", d.email_body AS "emailBody",
  d.line_items AS "lineItems", d.skipped, d.messages, d.step, d.rev, d.created_at AS "createdAt", d.completed_at AS "completedAt"`;
const DOC_FROM = "documents d LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.created_by";

interface SummaryRow {
  id: string;
  templateId: string | null;
  kind: DocKind;
  title: string;
  docNumber: string;
  leadId: string | null;
  company: string;
  status: DocStatus;
  createdBy: string | null;
  createdByName: string;
  createdByEmail: string;
  updatedAt: Date;
  sentAt: Date | null;
  fields: TemplateField[];
  values: Record<string, string>;
  sendCount: number;
}
interface FullRow extends SummaryRow {
  body: string;
  lineItemsConfig: LineItemsConfig | null;
  emailSubject: string;
  emailBody: string;
  lineItems: LineItem[];
  skipped: string[];
  messages: DocMessage[];
  step: DocStep;
  rev: number;
  createdAt: Date;
  completedAt: Date | null;
}

/** 문서 + 저장 버전(rev, 동시 수정 감지) */
export type LoadedDocument = DocumentRecord & { rev: number };

const toSummary = (r: SummaryRow): DocumentSummary => ({
  id: r.id, templateId: r.templateId, kind: r.kind, title: r.title, docNumber: r.docNumber, leadId: r.leadId,
  company: r.company, status: r.status, createdBy: r.createdBy, createdByName: r.createdByName, createdByEmail: r.createdByEmail,
  updatedAt: r.updatedAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null, sendCount: r.sendCount,
  progress: progressOf(r.fields, r.values),
});

const toDocument = (r: FullRow): LoadedDocument => ({
  ...toSummary(r),
  body: r.body, fields: r.fields, lineItemsConfig: r.lineItemsConfig, emailSubject: r.emailSubject, emailBody: r.emailBody,
  values: r.values, lineItems: r.lineItems, skipped: r.skipped, messages: r.messages, step: r.step,
  createdAt: r.createdAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null, rev: r.rev,
});

/** 응답용 (저장 버전 제외) */
export function publicDocument(d: LoadedDocument): DocumentRecord {
  const { rev: _rev, ...doc } = d;
  return doc;
}

export async function getDocument(id: string, client: PoolClient | typeof pool = pool): Promise<LoadedDocument | null> {
  const { rows } = await client.query<FullRow>(`SELECT ${FULL_COLUMNS} FROM ${DOC_FROM} WHERE d.id = $1`, [id]);
  return rows[0] ? toDocument(rows[0]) : null;
}

export interface DocFilter {
  kind: DocKind | null;
  status: DocStatus | null;
  userId: string | null;
  q: string;
}

export async function listDocuments(f: DocFilter): Promise<DocumentSummary[]> {
  const { rows } = await pool.query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM ${DOC_FROM}
     WHERE ($1::text IS NULL OR d.kind = $1)
       AND ($2::text IS NULL OR d.status = $2)
       AND ($3::uuid IS NULL OR d.created_by = $3)
       AND ($4 = '' OR d.title ILIKE '%' || $4 || '%' OR l.company ILIKE '%' || $4 || '%' OR d.doc_number ILIKE '%' || $4 || '%')
     ORDER BY d.updated_at DESC
     LIMIT 300`,
    [f.kind, f.status, f.userId, f.q.replace(/[%_\\]/g, "\\$&")]
  );
  return rows.map(toSummary);
}

/** 문서번호: C-2026-0001 / Q-2026-0001 (종류·연도별 일련번호, 동시 생성은 잠금으로 직렬화) */
export async function nextDocNumber(client: PoolClient, kind: DocKind): Promise<string> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('crm_doc_number'))");
  const prefix = `${kind === "contract" ? "C" : "Q"}-${todayKst().slice(0, 4)}-`;
  const { rows } = await client.query<{ n: number }>(
    `SELECT coalesce(max(substring(doc_number FROM '^[CQ]-\\d{4}-(\\d+)')::int), 0) + 1 AS n
     FROM documents WHERE doc_number LIKE $1 || '%'`,
    [prefix]
  );
  return prefix + String(rows[0].n).padStart(4, "0");
}

/** 값 계산용 문서 정보 */
export const docContext = (doc: LoadedDocument): DocContext => contextOf(doc);

export const fileNameOf = (doc: LoadedDocument) => docFileName(doc.kind, doc.company, doc.title, todayKst(new Date(doc.createdAt)));

export async function documentPdf(doc: LoadedDocument) {
  return renderPdf(doc.body, docContext(doc));
}

export const kindLabel = (k: DocKind) => KIND_LABEL[k];

/** 대화 기록 상한 (오래된 것부터 버린다) */
const MAX_MESSAGES = 200;

export interface DocState {
  leadId: string | null;
  title: string;
  values: Record<string, string>;
  lineItems: LineItem[];
  skipped: string[];
  messages: DocMessage[];
  step: DocStep;
  status: DocStatus;
}

export const stateOf = (d: LoadedDocument): DocState => ({
  leadId: d.leadId, title: d.title, values: { ...d.values }, lineItems: [...d.lineItems], skipped: [...d.skipped],
  messages: [...d.messages], step: d.step, status: d.status,
});

/**
 * 문서 상태 저장. 읽은 뒤 다른 요청이 먼저 바꿨으면(rev 불일치) false
 * (AI 호출 중에 행을 잠그지 않기 위한 낙관적 잠금)
 */
export async function saveState(client: PoolClient | typeof pool, id: string, rev: number, s: DocState): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE documents SET lead_id = $3, title = $4, field_values = $5, line_items = $6, skipped = $7, messages = $8,
            step = $9, status = $10, rev = rev + 1, updated_at = clock_timestamp(),
            completed_at = CASE WHEN $10 = 'completed' AND status <> 'completed' THEN now()
                                WHEN $10 = 'draft' THEN NULL ELSE completed_at END
     WHERE id = $1 AND rev = $2`,
    [
      id, rev, s.leadId, s.title, JSON.stringify(s.values), JSON.stringify(s.lineItems), JSON.stringify(s.skipped),
      JSON.stringify(s.messages.slice(-MAX_MESSAGES)), JSON.stringify(s.step), s.status,
    ]
  );
  return rowCount === 1;
}
