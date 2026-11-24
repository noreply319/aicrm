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
} catch (e) {
  // schema.sql은 한 번에 실행되므로 실패하면 전체가 롤백된다 (일부만 적용되지 않음)
  if (e?.code === "42501") {
    console.error(
      "✗ 권한 부족: 일부 테이블의 소유자가 DATABASE_URL 사용자가 아닙니다.\n" +
        "  확인: psql -d ai_crm -c \"select tablename, tableowner from pg_tables where schemaname='public'\"\n" +
        "  해결: 해당 테이블을 만든 계정으로 ALTER TABLE <테이블> OWNER TO crm_app; 실행 후 다시 npm run db:init"
    );
  }
  throw e;
} finally {
  await client.end();
}
