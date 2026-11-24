import { expect, test } from "@playwright/test";
import { createCompany, createLead, resetDb } from "./helpers";

test.beforeEach(resetDb);

test("리드 등록: 회사를 검색해 드롭다운에서 키보드로 선택한다", async ({ page, request }) => {
  await createCompany(request, { name: "(주)에이스상사", industry: "제조" });
  await createCompany(request, { name: "에이아이랩스" });
  await page.goto("/");
  await page.getByRole("button", { name: "새 리드" }).click();

  const combo = page.getByRole("combobox", { name: "회사" });
  await combo.fill("에이스 상사");
  // 정규화 이름이 같은 회사가 있으면 "새 회사로 생성"은 보이지 않는다
  await expect(page.getByRole("option", { name: /에이스상사/ })).toContainText("일치");
  await expect(page.getByRole("option", { name: /새 회사로 생성/ })).toHaveCount(0);
  await combo.press("Enter");
  await expect(page.getByTestId("company-chip")).toContainText("(주)에이스상사");

  await page.getByPlaceholder("홍길동").fill("김민수");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("새 리드가 등록되었습니다")).toBeVisible();
  await expect(page.locator(".card").filter({ hasText: "(주)에이스상사" })).toBeVisible();
});

test("리드 등록: 회사를 선택하지 않으면 저장되지 않는다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "새 리드" }).click();
  await page.getByPlaceholder("홍길동").fill("김민수");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("회사를 선택하거나 새로 만들어 주세요")).toBeVisible();
});

test("회사 메뉴: 등록 → 상세 → 이 회사로 리드 추가 → 목록 집계", async ({ page }) => {
  await page.goto("/companies");
  await expect(page.getByText("등록된 회사가 없어요")).toBeVisible();
  await page.getByRole("button", { name: "회사 등록" }).first().click();
  await page.getByLabel("회사명 *").fill("블루웨이브");
  await page.getByLabel("업종", { exact: true }).fill("IT");
  await page.getByLabel("규모 (직원 수)").selectOption("11-50");
  await page.getByRole("radio", { name: "A" }).click();
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "블루웨이브" })).toBeVisible();
  await page.getByRole("button", { name: "＋ 이 회사로 리드 추가" }).click();
  await expect(page.getByTestId("company-chip")).toContainText("블루웨이브");
  await page.getByPlaceholder("홍길동").fill("이지은");
  await page.getByPlaceholder("10000000").fill("21500000");
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page.locator(".company-lead").filter({ hasText: "이지은" })).toBeVisible();
  await page.getByRole("link", { name: "← 회사 목록" }).click();
  const row = page.locator(".company-table tbody tr").filter({ hasText: "블루웨이브" });
  await expect(row).toContainText("IT · 11-50명");
  await expect(row).toContainText("₩21,500,000");
});

test("회사명을 바꾸면 칸반 카드의 회사명도 바뀌고, 리드가 있으면 삭제할 수 없다", async ({ page, request }) => {
  const company = await createCompany(request, { name: "한빛물류" });
  await createLead(request, "한빛물류");
  await page.goto(`/companies/${company.id}`);
  await page.getByRole("button", { name: "수정" }).click();
  await expect(page.getByText("연결된 리드 1건이 있어 삭제할 수 없어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "삭제" })).toBeDisabled();
  await page.getByLabel("회사명 *").fill("한빛로지스");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("회사 정보를 수정했습니다")).toBeVisible();

  await page.getByRole("link", { name: "파이프라인" }).click();
  await expect(page.locator(".card").filter({ hasText: "한빛로지스" })).toBeVisible();
});
