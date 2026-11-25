import { expect, test, type Page } from "@playwright/test";
import { createLead, createMovePlan, resetDb } from "./helpers";

test.beforeEach(resetDb);

/** /api/agent 스트림을 가짜 NDJSON으로 대체 (OpenAI 호출 없음). 계획은 테스트 DB에 미리 저장해 승인은 실제 서버로 간다 */
async function fakeAgentStream(page: Page, plan: unknown) {
  await page.route("**/api/agent", async (route) => {
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

test("Sales Agent: 메뉴 이동 → 요청 → 진행 단계·답변·실행 계획 카드 → 대상 링크 → 승인 → 리드 이동", async ({ page, request }) => {
  const lead = await createLead(request, "오션핀테크", "qualified");
  const plan = await createMovePlan(lead, "qualified", "negotiation");
  await fakeAgentStream(page, plan);

  await page.goto("/pipeline");
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "Sales Agent" }).click();
  // 처음 여는 /agent는 dev 서버가 컴파일하느라 오래 걸릴 수 있다
  await expect(page).toHaveURL(/\/agent$/, { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Sales Agent" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("무엇을 도와드릴까요?")).toBeVisible();
  // 이 화면에서는 조회형 Assistant(헤더 버튼·다시 열기 탭)를 숨긴다
  await expect(page.getByRole("button", { name: /Assistant/ })).toHaveCount(0);

  const input = page.getByRole("textbox", { name: "Sales Agent에게 요청" });
  await input.fill("오션핀테크 리드를 협상 단계로 옮겨줘");
  await input.press("Enter");
  await expect(page.locator(".bubble-user")).toHaveText("오션핀테크 리드를 협상 단계로 옮겨줘");
  const steps = page.getByRole("list", { name: "진행 단계" });
  await expect(steps.getByText("CRM 데이터 확인")).toBeVisible();
  await expect(steps.getByText("승인 대기")).toBeVisible();
  await expect(page.getByText("확인 후 승인하세요.")).toBeVisible();

  const card = page.getByRole("region", { name: "실행 계획: 리드 단계 이동" });
  await expect(card.getByText("승인 대기")).toBeVisible();
  await expect(card.getByRole("cell", { name: "니즈 확인" })).toBeVisible();
  await expect(card.getByRole("cell", { name: "협상" })).toBeVisible();

  // 대상 링크 → 리드 모달
  await card.getByRole("button", { name: "리드 열기" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // 승인 → 실제 실행: 리드가 협상 단계로 이동하고 이력에 via: agent
  await card.getByRole("button", { name: "승인" }).click();
  await expect(card.getByText("완료")).toBeVisible();
  await expect(card.getByText("협상 단계로 옮겼습니다")).toBeVisible();
  await expect(card.getByRole("button", { name: "승인" })).toHaveCount(0);
  const moved = await (await request.get("/api/leads")).json();
  expect(moved.find((l: { id: string }) => l.id === lead.id).stage).toBe("negotiation");
  // 파이프라인 보드에도 반영 (승인 후 화면 데이터를 다시 불러온다)
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "파이프라인" }).click();
  await expect(page.locator(".column").filter({ hasText: "협상" }).locator(".card").filter({ hasText: "오션핀테크" })).toBeVisible();
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "Sales Agent" }).click();

  // 이미 처리한 계획은 다시 승인할 수 없다
  const again = await request.post(`/api/agent/actions/${plan.id}/approve`);
  expect(again.status()).toBe(409);

  // 다른 메뉴로 갔다 와도 대화 유지
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "파이프라인" }).click();
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "Sales Agent" }).click();
  await expect(page.getByText("확인 후 승인하세요.")).toBeVisible();

  // 새 대화
  await page.getByRole("button", { name: "새 대화" }).click();
  await expect(page.getByText("무엇을 도와드릴까요?")).toBeVisible();
});

test("Sales Agent: 수정 요청 → 계획 취소 + 입력창에 안내 문구", async ({ page, request }) => {
  const lead = await createLead(request, "오션핀테크", "qualified");
  await fakeAgentStream(page, await createMovePlan(lead, "qualified", "negotiation"));

  await page.goto("/agent");
  const input = page.getByRole("textbox", { name: "Sales Agent에게 요청" });
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

test("Sales Agent: 취소하면 실행하지 않고 보드도 그대로", async ({ page, request }) => {
  const lead = await createLead(request, "오션핀테크", "qualified");
  await fakeAgentStream(page, await createMovePlan(lead, "qualified", "negotiation"));

  await page.goto("/agent");
  const input = page.getByRole("textbox", { name: "Sales Agent에게 요청" });
  await input.fill("오션핀테크 리드를 협상 단계로 옮겨줘");
  await input.press("Enter");

  const card = page.getByRole("region", { name: "실행 계획: 리드 단계 이동" });
  await card.getByRole("button", { name: "취소", exact: true }).click();
  await expect(card.getByText("취소됨")).toBeVisible();
  await expect(card.getByRole("button", { name: "승인" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "파이프라인" }).click();
  await expect(page.locator(".column").filter({ hasText: "니즈 확인" }).locator(".card").filter({ hasText: "오션핀테크" })).toBeVisible();
});
