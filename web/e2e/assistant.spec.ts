import { expect, test } from "@playwright/test";
import { createLead, createMovePlan, resetDb } from "./helpers";

test.beforeEach(resetDb);

/** AI Assistant에서 리드 변경: 실행 계획 카드 → 승인 → 보드 반영 (AIC-12). /api/assistant 스트림은 가짜, 승인은 실제 서버 */
test("AI Assistant: 리드 단계 이동 요청 → 계획 카드 → 승인 → 파이프라인 반영", async ({ page, request }) => {
  const lead = await createLead(request, "오션핀테크", "qualified");
  const plan = await createMovePlan(lead, "qualified", "negotiation", "assistant");
  await page.route("**/api/assistant", async (route) => {
    const events = [
      { type: "step", step: { id: "context", label: "CRM 데이터 확인", status: "done" } },
      { type: "step", step: { id: "tool-1", label: "실행 계획 작성: 리드 단계 이동", status: "done", detail: "승인 대기" } },
      { type: "reply", content: "아래 계획을 확인하고 승인하면 반영됩니다." },
      { type: "plan", plan },
      { type: "done" },
    ];
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: events.map((e) => JSON.stringify(e)).join("\n") + "\n" });
  });

  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  const input = panel.getByRole("textbox", { name: "AI Assistant에게 질문·요청" });
  await input.fill("오션핀테크 리드를 협상 단계로 옮겨줘");
  await input.press("Enter");
  await expect(panel.getByText("아래 계획을 확인하고 승인하면 반영됩니다.")).toBeVisible();

  const card = panel.getByRole("region", { name: "실행 계획: 리드 단계 이동" });
  await expect(card.getByText("승인 대기")).toBeVisible();
  await card.getByRole("button", { name: "승인" }).click();
  await expect(card.getByText("협상 단계로 옮겼습니다")).toBeVisible();

  const leads = await (await request.get("/api/leads")).json();
  expect(leads.find((l: { id: string }) => l.id === lead.id).stage).toBe("negotiation");
  // 새로고침 없이 보드에 반영, 패널 대화는 다른 화면에서도 이어진다
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "파이프라인" }).click();
  await expect(page.locator(".column").filter({ hasText: "협상" }).locator(".card").filter({ hasText: "오션핀테크" })).toBeVisible();
});

test("AI Assistant: 수정 요청 → 계획 취소 + 입력칸에 수정 문구", async ({ page, request }) => {
  const lead = await createLead(request, "에이스테크", "qualified");
  const plan = await createMovePlan(lead, "qualified", "negotiation", "assistant");
  await page.route("**/api/assistant", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: [{ type: "plan", plan }, { type: "done" }].map((e) => JSON.stringify(e)).join("\n") + "\n",
    })
  );

  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  const input = panel.getByRole("textbox", { name: "AI Assistant에게 질문·요청" });
  await input.fill("에이스테크 협상으로");
  await input.press("Enter");
  const card = panel.getByRole("region", { name: "실행 계획: 리드 단계 이동" });
  await card.getByRole("button", { name: "수정 요청" }).click();
  await expect(card.getByText("취소됨")).toBeVisible();
  await expect(input).toHaveValue("「리드 단계 이동」 계획 수정: ");
});
