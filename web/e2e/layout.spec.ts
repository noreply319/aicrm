import { expect, test } from "@playwright/test";
import { resetDb } from "./helpers";

test.beforeEach(resetDb);

test("왼쪽 메뉴 접기/펼치기는 아이콘 레일로 바뀌고 새로고침 후에도 유지된다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/pipeline");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveCSS("width", "232px");

  await page.getByRole("button", { name: "메뉴 접기" }).click();
  await expect(sidebar).toHaveCSS("width", "72px");
  // 접혀도 메뉴 이동은 그대로 (라벨은 스크린리더 이름으로 남음)
  await sidebar.getByRole("link", { name: "미팅 노트" }).click();
  await expect(page).toHaveURL(/\/meetings$/);

  await page.reload();
  await expect(sidebar).toHaveCSS("width", "72px");
  await page.getByRole("button", { name: "메뉴 펼치기" }).click();
  await expect(sidebar).toHaveCSS("width", "232px");
});

test("AI Assistant는 오른쪽으로 숨기고 가장자리 탭으로 다시 연다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/pipeline");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await expect(panel).toBeVisible();

  await page.getByRole("button", { name: "Assistant 숨기기" }).click();
  await expect(panel).toBeHidden();
  const handle = page.getByRole("button", { name: "AI Assistant 보이기" });
  await expect(handle).toBeVisible();

  await page.reload();
  await expect(panel).toBeHidden();
  await handle.click();
  await expect(panel).toBeVisible();
  await expect(handle).toBeHidden();
});

test("설정은 사이드 메뉴에 없고, 프로필 메뉴의 설정을 누르면 가운데 모달로 열린다", async ({ page }) => {
  await page.goto("/meetings");
  await expect(page.locator(".sidebar").getByRole("link", { name: "설정" })).toHaveCount(0);

  await page.locator(".user-btn").click();
  await page.getByRole("menuitem", { name: "설정" }).click();
  const dialog = page.getByRole("dialog", { name: "설정" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Google 캘린더" })).toBeVisible();
  // 뒤 화면은 그대로
  await expect(page).toHaveURL(/\/meetings$/);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("구글 연동 후 돌아오는 /settings 주소는 설정 모달로 열리고, 닫으면 첫 화면(AI Assistant)으로 간다", async ({ page }) => {
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "설정" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "닫기" }).last().click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
});

for (const width of [1440, 800]) {
  test(`메인 화면은 AI 창과 겹치지 않고, AI 창을 숨기거나 메뉴를 접으면 남은 폭만큼 넓어진다 (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/pipeline");
    const main = page.locator(".workspace-main");
    const panel = page.locator(".assistant");
    const sidebar = page.locator(".sidebar");
    const box = async (l: typeof main) => (await l.boundingBox())!;

    // 나란히: 메인 오른쪽 끝 = AI 창 왼쪽 끝, 메인 왼쪽 끝 = 메뉴 오른쪽 끝
    await expect(panel).toBeVisible();
    await expect.poll(async () => Math.round((await box(main)).x + (await box(main)).width - (await box(panel)).x)).toBe(0);
    expect(Math.round((await box(main)).x - ((await box(sidebar)).x + (await box(sidebar)).width))).toBe(0);

    // AI 창 숨김 → 메인이 화면 오른쪽 끝까지
    await page.getByRole("button", { name: "Assistant 숨기기" }).click();
    await expect.poll(async () => Math.round((await box(main)).x + (await box(main)).width)).toBe(width);

    // (넓은 화면) 메뉴 접기 → 메인이 메뉴가 줄어든 만큼 넓어짐
    if (width > 1024) {
      await page.getByRole("button", { name: "메뉴 접기" }).click();
      await expect.poll(async () => Math.round((await box(main)).width)).toBe(width - 72);
    }
  });
}

test("데스크톱 파이프라인은 단계 탭 없이 모든 단계 칸반", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/pipeline");
  await expect(page.getByRole("tablist", { name: "단계" })).toBeHidden();
  await expect(page.locator(".column")).toHaveCount(7);
  for (const c of await page.locator(".column").all()) await expect(c).toBeVisible();
});

test("첫 화면(/)은 메인 영역 전체를 쓰는 AI Assistant 대화 (숨기기 버튼 없음)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".page-title")).toHaveText("AI Assistant");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "Assistant 숨기기" })).toHaveCount(0);
  const sidebar = (await page.locator(".sidebar").boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(Math.round(box.x - (sidebar.x + sidebar.width))).toBe(0);
  expect(Math.round(box.x + box.width)).toBe(1440);
});

test("AI Assistant 견적서 탭: 견적서 템플릿만 보여주고, 탭을 바꿔도 대화가 남는다", async ({ page, request }) => {
  await request.post("/api/templates/defaults");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await panel.getByRole("tab", { name: "견적서" }).click();
  const quote = panel.getByRole("region", { name: "견적서 작성" });
  await expect(quote.getByText("안녕하세요! 어떤 문서를 만들까요?")).toBeVisible();
  await expect(quote.locator(".tpl-btn").first()).toBeVisible();
  for (const b of await quote.locator(".tpl-btn").all()) await expect(b).toContainText("견적서");

  await quote.locator(".tpl-btn").first().click();
  await expect(quote.getByRole("button", { name: "리드 없이 작성" })).toBeVisible();
  await panel.getByRole("tab", { name: "일반 대화" }).click();
  await expect(quote).toBeHidden();
  await panel.getByRole("tab", { name: "견적서" }).click();
  await expect(quote.getByRole("button", { name: "리드 없이 작성" })).toBeVisible();
  await quote.getByRole("button", { name: "문서 보기" }).click();
  await expect(page.getByRole("dialog", { name: "견적서 미리보기" }).locator(".paper")).toBeVisible();
});

test("데스크톱에는 햄버거 메뉴가 없고, 파이프라인에서는 상단 바 AI Assistant 버튼을 쓴다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/pipeline");
  await expect(page.getByRole("button", { name: "메뉴 열기" })).toBeHidden();
  await expect(page.getByRole("button", { name: "AI Assistant", exact: true })).toBeVisible();
});
