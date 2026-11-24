import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // e2e(Playwright)에서는 개발 도구 버튼(왼쪽 아래)이 모바일 하단 탭의 AI 메뉴를 가려 클릭을 막으므로 숨긴다
  ...(process.env.E2E_HIDE_DEV_INDICATOR ? { devIndicators: false as const } : {}),
  // PDF 한글 폰트는 fs로 읽으므로 배포 번들에 직접 포함시킨다 (lib/pdf.ts)
  outputFileTracingIncludes: {
    "/api/documents/**": ["./assets/fonts/**/*"],
  },
};

export default nextConfig;
