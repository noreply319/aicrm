// 스키마 생성 + 샘플 데이터 삽입:  npm run db:init
import { readFile } from "node:fs/promises";
import pg from "pg";

const raw = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!raw) {
  console.error("DATABASE_URL is not set (web/.env.local 확인)");
  process.exit(1);
}

// lib/db.ts와 동일한 규칙: 로컬이 아니면 SSL, sslmode 파라미터는 제거
const url = new URL(raw);
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
url.searchParams.delete("sslmode");
url.searchParams.delete("supa");

const client = new pg.Client({
  connectionString: url.toString(),
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});
await client.connect();
try {
  for (const file of ["schema.sql", "seed.sql"]) {
    const sql = await readFile(new URL(file, import.meta.url), "utf8");
    await client.query(sql);
    console.log(`✓ ${file}`);
  }
  const { rows } = await client.query("SELECT count(*)::int AS n FROM leads");
  console.log(`leads: ${rows[0].n} rows`);
} finally {
  await client.end();
}
