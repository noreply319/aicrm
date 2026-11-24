import { createHash } from "node:crypto";
import pg from "pg";
import setupDb from "../test/setup/global-db";
import { assertSafeTestDb, E2E_SESSION_TOKEN, E2E_USER_EMAIL, TEST_DATABASE_URL } from "../test/setup/config";

/**
 * e2e 시작 전 1회: 테스트 DB 준비 + 로그인한 테스트 사용자 세션 생성.
 * 세션 id는 앱과 같은 방식(토큰의 SHA-256 base64url)으로 저장한다 (lib/auth.ts).
 */
export default async function setup() {
  await setupDb();
  assertSafeTestDb(TEST_DATABASE_URL);
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO users (google_sub, email, name) VALUES ('e2e-test-user', $1, 'E2E 테스트')
       ON CONFLICT (google_sub) DO UPDATE SET email = $1 RETURNING id`,
      [E2E_USER_EMAIL]
    );
    await c.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')
       ON CONFLICT (id) DO UPDATE SET expires_at = now() + interval '1 day'`,
      [createHash("sha256").update(E2E_SESSION_TOKEN).digest("base64url"), rows[0].id]
    );
  } finally {
    await c.end();
  }
}
