import { expect, test, type Page } from "@playwright/test";
import { createLead, resetDb } from "./helpers";

test.beforeEach(resetDb);

const SHOTS = process.env.E2E_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};

/** Gmail 발송 권한이 있는 것처럼 /api/me 응답을 바꾸고, 발송은 서버 대신 가짜로 처리 */
async function fakeGmailSend(page: Page) {
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const me = await res.json();
    await route.fulfill({ json: { ...me, gmail: { state: "connected", canSend: true } } });
  });
  await page.route("**/api/documents/*/send", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    const doc = await (await page.request.get(`/api/documents/${id}`)).json();
    const sentMsg = { role: "assistant", text: "✓ kim@ace.co.kr에 계약서를 보냈어요.", at: new Date().toISOString(), kind: "sent", link: "https://mail.google.com" };
    await route.fulfill({ json: { document: { ...doc, status: "sent", sendCount: 1, messages: [...doc.messages, sentMsg] }, changed: [] } });
  });
}

test("계약서: 템플릿 버튼 → 리드 선택(자동 채움) → 하나씩 답변 → 완성 → 메일 보내기", async ({ page, request }) => {
  await request.post("/api/templates/defaults");
  const lead = await createLead(request, "에이스상사", "qualified");
  await request.patch(`/api/leads/${lead.id}`, {
    data: { company: "에이스상사", contact: "김민수", email: "kim@ace.co.kr", value: 12_000_000, stage: "qualified" },
  });
  await fakeGmailSend(page);

  // 왼쪽 메뉴의 계약서로 이동
  await page.goto("/");
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "계약서" }).click();
  await expect(page).toHaveURL(/\/contracts$/);
  await expect(page.getByRole("link", { name: "계약서" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("안녕하세요! 어떤 문서를 만들까요?")).toBeVisible();
  // 이 화면에서는 조회형 Assistant를 숨긴다
  await expect(page.getByRole("button", { name: /Assistant/ })).toHaveCount(0);
  await shot(page, "1-start");

  await page.getByRole("button", { name: /SaaS 서비스 이용 계약서/ }).click();
  await expect(page.getByText("좋아요. 어느 리드의 계약서인가요?")).toBeVisible();
  await page.getByRole("button", { name: "에이스상사 · 김민수" }).click();

  // 리드에서 자동 채움 → 오른쪽 문서에 반영
  await expect(page.getByText(/리드에서 채움/)).toBeVisible();
  const paper = page.locator(".paper");
  await expect(paper.locator('.fchip.ok[data-key="회사명"]').first()).toHaveText("에이스상사");
  await expect(paper.locator('.fchip.ok[data-key="이용 요금"]')).toHaveText("12,000,000");
  await expect(paper.locator('.fchip.now[data-key="서비스명"]')).toBeVisible();
  await shot(page, "2-lead");

  await page.getByRole("button", { name: "Pipeline CRM", exact: true }).click();
  await expect(page.getByText("계약 시작일은 언제인가요?", { exact: false })).toBeVisible();
  const input = page.getByPlaceholder(/답변 입력/);
  await input.fill("2026-12-01");
  await input.press("Enter");
  await expect(page.getByText(/계약 기간은 얼마나/)).toBeVisible();
  await page.getByRole("button", { name: "1년", exact: true }).click();
  await expect(paper.locator('[data-key="계약 종료일"]')).toHaveText("2027년 11월 30일");
  await expect(page.getByText(/결제 방식을 골라/)).toBeVisible();
  await shot(page, "3-questions");

  // 문서의 값을 눌러 직접 수정
  await paper.locator('.fchip[data-key="이용 요금"]').click();
  await page.getByRole("dialog", { name: "이용 요금 수정" }).locator("input").fill("11000000");
  await shot(page, "4-inline-edit");
  await page.getByRole("dialog", { name: "이용 요금 수정" }).getByRole("button", { name: "저장" }).click();
  await expect(paper.locator('[data-key="이용 요금"]')).toHaveText("11,000,000");

  // "완료" → 빈 필수 항목 확인 → 빈칸으로 완성
  await input.fill("완료");
  await input.press("Enter");
  await expect(page.getByText(/그래도 완성할까요/)).toBeVisible();
  await page.getByRole("button", { name: "빈칸으로 완성" }).click();
  await expect(page.getByText("문서를 완성했어요.", { exact: false })).toBeVisible();
  await expect(page.locator(".doc-status-completed")).toBeVisible();
  await shot(page, "5-completed");

  // PDF 다운로드
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".result-card").getByRole("button", { name: /PDF 다운로드/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/^계약서_에이스상사_\d{4}-\d{2}-\d{2}\.pdf$/);

  // 메일 보내기: 받는 사람 = 리드 이메일, 제목·본문·첨부 표시
  await page.locator(".result-card").getByRole("button", { name: /메일로 보내기/ }).click();
  const modal = page.getByRole("dialog", { name: "메일 보내기" });
  await expect(modal.locator(".addr-chip")).toHaveText(/kim@ace\.co\.kr/);
  await expect(modal.getByLabel("제목")).toHaveValue("[에이스상사] SaaS 서비스 이용 계약서 송부드립니다");
  await expect(modal.getByLabel("본문")).toHaveValue(/김민수 님, 안녕하세요\./);
  await expect(modal.getByLabel("첨부 파일 이름")).toHaveValue(/^계약서_에이스상사_.+\.pdf$/);
  await expect(modal.getByText(/KB · \d+쪽/)).toBeVisible();
  await modal.getByLabel("참조 (CC)").fill("boss@ace.co.kr");
  await modal.getByLabel("참조 (CC)").press("Enter");
  await shot(page, "6-email");
  await modal.getByRole("button", { name: "보내기" }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByText(/kim@ace\.co\.kr에 계약서를 보냈어요/)).toBeVisible();
  await expect(page.locator(".doc-status-sent")).toBeVisible();
});

test("견적서: 품목을 말하면 표에 추가되고 합계·한글 금액이 계산된다", async ({ page, request }) => {
  await request.post("/api/templates/defaults");
  await page.goto("/contracts");
  await expect(page.getByText("안녕하세요! 어떤 문서를 만들까요?")).toBeVisible();
  const input = page.getByPlaceholder(/견적서/);
  await input.fill("견적서");
  await input.press("Enter");
  await page.getByRole("button", { name: "리드 없이 작성" }).click();
  await expect(page.getByText(/품목을 알려주세요/)).toBeVisible();

  const answer = page.getByPlaceholder(/답변 입력/);
  await answer.fill("CRM 라이선스 20개 단가 60만원");
  await answer.press("Enter");
  await expect(page.getByText(/더 추가할 품목/)).toBeVisible();
  await answer.fill("초기 세팅 1식 150만원");
  await answer.press("Enter");
  const table = page.locator(".paper-items");
  await expect(table.locator("tbody tr")).toHaveCount(2 + 3);
  await expect(table.locator("tr.total")).toContainText("14,850,000");
  await expect(page.locator('.paper [data-key="합계_한글"]')).toHaveText("일금 일천사백팔십오만원정 (₩14,850,000)");
  await shot(page, "7-quote");
  await page.getByRole("button", { name: "품목 추가 완료" }).click();
  await expect(page.getByText("회사명을 알려주세요.")).toBeVisible();
});

test("템플릿 등록: 본문 글자를 드래그해 항목으로 지정하면 항목 패널에 생긴다", async ({ page }) => {
  await page.goto("/contracts");
  await expect(page.getByText(/등록된 템플릿이 없어요/)).toBeVisible();
  await page.getByRole("tab", { name: "템플릿", exact: true }).click();
  await page.getByRole("button", { name: "템플릿 등록" }).click();
  await page.getByLabel("템플릿 이름").fill("NDA");
  const src = page.getByLabel("템플릿 본문");
  await src.fill("# 비밀유지계약서\n\n갑: 한빛소프트\n계약일: {{계약일}}");
  // "한빛소프트" 선택
  await src.evaluate((el: HTMLTextAreaElement) => {
    const i = el.value.indexOf("한빛소프트");
    el.focus();
    el.setSelectionRange(i, i + "한빛소프트".length);
    // 마우스로 드래그한 것과 같이 mouseup에서 선택 영역을 읽는다
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: /항목으로 지정/ }).click();
  await page.getByPlaceholder("항목 이름 (예: 이용 요금)").fill("회사명");
  await page.getByRole("dialog", { name: "항목으로 지정" }).getByRole("button", { name: "항목으로 지정" }).click();
  await expect(src).toHaveValue(/갑: \{\{회사명\}\}/);
  const side = page.getByRole("complementary", { name: "항목" });
  await expect(side.locator(".field-row-name")).toHaveText(["회사명", "계약일", "담당자"]); // 본문 → 메일 양식 등장 순서
  await expect(side.getByText("← 리드: 회사명")).toBeVisible();
  await shot(page, "8-template-editor");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("템플릿을 등록했습니다")).toBeVisible();
  await expect(page.locator(".tpl-card h3")).toHaveText(["NDA"]);
});
