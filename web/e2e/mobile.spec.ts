import { expect, test } from "@playwright/test";
import { createCompany, createLead, hideDevIndicator, resetDb } from "./helpers";

test.beforeEach(resetDb);
test.beforeEach(({ page }) => hideDevIndicator(page));

test("모바일: 추가 버튼은 플로팅 버튼(FAB), 모달은 전체 화면", async ({ page, request }) => {
  await createLead(request, "모바일상사");
  await page.goto("/meetings");

  // 헤더의 '노트 작성' 버튼 대신 FAB
  await expect(page.locator(".header-actions .btn-primary")).toBeHidden();
  // 빈 목록 안내의 '노트 작성' 버튼과 구분: 플로팅 버튼(.fab)
  const fab = page.locator(".fab");
  await expect(fab).toHaveAccessibleName("노트 작성");
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

test("모바일: 상단 왼쪽 햄버거 버튼으로 전체 화면 메뉴를 열고, 메뉴를 고르면 닫힌다", async ({ page }) => {
  await page.goto("/");
  const menu = page.locator(".sidebar");
  // 하단 탭 바 없음: 평소에는 메뉴가 보이지 않는다
  await expect(menu).toBeHidden();

  const open = page.getByRole("button", { name: "메뉴 열기" });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  // 상단 바 맨 왼쪽
  const openBox = (await open.boundingBox())!;
  expect(openBox.x).toBeLessThan(20);
  await open.click();
  await expect(open).toHaveAttribute("aria-expanded", "true");

  // 화면 전체를 덮는다
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return box && Math.round(box.x) === 0 && Math.round(box.y) === 0 && Math.round(box.width) === viewport.width && Math.round(box.height) === viewport.height;
    })
    .toBe(true);
  await expect(menu.getByRole("link", { name: "파이프라인" })).toHaveAttribute("aria-current", "page");

  await menu.getByRole("link", { name: "미팅 노트" }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(menu).toBeHidden();
  await expect(page.locator(".page-title")).toHaveText("미팅 노트");

  // 닫기 버튼·Esc로도 닫힌다
  await open.click();
  await page.getByRole("button", { name: "메뉴 닫기" }).click();
  await expect(menu).toBeHidden();
  await open.click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("모바일: 메뉴의 프로필 버튼에서 설정 모달을 연다 (메뉴는 닫힌다)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.locator(".sidebar").getByRole("link", { name: "설정" })).toHaveCount(0);
  await page.locator(".user-btn").click();
  await page.getByRole("menuitem", { name: "설정" }).click();
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
  await expect(page.locator(".sidebar")).toBeHidden();
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

  // 단계 탭 줄은 가로로만 스크롤: 세로로 스크롤할 여지가 없어야 끌어도 위아래로 흔들리지 않는다
  const scroll = await tabs.evaluate((el) => {
    el.scrollTop = 10; // 세로 스크롤이 가능하면 값이 남는다
    return { top: el.scrollTop, overflowY: getComputedStyle(el).overflowY, wide: el.scrollWidth > el.clientWidth };
  });
  expect(scroll).toEqual({ top: 0, overflowY: "hidden", wide: true });

  // 세로 목록: 선택한 단계 컬럼이 화면 폭을 채운다
  const col = page.locator(".column").filter({ hasText: "니즈상사" });
  const box = (await col.boundingBox())!;
  expect(box.width).toBeGreaterThan(page.viewportSize()!.width - 40);
});

test("모바일: AI Assistant 채팅은 화면 전체 폭·높이를 쓰고, 다른 메뉴로 가면 닫힌다", async ({ page }) => {
  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await expect(panel).toBeHidden();

  // 상단 바의 AI 버튼으로 연다
  await page.getByRole("button", { name: "AI Assistant" }).click();
  await expect(panel).toBeVisible();
  const viewport = page.viewportSize()!;
  const box = (await panel.boundingBox())!;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.width)).toBe(viewport.width);
  expect(Math.round(box.height)).toBe(viewport.height);
  await expect(panel.getByPlaceholder(/리드에 대해 질문하세요/)).toBeVisible();

  // 뒤로 가기로 닫기
  await panel.getByRole("button", { name: "채팅 닫기" }).click();
  await expect(panel).toBeHidden();

  // 메뉴의 AI Assistant 항목으로 열고, 다른 메뉴로 가면 닫힌다
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.locator(".sidebar").getByRole("button", { name: "AI Assistant" }).click();
  await expect(panel).toBeVisible();
  await expect(page.locator(".sidebar")).toBeHidden();
  await panel.getByRole("button", { name: "채팅 닫기" }).click();
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.locator(".sidebar").getByRole("link", { name: "미팅 노트" }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(panel).toBeHidden();
});

test("모바일: 화면마다 가로로 넘치는 요소가 없다 (360px)", async ({ page, request }) => {
  // 내용이 넘치면 모바일 브라우저는 레이아웃 폭 자체를 넓혀(innerWidth 증가) 화면 전체·모달이 오른쪽으로 잘린다 → 기기 폭과 비교
  await page.setViewportSize({ width: 360, height: 800 });
  const company = await createCompany(request, { name: "블루웨이브테크놀로지스" });
  await request.post("/api/leads", { data: { companyId: company.id, value: 1_250_000_000 } });
  for (const path of ["/", "/companies", `/companies/${company.id}`, "/contacts", "/meetings", "/calendar", "/contracts"]) {
    await page.goto(path);
    await expect(page.locator(".page-title")).toBeVisible();
    const width = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.scrollingElement!.scrollWidth }));
    expect(width, path).toEqual({ inner: 360, scroll: 360 });
  }
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
