import { expect, test } from "@playwright/test";
import { createConversation, createLead, createMovePlan, resetDb } from "./helpers";

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

test("AI Assistant: 위로 올려 읽는 중에는 답변이 와도 맨 아래로 끌어내리지 않는다", async ({ page }) => {
  const long = Array.from({ length: 60 }, (_, i) => `${i + 1}번째 줄`).join("\n");
  let delay = 0;
  await page.route("**/api/assistant", async (route) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: [{ type: "reply", content: delay ? "두 번째 답변" : long }, { type: "done" }].map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  });

  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  const input = panel.getByRole("textbox", { name: "AI Assistant에게 질문·요청" });
  const list = panel.locator(".assistant-messages");
  const scrollTop = () => list.evaluate((el) => el.scrollTop);

  // 첫 답변: 맨 아래를 보고 있었으므로 따라 내려간다
  await input.fill("긴 답변 줘");
  await input.press("Enter");
  await expect(panel.getByText("60번째 줄")).toBeInViewport();

  // 두 번째 질문을 보내고, 답변이 오기 전에 위로 올린다 → 답변이 와도 그 자리
  delay = 1500;
  await input.fill("하나 더");
  await input.press("Enter");
  await list.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await expect(panel.getByText("두 번째 답변")).toBeAttached();
  await page.waitForTimeout(300);
  expect(await scrollTop()).toBeLessThan(50);

  // 다시 질문을 보내면 맨 아래로
  delay = 0;
  await input.fill("마지막");
  await input.press("Enter");
  await expect(panel.locator(".bubble-assistant").last()).toBeInViewport();
});

test("AI Assistant 대화 기록: 다른 기기에서도 최근 대화가 이어지고, 목록에서 이전 대화를 열고 지운다", async ({ page, browser }) => {
  await createConversation("assistant", "지난주 파이프라인", [["지난주 파이프라인 알려줘", "지난주 파이프라인은 ₩3,000만입니다."]], 60);
  await createConversation("assistant", "오션핀테크 이력", [["오션핀테크 이력 보여줘", "오션핀테크는 협상 단계입니다."]]);

  // 처음 열면 가장 최근 대화
  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await expect(panel.getByText("오션핀테크는 협상 단계입니다.")).toBeVisible();

  // 다른 기기(새 브라우저 세션)에서도 같은 대화
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("/");
  await expect(otherPage.getByText("오션핀테크는 협상 단계입니다.")).toBeVisible();
  await other.close();

  // 목록 → 이전 대화 열기
  await panel.getByRole("button", { name: "대화 목록" }).click();
  const list = panel.getByRole("region", { name: "대화 목록" });
  await expect(list.getByRole("button", { name: /^오션핀테크 이력/ })).toHaveAttribute("aria-current", "true");
  await list.getByRole("button", { name: /^지난주 파이프라인/ }).click();
  await expect(panel.getByText("지난주 파이프라인은 ₩3,000만입니다.")).toBeVisible();
  await expect(panel.getByText("오션핀테크는 협상 단계입니다.")).toHaveCount(0);

  // 삭제: 한 번 더 눌러 확인, 보던 대화를 지우면 새 대화
  await panel.getByRole("button", { name: "대화 목록" }).click();
  await list.getByRole("button", { name: "「지난주 파이프라인」 대화 삭제" }).click();
  await list.getByRole("button", { name: "삭제 확인" }).click();
  await expect(list.getByRole("button", { name: /^지난주 파이프라인/ })).toHaveCount(0);
  await list.getByRole("button", { name: "대화 목록 닫기" }).click();
  await expect(panel.getByText("지난주 파이프라인은 ₩3,000만입니다.")).toHaveCount(0);
  await expect(panel.locator(".assistant-empty")).toBeVisible();
});
