import "server-only";
import { Pool, types } from "pg";
import type { Lead } from "./types";

// DATE는 'YYYY-MM-DD' 문자열 그대로, BIGINT는 number로 받는다.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));

const globalForPg = globalThis as unknown as { pgPool?: Pool };

// 개발 모드 핫리로드 시 커넥션 풀이 계속 생성되지 않도록 전역에 보관
export const pool =
  globalForPg.pgPool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

if (process.env.NODE_ENV !== "production") globalForPg.pgPool = pool;

export const LEAD_COLUMNS = `
  id, company, contact, title, email, phone, value,
  close_date AS "closeDate", stage, priority, notes,
  (extract(epoch FROM created_at) * 1000)::bigint AS "createdAt"`;

export type LeadRow = Lead & { closeDate: string | null };

export const toLead = (r: LeadRow): Lead => ({ ...r, closeDate: r.closeDate ?? "" });
