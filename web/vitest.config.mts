import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 테스트 실행기 설정
 *  - unit: 순수 함수·외부 API 응답 처리 (DB·네트워크 없음)
 *  - integration: Route Handler를 로컬 테스트 DB(ai_crm_test)에 직접 호출
 * e2e는 Playwright(playwright.config.ts)가 따로 실행한다.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": r("./"),
      // "server-only"는 서버 컴포넌트 밖에서 import하면 예외를 던진다 → 테스트에서는 빈 모듈로 대체
      "server-only": r("./node_modules/server-only/empty.js"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["test/setup/global-db.ts"],
          setupFiles: ["test/setup/env.ts"],
          // 같은 DB를 쓰므로 파일을 순서대로 실행
          fileParallelism: false,
        },
      },
    ],
  },
});
