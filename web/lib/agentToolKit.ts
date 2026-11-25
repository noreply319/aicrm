import "server-only";
import type { PoolClient } from "pg";
import type { ToolDef } from "./openai";
import type { AgentChange, AgentPlan, AgentTarget, Lead } from "./types";
import { UUID_RE } from "./validate";

/**
 * Sales Agent 도구 공용 타입·헬퍼 (리드 도구 agentTools.ts, 회사·연락처 도구 agentCrmTools.ts).
 * - read: 바로 실행해 결과를 모델에 돌려준다 (개인정보는 넣지 않음)
 * - write: 실행하지 않고 prepare로 실행 계획(카드)을 만든다 → 사용자가 승인하면 execute가 트랜잭션 안에서 실행
 *   prepare가 저장한 args를 execute에서 다시 검증하고(모델·DB 값을 믿지 않음),
 *   args.expect(계획을 만들 때의 현재 값)와 지금 값이 다르면 실행하지 않는다.
 */

export type Args = Record<string, unknown>;

export interface PreparedPlan {
  title: string;
  changes: AgentChange[];
  target?: AgentTarget;
  danger?: boolean;
  notice?: AgentPlan["notice"];
  approveLabel?: string;
  /** 초안 카드: 저장·승인 없이 보여주기만 한다 (메일 초안) */
  draft?: boolean;
  /** 저장할 인자 (execute에 그대로 전달) */
  args: Args;
}

export type ExecResult =
  | {
      ok: true;
      message: string;
      target?: AgentTarget;
      /** 승인 트랜잭션이 커밋된 뒤 실행할 후속 작업 (AI 요약 등 오래 걸리는 일). 돌려준 문장을 결과 메시지에 덧붙인다 */
      after?: () => Promise<string | undefined>;
      /** 실행 뒤 이어서 만들 계획 (예: 견적서 발송 → 리드 단계 이동). 커밋 후 prepare해 새 카드로 보여준다 */
      next?: { tool: string; args: Args }[];
    }
  | { ok: false; message: string };

export interface ReadTool {
  kind: "read";
  def: ToolDef;
  label: string;
  /** userId: 요청한 사용자 (캘린더처럼 본인 계정이 필요한 도구용) */
  run: (args: Args, userId: string) => Promise<unknown>;
}

export interface WriteTool {
  kind: "write";
  def: ToolDef;
  label: string;
  prepare: (args: Args, userId: string) => Promise<PreparedPlan | { error: string }>;
  /** 승인 때 실행. 초안만 보여주는 도구(prepare가 draft)는 없다 */
  execute?: (client: PoolClient, userId: string, args: Args) => Promise<ExecResult>;
}

export type AgentTool = ReadTool | WriteTool;

/** 변경 이력에 남기는 표시 */
export const VIA = { via: "agent" } as const;

/** 계획 이후 대상이 바뀌었을 때 (subject: 조사까지, 예: "리드가") */
export const stale = (subject: string) => `계획을 만든 뒤 ${subject} 바뀌었습니다. 최신 내용으로 다시 요청하세요`;

export const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const has = (a: Args, k: string) => a[k] !== undefined && a[k] !== null;

/** data에서 keys만 */
export const pick = <T extends object, K extends keyof T>(data: T, keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, data[k]])) as Pick<T, K>;

/**
 * 인자 중 허용 항목만 골라 base(지금 값)에 덮어쓰고 API와 같은 파서로 검증 → 검증된 전체 입력 + 넘어온 항목.
 * null은 "비우기"로 본다 (계획에 저장된 null을 승인 때도 그대로 적용하도록 키가 있는지로 고른다).
 */
export function parseFields<T, K extends string>(
  a: Args, fields: readonly K[], base: T | null,
  parse: (body: unknown) => { ok: true; data: T } | { ok: false; error: string }
): { ok: true; data: T; keys: K[] } | { ok: false; error: string } {
  const keys = fields.filter((k) => Object.hasOwn(a, k) && a[k] !== undefined);
  const v = parse({ ...base, ...Object.fromEntries(keys.map((k) => [k, a[k]])) });
  return v.ok ? { ok: true, data: v.data, keys } : v;
}

/** args[key]의 UUID 목록 (UUID가 아닌 값은 버린다) */
export const idListArg = (a: Args, key: string): string[] =>
  Array.isArray(a[key]) ? (a[key] as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : [];

/** args[key]가 UUID면 그 값 */
export const idArg = (a: Args, key: string): string | null =>
  typeof a[key] === "string" && UUID_RE.test(a[key]) ? a[key] : null;

/** 카드 표시용 문자열 (빈 값은 undefined → "없음", 긴 값은 자름) */
export function text(v: unknown): string | undefined {
  if (v === "" || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return undefined;
  const s = Array.isArray(v) ? v.join(", ") : String(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** 값 비교 (태그 같은 배열은 내용으로) */
export const same = (a: unknown, b: unknown) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);

/** args.expect의 값이 지금 값과 모두 같은지 (계획 이후 다른 사람이 바꿨는지 확인). expect가 없으면 false */
export function unchanged<T extends object>(current: T, expect: unknown): boolean {
  if (!expect || typeof expect !== "object") return false;
  return Object.entries(expect as Args).every(([k, v]) => same(current[k as keyof T], v));
}

/** prepare 공통: 바꾸려는 항목 중 실제로 바뀌는 것만 → 저장할 set·expect */
export function diffFields<T extends object, K extends keyof T>(current: T, set: Partial<Pick<T, K>>) {
  const fields = (Object.keys(set) as K[]).filter((f) => !same(set[f], current[f]));
  return {
    fields,
    set: Object.fromEntries(fields.map((f) => [f, set[f]])) as Partial<Pick<T, K>>,
    expect: Object.fromEntries(fields.map((f) => [f, current[f]])),
  };
}

export const leadTarget = (l: Pick<Lead, "id" | "company" | "contact">): AgentTarget => ({
  kind: "lead",
  id: l.id,
  label: l.contact ? `${l.company} · ${l.contact}` : l.company,
});
