import { expect, test } from "@playwright/test";
import { createCompany, createContact, createConversation, createLead, hideDevIndicator, resetDb } from "./helpers";

test.beforeEach(resetDb);
test.beforeEach(({ page }) => hideDevIndicator(page));

test("모바일: 추가 버튼은 플로팅 버튼(FAB), 모달은 전체 화면", async ({ page, request }) => {
  await createLead(request, "모바일상사");
  await page.goto("/meetings");

  // 헤더의 '노트 작성' 버튼 대신 FAB
  await expect(page.locator(".header-actions .btn-primary")).toBeHidden();
  // 빈 목록 안내의 '노트 작성' 버튼과 구분: 플로팅 버튼(.fab)
  const fab = page.locator(".fab");
  await expect(fab).toHaveAccessibleName("노트 작성");
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

test("모바일: 상단 왼쪽 햄버거 버튼으로 전체 화면 메뉴를 열고, 메뉴를 고르면 닫힌다", async ({ page }) => {
  await page.goto("/pipeline");
  const menu = page.locator(".sidebar");
  // 하단 탭 바 없음: 평소에는 메뉴가 보이지 않는다
  await expect(menu).toBeHidden();

  const open = page.getByRole("button", { name: "메뉴 열기" });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  // 상단 바 맨 왼쪽
  const openBox = (await open.boundingBox())!;
  expect(openBox.x).toBeLessThan(20);
  await open.click();
  await expect(open).toHaveAttribute("aria-expanded", "true");

  // 화면 전체를 덮는다
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return box && Math.round(box.x) === 0 && Math.round(box.y) === 0 && Math.round(box.width) === viewport.width && Math.round(box.height) === viewport.height;
    })
    .toBe(true);
  await expect(menu.getByRole("link", { name: "파이프라인" })).toHaveAttribute("aria-current", "page");

  await menu.getByRole("link", { name: "미팅 노트" }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(menu).toBeHidden();
  await expect(page.locator(".page-title")).toHaveText("미팅 노트");

  // 닫기 버튼·Esc로도 닫힌다
  await open.click();
  await page.getByRole("button", { name: "메뉴 닫기" }).click();
  await expect(menu).toBeHidden();
  await open.click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("모바일: 메뉴의 프로필 버튼에서 설정 모달을 연다 (메뉴는 닫힌다)", async ({ page }) => {
  await page.goto("/pipeline");
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.locator(".sidebar").getByRole("link", { name: "설정" })).toHaveCount(0);
  await page.locator(".user-btn").click();
  await page.getByRole("menuitem", { name: "설정" }).click();
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
  await expect(page.locator(".sidebar")).toBeHidden();
});

test("모바일: 기기가 다크 모드여도 데스크톱과 같은 밝은 배경", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/pipeline");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 247, 246)");
});

test("모바일: 파이프라인은 단계 탭 + 선택한 단계의 리드 세로 목록", async ({ page, request }) => {
  await createLead(request, "신규상사", "new");
  await createLead(request, "니즈상사", "qualified");
  await page.goto("/pipeline");

  const tabs = page.getByRole("tablist", { name: "단계" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("tab", { name: /신규 리드/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".card").filter({ hasText: "신규상사" })).toBeVisible();
  await expect(page.locator(".card").filter({ hasText: "니즈상사" })).toBeHidden();

  await tabs.getByRole("tab", { name: /니즈 확인/ }).click();
  await expect(page.locator(".card").filter({ hasText: "니즈상사" })).toBeVisible();
  await expect(page.locator(".card").filter({ hasText: "신규상사" })).toBeHidden();

  // 단계 탭 줄은 가로로만 스크롤: 세로로 스크롤할 여지가 없어야 끌어도 위아래로 흔들리지 않는다
  const scroll = await tabs.evaluate((el) => {
    el.scrollTop = 10; // 세로 스크롤이 가능하면 값이 남는다
    return { top: el.scrollTop, overflowY: getComputedStyle(el).overflowY, wide: el.scrollWidth > el.clientWidth };
  });
  expect(scroll).toEqual({ top: 0, overflowY: "hidden", wide: true });

  // 세로 목록: 선택한 단계 컬럼이 화면 폭을 채운다
  const col = page.locator(".column").filter({ hasText: "니즈상사" });
  const box = (await col.boundingBox())!;
  expect(box.width).toBeGreaterThan(page.viewportSize()!.width - 40);
});

test("모바일: 첫 화면은 AI Assistant 대화 (상단 바·햄버거 유지, 뒤로 가기 없음)", async ({ page }) => {
  await page.goto("/");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await expect(panel).toBeVisible();
  await expect(page.locator(".page-title")).toHaveText("AI Assistant");
  await expect(panel.getByRole("tab", { name: "일반 대화" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByPlaceholder(/리드에 대해 질문하세요/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "채팅 닫기" })).toHaveCount(0);
  const box = (await panel.boundingBox())!;
  expect(Math.round(box.width)).toBe(page.viewportSize()!.width);

  await page.getByRole("button", { name: "메뉴 열기" }).click();
  const nav = page.getByRole("navigation", { name: "메뉴" });
  await expect(nav.getByRole("link", { name: "AI Assistant" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "미팅 노트" }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(panel).toBeHidden();
});

test("모바일: 키보드가 열려 보이는 영역이 줄어도 입력창은 그 안(키보드 위)에 보인다", async ({ page }) => {
  // iOS 키보드 흉내: 보이는 영역(visualViewport) 높이만 줄이고 resize 이벤트 → useKeyboardViewport가 화면을 맞춘다
  await page.addInitScript(() => {
    const w = window as Window & { __vvH?: number };
    Object.defineProperty(VisualViewport.prototype, "height", { get: () => w.__vvH ?? window.innerHeight, configurable: true });
  });
  const keyboard = (h: number | undefined) => page.evaluate((px) => {
    (window as Window & { __vvH?: number }).__vvH = px;
    window.visualViewport!.dispatchEvent(new Event("resize"));
  }, h);
  const composerBottom = async () => {
    const box = (await page.locator(".composer").boundingBox())!;
    return box.y + box.height;
  };

  // 첫 화면 (/): 긴 대화 — 입력칸을 누르면 키보드 위로 마지막 답변이 보이고, 대화 공간을 넓히려고 상단 바는 숨긴다
  await createConversation("assistant", "긴 대화", Array.from({ length: 12 }, (_, i) => [`질문 ${i + 1}`, `답변 ${i + 1}`] as [string, string]));
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible();
  await expect(page.getByText("답변 12", { exact: true })).toBeVisible();
  await page.locator(".assistant-messages").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await page.getByRole("textbox", { name: "AI Assistant에게 질문·요청" }).focus();
  await keyboard(400);
  await expect.poll(composerBottom).toBeLessThanOrEqual(400);
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(page.getByText("답변 12", { exact: true })).toBeInViewport();
  await keyboard(undefined); // 키보드 닫힘 → 원래 높이, 상단 바 다시
  await expect.poll(composerBottom).toBeGreaterThan(600);
  await expect(page.locator(".topbar")).toBeVisible();

  // 다른 화면의 전체 화면 채팅
  await page.goto("/pipeline");
  await page.getByRole("button", { name: "AI Assistant" }).click();
  await expect(page.locator(".composer")).toBeVisible();
  await keyboard(400);
  await expect.poll(composerBottom).toBeLessThanOrEqual(400);
});

test("모바일: 채팅 화면은 페이지가 스크롤되지 않고 대화 목록만 스크롤 (위로 스크롤 시 화면 떨림 방지)", async ({ page }) => {
  const state = () => page.evaluate(() => {
    const root = document.documentElement;
    const list = document.querySelector(".assistant-messages");
    return {
      locked: root.classList.contains("chat-screen"),
      overflow: getComputedStyle(root).overflowY,
      fits: document.scrollingElement!.scrollHeight <= window.innerHeight,
      contain: list ? getComputedStyle(list).overscrollBehaviorY : null,
      vvTop: root.style.getPropertyValue("--vv-top"),
    };
  });

  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible();
  await expect.poll(state).toMatchObject({ locked: true, overflow: "hidden", fits: true, contain: "contain" });
  // 키보드가 닫힌 채로 보이는 영역이 움직여도(주소창·튕김) 화면을 옮기지 않는다
  await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("scroll")));
  expect((await state()).vvTop).toBe("");

  // 다른 화면으로 가면 잠금을 풀어 평소처럼 스크롤된다
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("navigation", { name: "메뉴" }).getByRole("link", { name: "회사" }).click();
  await expect(page).toHaveURL(/\/companies$/);
  await expect.poll(async () => (await state()).locked).toBe(false);
});

test("모바일: 다른 화면의 AI Assistant 채팅은 화면 전체 폭·높이를 쓰고, 다른 메뉴로 가면 닫힌다", async ({ page }) => {
  await page.goto("/pipeline");
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await expect(panel).toBeHidden();

  // 상단 바의 AI 버튼으로 연다
  await page.getByRole("button", { name: "AI Assistant" }).click();
  await expect(panel).toBeVisible();
  const viewport = page.viewportSize()!;
  const box = (await panel.boundingBox())!;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.width)).toBe(viewport.width);
  expect(Math.round(box.height)).toBe(viewport.height);
  await expect(panel.getByPlaceholder(/리드에 대해 질문하세요/)).toBeVisible();

  // 뒤로 가기로 닫기
  await panel.getByRole("button", { name: "채팅 닫기" }).click();
  await expect(panel).toBeHidden();

  // 다시 열고, 메뉴에서 다른 화면으로 가면 닫힌다
  await page.getByRole("button", { name: "AI Assistant" }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "채팅 닫기" }).click();
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.locator(".sidebar").getByRole("link", { name: "미팅 노트" }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(panel).toBeHidden();
});

test("모바일: 화면마다 가로로 넘치는 요소가 없다 (360px)", async ({ page, request }) => {
  // 내용이 넘치면 모바일 브라우저는 레이아웃 폭 자체를 넓혀(innerWidth 증가) 화면 전체·모달이 오른쪽으로 잘린다 → 기기 폭과 비교
  await page.setViewportSize({ width: 360, height: 800 });
  const company = await createCompany(request, { name: "블루웨이브테크놀로지스" });
  await request.post("/api/leads", { data: { companyId: company.id, value: 1_250_000_000 } });
  for (const path of ["/", "/pipeline", "/companies", `/companies/${company.id}`, "/contacts", "/meetings", "/calendar", "/contracts", "/agent"]) {
    await page.goto(path);
    await expect(page.locator(".page-title")).toBeVisible();
    const width = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.scrollingElement!.scrollWidth }));
    expect(width, path).toEqual({ inner: 360, scroll: 360 });
  }

  // 새 리드 모달: 예상 마감일(날짜 입력)이 화면 밖으로 나가지 않고, 모달이 좌우로 스크롤되지 않는다
  await page.goto("/pipeline");
  await page.locator(".fab").click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  const date = modal.locator('input[type="date"]');
  await expect.poll(async () => {
    const box = (await date.boundingBox())!;
    return Math.round(box.x + box.width);
  }).toBeLessThanOrEqual(360);
  const overflow = await modal.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("모바일 리드 모달: 담당자 칩의 긴 회사·부서·직함은 둘째 줄, 이름과 × 버튼은 같은 줄", async ({ page, request }) => {
  const company = await createCompany(request, { name: "(주)엔에스 컴퍼니" });
  const contact = await createContact(request, { name: "안수현", companyId: company.id, department: "경영지원본부 인사기획팀", title: "대리" });
  await request.post("/api/leads", { data: { companyId: company.id, contactId: contact.id, value: 10_000_000 } });

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/pipeline");
  await page.locator(".card").filter({ hasText: "엔에스" }).click();
  const chip = page.getByTestId("contact-chip");
  await expect(chip).toBeVisible();
  const name = (await chip.locator("b").boundingBox())!;
  const close = (await chip.getByRole("button", { name: "다른 담당자 선택" }).boundingBox())!;
  // 세로 가운데가 거의 같은 줄 (× 버튼이 다음 줄로 내려가지 않음)
  expect(Math.abs(name.y + name.height / 2 - (close.y + close.height / 2))).toBeLessThan(8);
  // 칩이 화면 밖으로 넘치지 않는다
  const box = (await chip.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
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

  await page.getByRole("tab", { name: /📄 문서/ }).click();
  await expect(page.locator('.paper [data-key="회사명"]').first()).toHaveText("블루웨이브");
  await expect(page.getByRole("region", { name: "문서 작성 Assistant" })).toBeHidden();
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/10-mobile-doc.png` });
});
