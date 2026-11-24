import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // PDF 한글 폰트는 fs로 읽으므로 배포 번들에 직접 포함시킨다 (lib/pdf.ts)
  outputFileTracingIncludes: {
    "/api/documents/**": ["./assets/fonts/**/*"],
  },
};

export default nextConfig;
