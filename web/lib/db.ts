import "server-only";
import { Pool, types } from "pg";
import type { Lead } from "./types";

// DATE는 'YYYY-MM-DD' 문자열 그대로, BIGINT는 number로 받는다.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));

/**
 * 환경별 접속 DB
 *  - 로컬 (npm run dev / start): web/.env.local 의 DATABASE_URL → 로컬 PostgreSQL
 *  - Vercel 배포: Vercel ↔ Supabase 연동이 자동 설정하는 POSTGRES_URL → Supabase
 *    (.env.local 은 git에 올라가지 않으므로 Vercel에는 존재하지 않는다)
 *
 * 로컬이 아니면 SSL을 켠다. URL의 sslmode 파라미터는 pg가 인증서 검증 모드로 해석해
 * Supabase 인증서 체인에서 실패하므로 제거하고 ssl 옵션으로 직접 지정한다.
 */
function connectionConfig() {
  const onVercel = Boolean(process.env.VERCEL);
  const raw = onVercel
    ? process.env.POSTGRES_URL ?? process.env.DATABASE_URL
    : process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!raw) {
    console.error(
      onVercel
        ? "[db] POSTGRES_URL이 없습니다. Vercel 프로젝트에 Supabase 연동을 추가하세요."
        : "[db] DATABASE_URL이 없습니다. web/.env.local을 확인하세요."
    );
    return {};
  }
  const url = new URL(raw);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("supa");
  return {
    connectionString: url.toString(),
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  };
}

const globalForPg = globalThis as unknown as { pgPool?: Pool };

// 개발 모드 핫리로드 시 커넥션 풀이 계속 생성되지 않도록 전역에 보관.
// Vercel(서버리스)에서는 인스턴스가 많이 뜨므로 인스턴스당 연결 수를 작게 유지한다.
export const pool =
  globalForPg.pgPool ??
  new Pool({ ...connectionConfig(), max: process.env.VERCEL ? 3 : 10 });

if (process.env.NODE_ENV !== "production") globalForPg.pgPool = pool;

export const LEAD_COLUMNS = `
  id, company_id AS "companyId", company, contact_id AS "contactId", contact, title, email, phone, value,
  close_date AS "closeDate", stage, priority, notes,
  (extract(epoch FROM created_at) * 1000)::bigint AS "createdAt"`;

export type LeadRow = Lead & { closeDate: string | null };

export const toLead = (r: LeadRow): Lead => ({ ...r, closeDate: r.closeDate ?? "" });
