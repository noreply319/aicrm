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
  await warmUp();
}

/**
 * dev 서버는 화면을 처음 열 때 컴파일해 첫 테스트가 시간 초과로 실패할 수 있다 → 주요 화면을 미리 한 번씩 연다.
 * 서버가 아직 안 떠 있거나 실패해도 테스트는 그대로 진행한다.
 */
async function warmUp() {
  const port = process.env.E2E_PORT ?? "3100";
  const headers = { cookie: `crm_session=${E2E_SESSION_TOKEN}` };
  for (const path of ["/", "/pipeline", "/companies", "/contacts", "/meetings", "/contracts", "/calendar"]) {
    await fetch(`http://localhost:${port}${path}`, { headers, signal: AbortSignal.timeout(120_000) }).catch(() => undefined);
  }
}
