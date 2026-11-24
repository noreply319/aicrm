import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { assertSafeTestDb, TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./config";

/** 통합 테스트 시작 전 1회: 테스트 DB가 없으면 만들고 schema.sql을 적용한다 (재실행 안전) */
export default async function setup() {
  assertSafeTestDb(TEST_DATABASE_URL);
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);

  const admin = new pg.Client({ connectionString: TEST_ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    // DB 이름은 바인딩할 수 없어 식별자로 인용한다 (assertSafeTestDb로 검사한 값)
    if (!rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }

  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    // vitest·Playwright 모두 web/ 폴더에서 실행된다 (Playwright는 CommonJS로 읽어 import.meta를 못 씀)
    await client.query(await readFile(path.resolve(process.cwd(), "db/schema.sql"), "utf8"));
  } finally {
    await client.end();
  }
}
