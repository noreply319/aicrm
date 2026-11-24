import { expect, test } from "@playwright/test";
import { createLead, fakeMicrophone, fakeTranscribe, resetDb } from "./helpers";

test.beforeEach(resetDb);

test("붙여넣기로 노트를 작성해 리드에 연결하면, 카드 배지와 리드 상세에 보인다", async ({ page, request }) => {
  const lead = await createLead(request, "한빛소프트");
  await page.goto("/meetings");
  await page.getByRole("button", { name: "노트 작성" }).first().click();

  await page.getByRole("tab", { name: /직접 입력/ }).click();
  await page.getByPlaceholder("회의록이나 메모를 입력하거나 붙여넣으세요.").fill("1. 50석 견적 요청\n2. 보안 심사 필요");
  await page.locator(".note-form select").selectOption(lead.id);
  await expect(page.getByPlaceholder("예: 한빛소프트 미팅")).toHaveValue("한빛소프트 미팅"); // 기본 제목
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page.getByText("미팅 노트가 저장되었습니다")).toBeVisible();
  const item = page.locator(".note-item").filter({ hasText: "한빛소프트 미팅" });
  await expect(item).toContainText("50석 견적 요청");
  await expect(item).toContainText("붙여넣기");

  // 파이프라인: 카드 배지 → 리드 상세의 미팅 노트 탭
  await page.getByRole("link", { name: "파이프라인" }).click();
  const card = page.locator(".card").filter({ hasText: "한빛소프트" });
  await expect(card.locator(".note-badge")).toHaveText("📝 1");
  await card.click();
  await page.getByRole("tab", { name: "미팅 노트 (1)" }).click();
  await expect(page.locator(".lead-notes .note-item")).toContainText("한빛소프트 미팅");
});

test("녹음이 끝나면 리드 없이 자동 저장되고(화자 구분), 나중에 리드를 지정할 수 있다", async ({ page, request }) => {
  const lead = await createLead(request, "오션핀테크");
  await fakeMicrophone(page);
  await fakeTranscribe(page);

  await page.goto("/meetings");
  await page.getByRole("button", { name: "노트 작성" }).first().click();
  await page.getByRole("button", { name: "녹음 시작" }).click();
  await expect(page.locator(".rec-state")).toHaveText("녹음 중");
  await page.waitForTimeout(3500);
  await page.getByRole("button", { name: "■ 녹음 종료" }).click();

  // 구간 전사 → 화자 이름 부여 → 자동 저장
  await expect(page.locator(".autosave-note")).toContainText("자동 저장되었습니다");
  const body = page.locator(".note-body-input");
  await expect(body).toHaveValue(/화자 1: 안녕하세요, 견적 관련 미팅입니다\.\n화자 2: 네 반갑습니다\./);

  const saved = await (await request.get("/api/meetings")).json();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ leadId: null, source: "recording" });

  // 화자 이름 바꾸기 → 본문 반영
  const speaker = page.locator(".speaker-input").first();
  await speaker.fill("김민수");
  await speaker.press("Enter");
  await expect(body).toHaveValue(/^김민수: 안녕하세요/m);

  // 리드 지정 후 저장
  await page.locator(".note-form select").selectOption(lead.id);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("미팅 노트가 수정되었습니다")).toBeVisible();
  const after = await (await request.get("/api/meetings")).json();
  expect(after[0].leadId).toBe(lead.id);
});

test("리드 미지정 노트는 목록에 표시되고 필터로 모아 볼 수 있다", async ({ page, request }) => {
  const lead = await createLead(request, "그린에너지");
  const note = (data: object) => request.post("/api/meetings", {
    data: { title: "노트", metAt: "2026-11-24T05:00:00.000Z", body: "본문", ...data },
  });
  await note({ title: "연결된 노트", leadId: lead.id });
  await note({ title: "미지정 노트", leadId: null });

  await page.goto("/meetings");
  await expect(page.locator(".note-item").filter({ hasText: "미지정 노트" }).locator(".unassigned-pill")).toBeVisible();
  await page.getByLabel("리드 필터").selectOption({ label: "리드 미지정 (1)" });
  await expect(page.locator(".note-item")).toHaveCount(1);
  await expect(page.locator(".meetings-count")).toContainText("총 1건");
});
