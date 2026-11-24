import { expect, test } from "@playwright/test";
import { createCompany, createContact, resetDb } from "./helpers";

test.beforeEach(resetDb);

test("연락처 메뉴: 등록 → 상세 → 이 사람으로 리드 추가", async ({ page, request }) => {
  await createCompany(request, { name: "에이스상사" });
  await page.goto("/contacts");
  await expect(page.getByText("등록된 연락처가 없어요")).toBeVisible();
  await page.getByRole("button", { name: "연락처 등록" }).first().click();
  await page.getByLabel("이름 *").fill("김민수");
  await page.getByRole("combobox", { name: "회사", exact: true }).fill("에이스");
  await page.getByRole("option", { name: /에이스상사/ }).click();
  await page.getByLabel("부서").fill("구매팀");
  await page.getByLabel("직함").fill("팀장");
  await page.getByLabel("이메일").fill("Minsu@acme.co.kr");
  await page.getByLabel("휴대폰").fill("010-1234-5678");
  await page.getByRole("radio", { name: "의사결정자" }).click();
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "김민수" })).toBeVisible();
  await expect(page.getByText("minsu@acme.co.kr")).toBeVisible();

  await page.getByRole("button", { name: "이 사람으로 리드 추가" }).click();
  await expect(page.getByTestId("company-chip")).toContainText("에이스상사");
  await expect(page.getByTestId("contact-chip")).toContainText("김민수");
  await page.getByPlaceholder("10000000").fill("30000000");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".company-lead").filter({ hasText: "에이스상사" })).toBeVisible();
  await expect(page.getByText("진행 1건 · 파이프라인 ₩30,000,000")).toBeVisible();

  // 목록: 회사·부서·진행 리드 수
  await page.getByRole("link", { name: "← 연락처 목록" }).click();
  const row = page.locator(".contact-table tbody tr").filter({ hasText: "김민수" });
  await expect(row).toContainText("에이스상사");
  await expect(row).toContainText("구매팀 · 팀장");
  await expect(row).toContainText("의사결정자");
});

test("리드 모달: 회사의 연락처를 고르면 담당자 정보가 채워지고, 회사 없는 리드는 연락처 회사로 채운다", async ({ page, request }) => {
  const acme = await createCompany(request, { name: "에이스상사" });
  await createContact(request, { name: "김민수", companyId: acme.id, title: "팀장", email: "minsu@acme.co.kr", mobile: "010-1111-2222" });
  await createContact(request, { name: "김태희", title: "PM" });
  await page.goto("/");
  await page.getByRole("button", { name: "새 리드" }).click();

  // 회사 없이 담당자 검색 → 선택하면 회사 자동 채움
  await page.getByRole("combobox", { name: "담당자" }).fill("김");
  await expect(page.getByRole("option", { name: /김태희/ })).toBeVisible();
  await page.getByRole("option", { name: /김민수/ }).click();
  await expect(page.getByTestId("contact-chip")).toContainText("김민수");
  await expect(page.getByTestId("company-chip")).toContainText("에이스상사");
  await expect(page.getByText("회사를 에이스상사(으)로 채웠어요")).toBeVisible();
  await expect(page.locator(".contact-readonly")).toContainText("010-1111-2222");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("새 리드가 등록되었습니다")).toBeVisible();

  // 다시 열면 연락처가 선택된 상태
  await page.locator(".card").filter({ hasText: "에이스상사" }).click();
  await expect(page.getByTestId("contact-chip")).toContainText("김민수");
});

test("리드 모달 위에서 연락처를 수정하면 리드 담당자 정보도 바뀌고, Esc는 위 모달만 닫는다", async ({ page, request }) => {
  const acme = await createCompany(request, { name: "에이스상사" });
  const c = await createContact(request, { name: "김민수", companyId: acme.id, title: "팀장", email: "minsu@acme.co.kr" });
  await request.post("/api/leads", { data: { companyId: acme.id, contactId: c.id, value: 1000 } });
  await page.goto("/");
  await page.locator(".card").filter({ hasText: "에이스상사" }).click();
  await page.getByRole("button", { name: "연락처 수정" }).click();
  const contactDialog = page.getByRole("dialog", { name: "김민수 수정" });
  await expect(contactDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(contactDialog).toHaveCount(0);
  await expect(page.getByTestId("contact-chip")).toBeVisible();

  await page.getByRole("button", { name: "연락처 수정" }).click();
  await contactDialog.getByLabel("직함").fill("본부장");
  await contactDialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("연락처를 수정했습니다")).toBeVisible();
  await expect(page.getByTestId("contact-chip")).toContainText("본부장");
  await page.getByRole("button", { name: "취소" }).click();

  // 서버가 리드 사본도 바꿨다
  const leads = (await (await request.get("/api/leads")).json()) as { title: string }[];
  expect(leads[0].title).toBe("본부장");
});

test("연락처를 삭제하면 리드는 연결만 끊기고 담당자 텍스트는 남는다", async ({ page, request }) => {
  const acme = await createCompany(request, { name: "에이스상사" });
  const c = await createContact(request, { name: "김민수", companyId: acme.id, email: "minsu@acme.co.kr" });
  await request.post("/api/leads", { data: { companyId: acme.id, contactId: c.id } });
  await page.goto(`/contacts/${c.id}`);
  await page.getByRole("button", { name: "수정" }).click();
  page.once("dialog", (d) => {
    expect(d.message()).toContain("연결된 리드 1건은 담당자 연결만 해제돼요");
    d.accept();
  });
  await page.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("연락처를 삭제했습니다")).toBeVisible();
  await expect(page).toHaveURL(/\/contacts$/);

  await page.getByRole("link", { name: "파이프라인" }).click();
  await page.locator(".card").filter({ hasText: "에이스상사" }).click();
  await expect(page.getByTestId("legacy-contact")).toContainText("김민수");
});

test("같은 이메일로 등록하면 기존 연락처를 안내한다", async ({ page, request }) => {
  await createContact(request, { name: "김민수", email: "minsu@acme.co.kr" });
  await page.goto("/contacts");
  await page.getByRole("button", { name: "연락처 등록" }).first().click();
  await page.getByLabel("이름 *").fill("다른사람");
  await page.getByLabel("이메일").fill("MINSU@acme.co.kr");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("이미 등록된 이메일이에요")).toBeVisible();
  await page.getByRole("button", { name: "그 연락처 보기" }).click();
  await expect(page.getByRole("heading", { name: "김민수" })).toBeVisible();
});
