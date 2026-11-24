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

  await page.getByRole("tab", { name: /문서/ }).click();
  await expect(page.locator('.paper [data-key="회사명"]').first()).toHaveText("블루웨이브");
  await expect(page.getByRole("region", { name: "문서 작성 Assistant" })).toBeHidden();
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/10-mobile-doc.png` });
});
