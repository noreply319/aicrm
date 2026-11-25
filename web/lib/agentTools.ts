import "server-only";
import { AGENT_CRM_TOOLS } from "./agentCrmTools";
import { diffFields, has, idArg, leadTarget, stale, str, text, unchanged, VIA, type AgentTool, type Args, type ReadTool, type WriteTool } from "./agentToolKit";
import { PRIORITY_LABEL, STAGES } from "./constants";
import { LEAD_COLUMNS, pool, toLead, type LeadRow } from "./db";
import { formatWon } from "./format";
import { createLead, deleteLead, findLead, leadInputOf, moveLead, updateLead } from "./leadOps";
import { maskChanges, maskPii } from "./openai";
import type { AgentChange, Lead, LeadInput, Priority, StageId } from "./types";
import { isPriority, isStage, parseLeadInput } from "./validate";

/** 리드 도구 (조회·생성·수정·단계 이동·삭제) + 전체 도구 레지스트리 */

const STALE = stale("리드가");
const GONE = "리드를 찾을 수 없습니다 (이미 삭제됐을 수 있습니다)";

/* ───────── 표시용 ───────── */

const stageName = (id: string) => STAGES.find((s) => s.id === id)?.name ?? id;

const FIELD_LABEL: Record<string, string> = {
  company: "회사", contact: "담당자", title: "직함", value: "금액", closeDate: "예상 마감일",
  stage: "단계", priority: "우선순위", notes: "메모",
};

/** 리드 필드 값 → 카드에 보여줄 문자열 (빈 값은 undefined → "없음") */
function display(field: string, v: unknown): string | undefined {
  if (v === "" || v === null || v === undefined) return undefined;
  if (field === "value") return formatWon(Number(v));
  if (field === "stage") return stageName(String(v));
  if (field === "priority") return PRIORITY_LABEL[v as Priority] ?? String(v);
  return text(v);
}

const change = (field: string, before: unknown, after: unknown): AgentChange => ({
  field: FIELD_LABEL[field] ?? field,
  before: display(field, before),
  after: display(field, after),
});


/* ───────── 인자 파싱 ───────── */

const leadIdArg = (a: Args) => idArg(a, "leadId");

/** 모델에 보내는 리드 요약 (이메일·전화번호 제외) */
const leadForModel = (l: Lead) => ({
  id: l.id,
  company: l.company,
  contact: l.contact || undefined,
  title: l.title || undefined,
  value: l.value,
  closeDate: l.closeDate || undefined,
  stage: l.stage,
  stageName: stageName(l.stage),
  priority: l.priority,
});

/* ───────── 조회 도구 ───────── */

const MAX_SEARCH = 30;

const searchLeads: ReadTool = {
  kind: "read",
  label: "리드 검색",
  def: {
    name: "search_leads",
    description: "리드를 조건으로 검색합니다. 회사명·담당자명 일부, 단계, 우선순위, 최소 금액으로 거를 수 있습니다.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "회사명·담당자명에 포함된 글자" },
        stage: { type: "string", enum: STAGES.map((s) => s.id) },
        priority: { type: "string", enum: ["high", "mid", "low"] },
        minValue: { type: "number", description: "최소 금액(원)" },
      },
    },
  },
  async run(a) {
    const q = str(a.query, 100).toLowerCase();
    const minValue = Number(a.minValue);
    const { rows } = await pool.query<LeadRow>(`SELECT ${LEAD_COLUMNS} FROM leads ORDER BY position`);
    const leads = rows
      .map(toLead)
      .filter((l) => !q || l.company.toLowerCase().includes(q) || l.contact.toLowerCase().includes(q))
      .filter((l) => !isStage(a.stage) || l.stage === a.stage)
      .filter((l) => !isPriority(a.priority) || l.priority === a.priority)
      .filter((l) => !Number.isFinite(minValue) || l.value >= minValue);
    return { count: leads.length, leads: leads.slice(0, MAX_SEARCH).map(leadForModel) };
  },
};

const getLead: ReadTool = {
  kind: "read",
  label: "리드 상세 조회",
  def: {
    name: "get_lead",
    description: "리드 한 건의 최신 정보와 최근 변경 이력 20건을 조회합니다. 변경 계획을 만들기 전 현재 값을 확인할 때 쓰세요.",
    parameters: {
      type: "object",
      properties: { leadId: { type: "string", description: "리드 id (CRM 데이터의 leads.id)" } },
      required: ["leadId"],
    },
  },
  async run(a) {
    const id = leadIdArg(a);
    if (!id) return { error: "리드 id가 올바르지 않습니다" };
    const lead = await findLead(pool, id);
    if (!lead) return { error: "리드를 찾을 수 없습니다" };
    const { rows } = await pool.query<{ type: string; changes: Args; at: Date }>(
      `SELECT type, changes, created_at AS at FROM lead_events WHERE lead_id=$1 ORDER BY created_at DESC, id DESC LIMIT 20`,
      [id]
    );
    return {
      lead: { ...leadForModel(lead), notes: maskPii(lead.notes) || undefined },
      events: rows.map((e) => ({ type: e.type, changes: maskChanges(e.changes), at: e.at.toISOString() })),
    };
  },
};

const pipelineSummary: ReadTool = {
  kind: "read",
  label: "파이프라인 집계",
  def: {
    name: "pipeline_summary",
    description: "단계별 리드 수·금액 합계와 파이프라인 금액(수주·실주 제외)을 최신 값으로 집계합니다.",
    parameters: { type: "object", properties: {} },
  },
  async run() {
    const { rows } = await pool.query<{ stage: string; count: number; total: string }>(
      "SELECT stage, count(*)::int AS count, coalesce(sum(value), 0)::text AS total FROM leads GROUP BY stage"
    );
    const byStage = STAGES.map((s) => {
      const r = rows.find((x) => x.stage === s.id);
      return { stage: s.id, stageName: s.name, count: r?.count ?? 0, total: Number(r?.total ?? 0) };
    });
    const pipeline = byStage.filter((s) => s.stage !== "won" && s.stage !== "lost").reduce((n, s) => n + s.total, 0);
    return { byStage, pipeline };
  },
};

/* ───────── 변경 도구 ───────── */

/** create_lead 인자 → LeadInput (이메일·전화번호는 받지 않음) */
function parseCreate(a: Args): { ok: true; data: LeadInput } | { ok: false; error: string } {
  if (has(a, "stage") && !isStage(a.stage)) return { ok: false, error: "단계가 올바르지 않습니다" };
  if (has(a, "priority") && !isPriority(a.priority)) return { ok: false, error: "우선순위가 올바르지 않습니다" };
  return parseLeadInput({
    company: a.company,
    contact: a.contact,
    title: a.title,
    value: a.value,
    closeDate: a.closeDate,
    stage: a.stage,
    priority: a.priority,
    notes: a.notes,
  });
}

const createLeadTool: WriteTool = {
  kind: "write",
  label: "리드 생성",
  def: {
    name: "create_lead",
    description: "새 리드를 만드는 실행 계획을 작성합니다(사용자 승인 후 실행). 같은 이름의 회사가 없으면 회사도 함께 등록됩니다.",
    parameters: {
      type: "object",
      properties: {
        company: { type: "string", description: "회사명 (필수)" },
        contact: { type: "string", description: "담당자 이름" },
        title: { type: "string", description: "담당자 직함" },
        value: { type: "number", description: "예상 금액(원, 정수)" },
        closeDate: { type: "string", description: "예상 마감일 YYYY-MM-DD" },
        stage: { type: "string", enum: STAGES.map((s) => s.id), description: "기본 new" },
        priority: { type: "string", enum: ["high", "mid", "low"], description: "기본 mid" },
        notes: { type: "string", description: "메모" },
      },
      required: ["company"],
    },
  },
  async prepare(a) {
    const p = parseCreate(a);
    if (!p.ok) return { error: p.error };
    const d = p.data;
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM companies WHERE name_key = crm_company_key($1)", [d.company]);
    const changes = (["company", "contact", "title", "value", "closeDate", "stage", "priority", "notes"] as const)
      .filter((f) => d[f] !== "" && !(f === "value" && d.value === 0))
      .map((f) => change(f, undefined, d[f]));
    if (!rows[0]) changes[0] = { ...changes[0], after: `${d.company} (새 회사로 등록)` };
    const { company, contact, title, value, closeDate, stage, priority, notes } = d;
    return {
      title: "리드 생성",
      changes,
      affectsLeads: true,
      args: { company, contact, title, value, closeDate, stage, priority, notes },
    };
  },
  async execute(client, userId, a) {
    const p = parseCreate(a);
    if (!p.ok) return { ok: false, message: p.error };
    const r = await createLead(client, userId, p.data, VIA);
    return r.ok ? { ok: true, message: "리드를 만들었습니다", target: leadTarget(r.lead) } : { ok: false, message: r.error };
  },
};

/** update_lead로 바꿀 수 있는 필드 (회사·담당자·연락처 정보·단계는 제외) */
const UPDATABLE = ["value", "closeDate", "priority", "notes"] as const;
type Updatable = (typeof UPDATABLE)[number];

function parseUpdate(a: Args): { ok: true; id: string; set: Partial<Pick<LeadInput, Updatable>> } | { ok: false; error: string } {
  const id = leadIdArg(a);
  if (!id) return { ok: false, error: "리드 id가 올바르지 않습니다" };
  const keys = UPDATABLE.filter((k) => has(a, k));
  if (keys.length === 0) return { ok: false, error: "바꿀 항목이 없습니다 (금액·예상 마감일·우선순위·메모만 바꿀 수 있습니다)" };
  // parseLeadInput은 잘못된 우선순위를 기본값으로 바꾸므로 따로 거른다
  if (has(a, "priority") && !isPriority(a.priority)) return { ok: false, error: "우선순위가 올바르지 않습니다" };
  // 값 검증·정리는 리드 API와 같은 parseLeadInput으로 (회사는 검증용 자리값)
  const v = parseLeadInput({ company: "-", value: a.value, closeDate: a.closeDate, priority: a.priority, notes: a.notes });
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, id, set: Object.fromEntries(keys.map((k) => [k, v.data[k]])) };
}


const updateLeadTool: WriteTool = {
  kind: "write",
  label: "리드 수정",
  def: {
    name: "update_lead",
    description:
      "리드의 금액·예상 마감일·우선순위·메모를 바꾸는 실행 계획을 작성합니다(사용자 승인 후 실행). 바꿀 항목만 넘기세요. 단계 변경은 move_lead_stage를 쓰세요.",
    parameters: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "리드 id" },
        value: { type: "number", description: "금액(원, 정수)" },
        closeDate: { type: "string", description: "예상 마감일 YYYY-MM-DD (빈 문자열이면 삭제)" },
        priority: { type: "string", enum: ["high", "mid", "low"] },
        notes: { type: "string", description: "메모 전체 (기존 메모를 대체)" },
      },
      required: ["leadId"],
    },
  },
  async prepare(a) {
    const p = parseUpdate(a);
    if (!p.ok) return { error: p.error };
    const lead = await findLead(pool, p.id);
    if (!lead) return { error: "리드를 찾을 수 없습니다" };
    const { fields, set, expect } = diffFields(lead, p.set);
    if (fields.length === 0) return { error: "이미 같은 값입니다. 바뀌는 항목이 없습니다" };
    return {
      title: "리드 수정",
      changes: fields.map((f) => change(f, lead[f], p.set[f])),
      target: leadTarget(lead),
      affectsLeads: true,
      args: { leadId: lead.id, ...set, expect },
    };
  },
  async execute(client, userId, a) {
    const p = parseUpdate(a);
    if (!p.ok) return { ok: false, message: p.error };
    const lead = await findLead(client, p.id, { lock: true });
    if (!lead) return { ok: false, message: GONE };
    if (!unchanged(lead, a.expect)) return { ok: false, message: STALE };
    // 지금 값에 바꿀 항목만 덮어써 다른 필드는 그대로 둔다
    const r = await updateLead(client, userId, p.id, { ...leadInputOf(lead), ...p.set }, VIA);
    return r.ok ? { ok: true, message: "리드를 수정했습니다", target: leadTarget(r.lead) } : { ok: false, message: r.error };
  },
};

function parseMove(a: Args): { ok: true; id: string; stage: StageId } | { ok: false; error: string } {
  const id = leadIdArg(a);
  if (!id) return { ok: false, error: "리드 id가 올바르지 않습니다" };
  if (!isStage(a.stage)) return { ok: false, error: "단계가 올바르지 않습니다" };
  return { ok: true, id, stage: a.stage };
}

const moveLeadTool: WriteTool = {
  kind: "write",
  label: "리드 단계 이동",
  def: {
    name: "move_lead_stage",
    description: "리드를 다른 단계로 옮기는 실행 계획을 작성합니다(사용자 승인 후 실행). 옮긴 리드는 그 단계의 맨 아래에 놓입니다.",
    parameters: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "리드 id" },
        stage: { type: "string", enum: STAGES.map((s) => s.id), description: STAGES.map((s) => `${s.id}=${s.name}`).join(", ") },
      },
      required: ["leadId", "stage"],
    },
  },
  async prepare(a) {
    const p = parseMove(a);
    if (!p.ok) return { error: p.error };
    const lead = await findLead(pool, p.id);
    if (!lead) return { error: "리드를 찾을 수 없습니다" };
    if (lead.stage === p.stage) return { error: `이미 ${stageName(p.stage)} 단계입니다` };
    return {
      title: "리드 단계 이동",
      changes: [change("stage", lead.stage, p.stage)],
      target: leadTarget(lead),
      affectsLeads: true,
      args: { leadId: lead.id, stage: p.stage, expect: { stage: lead.stage } },
    };
  },
  async execute(client, _userId, a) {
    const p = parseMove(a);
    if (!p.ok) return { ok: false, message: p.error };
    const lead = await findLead(client, p.id, { lock: true });
    if (!lead) return { ok: false, message: GONE };
    if (!unchanged(lead, a.expect)) return { ok: false, message: STALE };
    const r = await moveLead(client, p.id, p.stage, null, VIA);
    return r.ok
      ? { ok: true, message: `${stageName(p.stage)} 단계로 옮겼습니다`, target: leadTarget(r.lead) }
      : { ok: false, message: r.error };
  },
};

/** 삭제 카드에 보여주는(그리고 실행 전에 다시 확인하는) 필드 */
const DELETE_FIELDS = ["company", "contact", "value", "stage", "priority"] as const;

const deleteLeadTool: WriteTool = {
  kind: "write",
  label: "리드 삭제",
  def: {
    name: "delete_lead",
    description: "리드를 삭제하는 실행 계획을 작성합니다(사용자 승인 후 실행). 연결된 미팅 노트도 함께 삭제되며 되돌릴 수 없습니다.",
    parameters: {
      type: "object",
      properties: { leadId: { type: "string", description: "리드 id" } },
      required: ["leadId"],
    },
  },
  async prepare(a) {
    const id = leadIdArg(a);
    if (!id) return { error: "리드 id가 올바르지 않습니다" };
    const lead = await findLead(pool, id);
    if (!lead) return { error: "리드를 찾을 수 없습니다" };
    return {
      title: "리드 삭제",
      changes: DELETE_FIELDS.filter((f) => lead[f] !== "").map((f) => change(f, lead[f], undefined)),
      target: leadTarget(lead),
      danger: true,
      affectsLeads: true,
      args: { leadId: lead.id, expect: Object.fromEntries(DELETE_FIELDS.map((f) => [f, lead[f]])) },
    };
  },
  async execute(client, _userId, a) {
    const id = leadIdArg(a);
    if (!id) return { ok: false, message: "리드 id가 올바르지 않습니다" };
    const lead = await findLead(client, id, { lock: true });
    if (!lead) return { ok: false, message: GONE };
    if (!unchanged(lead, a.expect)) return { ok: false, message: STALE };
    const r = await deleteLead(client, id, VIA);
    return r.ok ? { ok: true, message: "리드를 삭제했습니다" } : { ok: false, message: r.error };
  },
};

/** 전체 도구 (리드 + 회사·연락처) */
export const AGENT_TOOLS: Record<string, AgentTool> = Object.fromEntries(
  [searchLeads, getLead, pipelineSummary, createLeadTool, updateLeadTool, moveLeadTool, deleteLeadTool, ...AGENT_CRM_TOOLS].map((t) => [t.def.name, t])
);
