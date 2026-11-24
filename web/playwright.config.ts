import { defineConfig, devices } from "@playwright/test";
import { E2E_SESSION_TOKEN, E2E_USER_EMAIL, TEST_DATABASE_URL } from "./test/setup/config";

// 다른 워크트리가 3100을 쓰고 있으면 E2E_PORT로 바꿔 실행 (예: E2E_PORT=3101 npm run test:e2e)
const PORT = Number(process.env.E2E_PORT) || 3100;

/**
 * e2e 테스트: 테스트 DB(ai_crm_test)에 연결한 개발 서버(3100)를 띄워 실제 브라우저로 확인한다.
 *  - 브라우저는 설치된 Chrome 사용 (별도 다운로드 없음)
 *  - OpenAI 호출(전사 등)은 브라우저에서 page.route로 가짜 응답
 *  - 같은 DB를 쓰므로 순서대로 1개씩 실행
 *  - 로그인: global-setup이 테스트 사용자 세션을 만들고, 모든 페이지·API 요청에 세션 쿠키를 붙인다
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    trace: "retain-on-failure",
    storageState: {
      cookies: [
        {
          name: "crm_session", value: E2E_SESSION_TOKEN, domain: "localhost", path: "/",
          expires: -1, httpOnly: true, secure: false, sameSite: "Lax",
        },
      ],
      origins: [],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome" }, testIgnore: /mobile\.spec/ },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome" }, testMatch: /mobile\.spec/ },
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/leads`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      OPENAI_API_KEY: "e2e-test-key",
      ALLOWED_EMAILS: E2E_USER_EMAIL,
    },
  },
});
