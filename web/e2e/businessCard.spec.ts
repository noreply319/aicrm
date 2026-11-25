import { expect, test, type Page } from "@playwright/test";
import { createCompany, createContact, resetDb } from "./helpers";

test.beforeEach(resetDb);

// 1×1 PNG (브라우저가 열 수 있는 실제 이미지 → 클라이언트 축소 과정까지 지난다)
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

/** 명함 분석은 OpenAI 대신 가짜 응답. 저장(/api/business-cards)은 실제 서버·테스트 DB */
async function fakeExtract(page: Page, body: unknown) {
  await page.route("**/api/business-cards/extract", (route) => route.fulfill({ json: body }));
}

const DRAFT = {
  company: { name: "에이크미", website: "https://acme.co.kr", emailDomain: "acme.co.kr", phone: "02-555-1234", address: "", businessNumber: "" },
  contact: { name: "김민수", department: "영업본부", title: "팀장", email: "ms@acme.co.kr", mobile: "010-1234-5678", officePhone: "", linkedinUrl: "" },
};
const NO_MATCH = { company: null, companyByDomain: false, contactByEmail: null, sameName: null };

test("AI Assistant: 명함 사진 → 확인 카드에서 수정 → 회사·연락처 생성 → 연락처 상세", async ({ page }) => {
  await fakeExtract(page, { draft: DRAFT, match: NO_MATCH });
  await page.goto("/");
  await page.getByLabel("명함 이미지 선택").setInputFiles({ name: "card.png", mimeType: "image/png", buffer: PNG });

  const card = page.getByRole("region", { name: "명함: 김민수" });
  await expect(card).toBeVisible();
  await expect(card.getByText("명함 이미지는 AI(OpenAI)로 분석했고")).toBeVisible();
  await card.getByLabel("직함").fill("영업팀장");
  await card.getByRole("button", { name: "회사·연락처 생성" }).click();

  await expect(card.getByText("등록됨")).toBeVisible();
  await expect(card.getByText("(새로 만듦)")).toBeVisible();
  await card.getByRole("button", { name: "연락처 보기" }).click();
  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]+$/);
  await expect(page.getByText("영업팀장").first()).toBeVisible();
});

test("같은 이메일 연락처가 있으면 빈 항목만 채운다", async ({ page, request }) => {
  const company = await createCompany(request, { name: "에이크미", emailDomain: "acme.co.kr" });
  const existing = await createContact(request, { name: "김민수", email: "ms@acme.co.kr", title: "부장" });
  await fakeExtract(page, { draft: DRAFT, match: { ...NO_MATCH, company, companyByDomain: true, contactByEmail: existing } });
  await page.goto("/");
  await page.getByLabel("명함 이미지 선택").setInputFiles({ name: "card.png", mimeType: "image/png", buffer: PNG });

  const card = page.getByRole("region", { name: "명함: 김민수" });
  await expect(card.getByText("같은 이메일의 연락처가 이미 있어요")).toBeVisible();
  await card.getByRole("button", { name: "빈 항목만 채우기" }).click();
  await expect(card.getByText("빈 항목을 명함 값으로 채웠어요")).toBeVisible();

  const saved = await (await request.get(`/api/contacts/${existing.id}`)).json();
  // 있던 직함은 그대로, 빈 부서·휴대폰·회사는 채움
  expect(saved).toMatchObject({ title: "부장", department: "영업본부", mobile: "010-1234-5678", companyId: company.id });
});
