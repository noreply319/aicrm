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
