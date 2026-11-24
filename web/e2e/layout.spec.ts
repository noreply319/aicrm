import { expect, test } from "@playwright/test";
import { resetDb } from "./helpers";

test.beforeEach(resetDb);

test("왼쪽 메뉴 접기/펼치기는 아이콘 레일로 바뀌고 새로고침 후에도 유지된다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
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
  await page.goto("/");
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

test("구글 연동 후 돌아오는 /settings 주소는 설정 모달로 열리고, 닫으면 파이프라인으로 간다", async ({ page }) => {
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
    await page.goto("/");
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
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "단계" })).toBeHidden();
  await expect(page.locator(".column")).toHaveCount(7);
  for (const c of await page.locator(".column").all()) await expect(c).toBeVisible();
});

test("데스크톱에는 사이드바 AI 메뉴가 없다 (상단 바 버튼·오른쪽 패널 사용)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "메뉴" }).getByRole("button", { name: "AI" })).toBeHidden();
  await expect(page.getByRole("button", { name: "AI Assistant" })).toBeVisible();
  // 햄버거 메뉴 버튼은 모바일 전용
  await expect(page.getByRole("button", { name: "메뉴 열기" })).toBeHidden();
});
