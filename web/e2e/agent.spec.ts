import { expect, test, type Page } from "@playwright/test";
import { createLead, resetDb } from "./helpers";

test.beforeEach(resetDb);

const PLAN_ID = "11111111-1111-4111-8111-111111111111";

/** /api/agent 스트림을 가짜 NDJSON으로 대체 (OpenAI 호출 없음). 계획 승인은 실제 서버(501 준비 중)로 간다 */
async function fakeAgentStream(page: Page, leadId: string) {
  await page.route("**/api/agent", async (route) => {
    const events = [
      { type: "step", step: { id: "context", label: "CRM 데이터 확인", status: "running" } },
      { type: "step", step: { id: "context", label: "CRM 데이터 확인", status: "done" } },
      { type: "step", step: { id: "tool-1", label: "캘린더 일정 조회", status: "done", detail: "일정 2건" } },
      { type: "reply", content: "오션핀테크 리드를 협상 단계로 옮기는 계획입니다. 확인 후 승인하세요." },
      {
        type: "plan",
        plan: {
          id: PLAN_ID,
          title: "리드 단계 이동",
          changes: [{ field: "단계", before: "니즈 확인", after: "협상" }],
          target: { kind: "lead", id: leadId, label: "오션핀테크" },
          status: "pending",
          affectsLeads: true,
        },
      },
      { type: "done" },
    ];
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  });
}

test("Sales Agent: 메뉴 이동 → 요청 입력 → 진행 단계·답변·실행 계획 카드 → 승인(준비 중)·수정 요청", async ({ page, request }) => {
  const lead = await createLead(request, "오션핀테크", "qualified");
  await fakeAgentStream(page, lead.id);

  await page.goto("/pipeline");
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "Sales Agent" }).click();
  await expect(page).toHaveURL(/\/agent$/);
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
  await expect(steps.getByText("일정 2건")).toBeVisible();
  await expect(page.getByText("확인 후 승인하세요.")).toBeVisible();

  const card = page.getByRole("region", { name: "실행 계획: 리드 단계 이동" });
  await expect(card.getByText("승인 대기")).toBeVisible();
  await expect(card.getByRole("cell", { name: "니즈 확인" })).toBeVisible();
  await expect(card.getByRole("cell", { name: "협상" })).toBeVisible();

  // 실행 엔진(AIC-3) 전: 승인하면 준비 중 안내, 카드는 다시 누를 수 있게 남는다
  await card.getByRole("button", { name: "승인" }).click();
  await expect(card.getByText("실행 기능은 준비 중입니다")).toBeVisible();
  await expect(card.getByRole("button", { name: "승인" })).toBeEnabled();

  // 대상 링크 → 리드 모달
  await card.getByRole("button", { name: "리드 열기" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // 수정 요청 → 입력창에 안내 문구
  await card.getByRole("button", { name: "수정 요청" }).click();
  await expect(input).toHaveValue("「리드 단계 이동」 계획 수정: ");
  await expect(input).toBeFocused();

  // 다른 메뉴로 갔다 와도 대화 유지
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "파이프라인" }).click();
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "Sales Agent" }).click();
  await expect(page.getByText("확인 후 승인하세요.")).toBeVisible();

  // 새 대화
  await page.getByRole("button", { name: "새 대화" }).click();
  await expect(page.getByText("무엇을 도와드릴까요?")).toBeVisible();
});
