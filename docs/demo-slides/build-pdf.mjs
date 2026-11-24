// slides.html → Pipeline-CRM-demo.pdf (1920×1080, 한 슬라이드 = 한 페이지)
// 실행: 프로젝트 루트에서  node docs/demo-slides/build-pdf.mjs   (web/node_modules의 Playwright + 설치된 Chrome 사용)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
// web/node_modules에 Playwright가 없으면 PLAYWRIGHT_FROM=<다른 web 폴더> 로 지정
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM ?? path.join(dir, "../../web"), "package.json"));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(path.join(dir, "slides.html")).href, { waitUntil: "load" });
await page.pdf({ path: path.join(dir, "Pipeline-CRM-demo.pdf"), width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log("✓ docs/demo-slides/Pipeline-CRM-demo.pdf");
