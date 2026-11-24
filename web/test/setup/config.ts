/**
 * 통합 테스트 DB 접속 정보 (로컬 PostgreSQL)
 *  - TEST_DATABASE_URL: 테스트 전용 DB (매 테스트마다 데이터를 비운다 — 운영·개발 DB를 넣지 말 것)
 *  - TEST_ADMIN_DATABASE_URL: 테스트 DB를 만들 수 있는 계정으로 접속할 DB (기본: 로컬 postgres DB)
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/ai_crm_test";
export const TEST_ADMIN_DATABASE_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://localhost:5432/postgres";

/** 실수로 원격·개발 DB를 비우지 않도록: 로컬 + 이름에 "test"가 들어간 DB만 허용 */
export function assertSafeTestDb(url: string) {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (!local || !u.pathname.toLowerCase().includes("test")) {
    throw new Error(`테스트 DB는 로컬의 *test* DB만 사용할 수 있습니다: ${u.hostname}${u.pathname}`);
  }
}
