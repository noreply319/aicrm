import { expect, test } from "@playwright/test";
import { createContactInLead, createLead, resetDb } from "./helpers";

test.beforeEach(resetDb);

test("새 리드를 등록하면 신규 리드 컬럼에 카드가 생긴다", async ({ page }) => {
  await page.goto("/pipeline");
  await page.getByRole("button", { name: "새 리드" }).click();
  // 없는 회사는 콤보박스에서 바로 생성
  await page.getByRole("combobox", { name: "회사" }).fill("이투이테스트");
  await page.getByRole("option", { name: /"이투이테스트" 새 회사로 생성/ }).click();
  await expect(page.getByTestId("company-chip")).toContainText("이투이테스트");
  await createContactInLead(page, "박서연");
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page.getByText("새 리드가 등록되었습니다")).toBeVisible();
  const column = page.locator(".column").filter({ hasText: "신규 리드" });
  await expect(column.locator(".card").filter({ hasText: "이투이테스트" })).toBeVisible();
  await expect(page.locator(".stat").filter({ hasText: "전체 리드" })).toContainText("1");
});

test("왼쪽 사이드바 메뉴로 파이프라인 ↔ 미팅 노트 이동 (URL 유지)", async ({ page, request }) => {
  await createLead(request, "메뉴테스트");
  await page.goto("/pipeline");
  const sidebar = page.locator(".sidebar");
  await expect(page.locator(".page-title")).toHaveText("파이프라인");
  await sidebar.getByRole("link", { name: "미팅 노트" }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(page.getByText("아직 미팅 노트가 없습니다")).toBeVisible();

  await page.reload();
  await expect(sidebar.getByRole("link", { name: "미팅 노트" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".page-title")).toHaveText("미팅 노트");
  await sidebar.getByRole("link", { name: "파이프라인" }).click();
  await expect(page.locator(".card").filter({ hasText: "메뉴테스트" })).toBeVisible();
});
