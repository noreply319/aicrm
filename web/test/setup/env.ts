import { TEST_DATABASE_URL } from "./config";

// lib/db.ts가 import될 때 이 값으로 커넥션 풀을 만든다 (반드시 앱 코드보다 먼저 실행)
process.env.DATABASE_URL = TEST_DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
// OpenAI는 통합 테스트에서 fetch를 가로채 가짜 응답을 준다
process.env.OPENAI_API_KEY = "test-key";
