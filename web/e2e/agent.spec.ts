import { expect, test, type Page } from "@playwright/test";
import { createLead, createMovePlan, resetDb } from "./helpers";

test.beforeEach(resetDb);

/** /api/assistant 스트림을 가짜 NDJSON으로 대체 (OpenAI 호출 없음). 계획은 테스트 DB에 미리 저장해 승인은 실제 서버로 간다 */
async function fakeAgentStream(page: Page, plan: unknown) {
  await page.route("**/api/assistant", async (route) => {
    const events = [
      { type: "step", step: { id: "context", label: "CRM 데이터 확인", status: "running" } },
      { type: "step", step: { id: "context", label: "CRM 데이터 확인", status: "done" } },
      { type: "step", step: { id: "tool-1", label: "실행 계획 작성: 리드 단계 이동", status: "done", detail: "승인 대기" } },
      { type: "reply", content: "오션핀테크 리드를 협상 단계로 옮기는 계획입니다. 확인 후 승인하세요." },
      { type: "plan", plan },
      { type: "done" },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  });
}

test("Sales Agent 통합: 메뉴 없음, /agent는 첫 화면(AI Assistant)으로", async ({ page }) => {
  await page.goto("/agent");
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: "AI Assistant에게 질문·요청" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "Sales Agent" })).toHaveCount(0);
});

test("AI Assistant: 수정 요청 → 계획 취소 + 입력창에 안내 문구", async ({ page, request }) => {
  const lead = await createLead(request, "오션핀테크", "qualified");
  await fakeAgentStream(page, await createMovePlan(lead, "qualified", "negotiation"));

  await page.goto("/");
  const input = page.getByRole("textbox", { name: "AI Assistant에게 질문·요청" });
  await input.fill("오션핀테크 리드를 협상 단계로 옮겨줘");
  await input.press("Enter");

  const card = page.getByRole("region", { name: "실행 계획: 리드 단계 이동" });
  await card.getByRole("button", { name: "수정 요청" }).click();
  await expect(card.getByText("취소됨")).toBeVisible();
  await expect(input).toHaveValue("「리드 단계 이동」 계획 수정: ");
  await expect(input).toBeFocused();
  // 취소한 계획은 실행되지 않는다
  const leads = await (await request.get("/api/leads")).json();
  expect(leads.find((l: { id: string }) => l.id === lead.id).stage).toBe("qualified");
});

test("AI Assistant: 취소하면 실행하지 않고 보드도 그대로", async ({ page, request }) => {
  const lead = await createLead(request, "오션핀테크", "qualified");
  await fakeAgentStream(page, await createMovePlan(lead, "qualified", "negotiation"));

  await page.goto("/");
  const input = page.getByRole("textbox", { name: "AI Assistant에게 질문·요청" });
  await input.fill("오션핀테크 리드를 협상 단계로 옮겨줘");
  await input.press("Enter");

  const card = page.getByRole("region", { name: "실행 계획: 리드 단계 이동" });
  await card.getByRole("button", { name: "취소", exact: true }).click();
  await expect(card.getByText("취소됨")).toBeVisible();
  await expect(card.getByRole("button", { name: "승인" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "파이프라인" }).click();
  await expect(page.locator(".column").filter({ hasText: "니즈 확인" }).locator(".card").filter({ hasText: "오션핀테크" })).toBeVisible();
});
