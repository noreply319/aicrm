// 스키마 생성 + 샘플 데이터 삽입:  npm run db:init
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (web/.env.local 확인)");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
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
