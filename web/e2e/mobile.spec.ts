import { expect, test } from "@playwright/test";
import { createLead, resetDb } from "./helpers";

test.beforeEach(resetDb);

test("모바일: 추가 버튼은 플로팅 버튼(FAB), 모달은 전체 화면", async ({ page, request }) => {
  await createLead(request, "모바일상사");
  await page.goto("/meetings");

  // 헤더의 '노트 작성' 버튼 대신 FAB
  await expect(page.locator(".header-actions .btn-primary")).toBeHidden();
  const fab = page.getByRole("button", { name: "노트 작성" });
  await expect(fab).toBeVisible();
  await fab.click();

  // 열림 애니메이션(scale 0.98)이 끝난 뒤 화면 폭 전체를 차지해야 한다
  const modal = page.locator(".note-modal");
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = await modal.boundingBox();
      return box ? Math.round(box.x) === 0 && Math.round(box.width) === viewport.width : false;
    })
    .toBe(true);
  await expect(page.getByRole("button", { name: "녹음 시작" })).toBeVisible();
});

test("모바일: 하단 탭 오른쪽 프로필 버튼에서 설정 모달을 연다", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".sidebar").getByRole("link", { name: "설정" })).toHaveCount(0);
  await page.locator(".user-btn").click();
  await page.getByRole("menuitem", { name: "설정" }).click();
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
});

test("모바일: 기기가 다크 모드여도 데스크톱과 같은 밝은 배경", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 247, 246)");
});

test("모바일: 파이프라인은 단계 탭 + 선택한 단계의 리드 세로 목록", async ({ page, request }) => {
  await createLead(request, "신규상사", "new");
  await createLead(request, "니즈상사", "qualified");
  await page.goto("/");

  const tabs = page.getByRole("tablist", { name: "단계" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /신규 리드/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".card").filter({ hasText: "신규상사" })).toBeVisible();
  await expect(page.locator(".card").filter({ hasText: "니즈상사" })).toBeHidden();

  await tabs.getByRole("tab", { name: /니즈 확인/ }).click();
  await expect(page.locator(".card").filter({ hasText: "니즈상사" })).toBeVisible();
  await expect(page.locator(".card").filter({ hasText: "신규상사" })).toBeHidden();

  // 세로 목록: 선택한 단계 컬럼이 화면 폭을 채운다
  const col = page.locator(".column").filter({ hasText: "니즈상사" });
  const box = (await col.boundingBox())!;
  expect(box.width).toBeGreaterThan(page.viewportSize()!.width - 40);
});

test("모바일: 하단 탭 맨 왼쪽 AI 메뉴로 AI Assistant 채팅을 열고, 다른 메뉴로 가면 닫힌다", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "메뉴" });
  const ai = nav.getByRole("button", { name: "AI" });
  // 맨 왼쪽
  const first = nav.locator(".side-link").first();
  await expect(first).toHaveText("AI");
  await expect(ai).toHaveAttribute("aria-pressed", "false");

  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await expect(panel).toBeHidden();
  await ai.click();
  await expect(panel).toBeVisible();
  await expect(ai).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByPlaceholder(/리드에 대해 질문하세요/)).toBeVisible();

  await nav.getByRole("link", { name: "미팅 노트" }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(panel).toBeHidden();
});

test("모바일 계약서: 2단 대신 대화/문서 전환, 답변하면 문서 탭에 표시", async ({ page, request }) => {
  await request.post("/api/templates/defaults");
  await page.goto("/contracts");
  await page.getByRole("button", { name: /SaaS 서비스 이용 계약서/ }).click();
  await page.getByRole("button", { name: "리드 없이 작성" }).click();
  await expect(page.getByText("회사명을 알려주세요.")).toBeVisible();
  await expect(page.locator(".paper")).toBeHidden(); // 대화 화면에서는 문서를 숨김

  const input = page.getByPlaceholder(/답변 입력/);
  await input.fill("블루웨이브");
  await input.press("Enter");
  await expect(page.locator(".pane-dot")).toBeVisible();
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/9-mobile-chat.png` });

  await page.getByRole("tab", { name: /📄 문서/ }).click();
  await expect(page.locator('.paper [data-key="회사명"]').first()).toHaveText("블루웨이브");
  await expect(page.getByRole("region", { name: "문서 작성 Assistant" })).toBeHidden();
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/10-mobile-doc.png` });
});
