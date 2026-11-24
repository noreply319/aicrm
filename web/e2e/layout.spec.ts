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
