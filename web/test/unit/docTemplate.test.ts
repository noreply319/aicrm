import { describe, expect, it } from "vitest";
import {
  computeTotals, deriveEndDate, extractKeys, fillText, guessField, josa, koreanAmount, koreanNumber, parseAmount,
  parseBody, parseDate, parseFieldValue, parsePeriod, questionFor, syncFields, type DocContext,
} from "@/lib/docTemplate";
import { buildMime, encodeHeader } from "@/lib/mime";
import type { TemplateField } from "@/lib/types";

const TODAY = "2026-11-24";
const f = (key: string, over: Partial<TemplateField> = {}): TemplateField => ({ ...guessField(key), ...over });

describe("템플릿 항목", () => {
  it("{{항목}}을 등장 순서대로 중복 없이 찾는다", () => {
    expect(extractKeys("{{회사명}}와 {{ 계약 시작일 }} … {{회사명}} {{품목표}}")).toEqual(["회사명", "계약 시작일", "품목표"]);
  });

  it("본문에 맞춰 항목을 동기화: 기존 설정·순서 유지, 새 항목 추가, 사라진 항목·예약어 제외", () => {
    const existing = [f("계약일", { question: "언제 계약하나요?" }), f("삭제된 항목"), f("회사명")];
    const out = syncFields(["{{회사명}} {{계약일}} {{이용 요금}} {{문서번호}} {{합계}}"], existing);
    expect(out.map((x) => x.key)).toEqual(["계약일", "회사명", "이용 요금"]);
    expect(out[0].question).toBe("언제 계약하나요?");
    expect(out[2].type).toBe("money");
  });

  it("이름으로 유형·리드 자동 채움을 추측한다", () => {
    expect(guessField("회사명").leadSource).toBe("company");
    expect(guessField("담당자 이메일")).toMatchObject({ type: "email", leadSource: "email" });
    expect(guessField("계약 시작일").type).toBe("date");
    expect(guessField("계약 기간").type).toBe("period");
    expect(guessField("비고")).toMatchObject({ type: "multiline", required: false });
  });

  it("질문 문구의 조사", () => {
    expect(josa("회사명", "을를")).toBe("회사명을");
    expect(josa("담당자", "을를")).toBe("담당자를");
    expect(questionFor(f("계약 시작일"))).toBe("계약 시작일은 언제인가요?");
  });
});

describe("답변 해석", () => {
  it("날짜", () => {
    expect(parseDate("다음달 1일부터", TODAY)).toBe("2026-12-01");
    expect(parseDate("2027.1.5", TODAY)).toBe("2027-01-05");
    expect(parseDate("12월 15일", TODAY)).toBe("2026-12-15");
    expect(parseDate("3월 2일", TODAY)).toBe("2027-03-02"); // 이미 지난 날짜 → 내년
    expect(parseDate("오늘", TODAY)).toBe(TODAY);
    expect(parseDate("이번 달 말", TODAY)).toBe("2026-11-30");
    expect(parseDate("2026-02-30", TODAY)).toBeNull();
    expect(parseDate("곧", TODAY)).toBeNull();
  });

  it("금액·숫자", () => {
    expect(parseAmount("1,100만원")).toBe(11_000_000);
    expect(parseAmount("천이백만원")).toBe(12_000_000);
    expect(parseAmount("1.2억")).toBe(120_000_000);
    expect(parseAmount("5만원")).toBe(50_000);
    expect(parseAmount("금액은 12000000원입니다")).toBe(12_000_000);
    expect(parseAmount("20개")).toBe(20);
    expect(parseAmount("일시불")).toBeNull();
  });

  it("기간", () => {
    expect(parsePeriod("1년")).toMatchObject({ text: "1년", months: 12 });
    expect(parsePeriod("18개월")).toMatchObject({ text: "1년 6개월", months: 18 });
    expect(parsePeriod("30일")).toMatchObject({ text: "30일", days: 30 });
    expect(parsePeriod("길게")).toBeNull();
  });

  it("유형별 해석: 선택지·이메일·전화번호·텍스트", () => {
    const pay = f("결제 방식", { type: "choice", options: ["월 분할", "연 일시불"] });
    expect(parseFieldValue(pay, "연 일시불로 할게요")).toEqual({ ok: true, value: "연 일시불" });
    expect(parseFieldValue(pay, "2번")).toEqual({ ok: true, value: "연 일시불" });
    expect(parseFieldValue(pay, "카드")).toEqual({ ok: false });
    expect(parseFieldValue(f("담당자 이메일"), "kim@ACE.co.kr 입니다")).toEqual({ ok: true, value: "kim@ace.co.kr" });
    expect(parseFieldValue(f("담당자 전화번호"), "01012345678")).toEqual({ ok: true, value: "010-1234-5678" });
    expect(parseFieldValue(f("고객 대표자"), "김대표입니다.")).toEqual({ ok: true, value: "김대표" });
  });

  it("종료일 = 시작일 + 기간 - 1일", () => {
    const fields = [f("계약 시작일"), f("계약 기간"), f("계약 종료일")];
    expect(deriveEndDate(fields, { "계약 시작일": "2026-12-01", "계약 기간": "1년" })).toMatchObject({ key: "계약 종료일", value: "2027-11-30" });
    expect(deriveEndDate(fields, { "계약 시작일": "2026-01-31", "계약 기간": "1개월" })?.value).toBe("2026-02-27");
    expect(deriveEndDate(fields, { "계약 시작일": "2026-12-01" })).toBeNull();
  });
});

describe("견적 계산", () => {
  const items = [
    { name: "CRM 라이선스", spec: "12개월", qty: 20, unitPrice: 600_000 },
    { name: "초기 세팅", spec: "1식", qty: 1, unitPrice: 1_500_000 },
  ];
  it("부가세 별도·포함·없음", () => {
    expect(computeTotals(items, { spec: true, vat: "excluded" })).toEqual({ supply: 13_500_000, vat: 1_350_000, total: 14_850_000 });
    expect(computeTotals(items, { spec: true, vat: "included" })).toEqual({ supply: 12_272_727, vat: 1_227_273, total: 13_500_000 });
    expect(computeTotals(items, { spec: true, vat: "none" })).toEqual({ supply: 13_500_000, vat: 0, total: 13_500_000 });
  });
  it("한글 금액", () => {
    expect(koreanNumber(14_850_000)).toBe("일천사백팔십오만");
    expect(koreanNumber(100_020_003)).toBe("일억이만삼");
    expect(koreanAmount(14_850_000)).toBe("일금 일천사백팔십오만원정 (₩14,850,000)");
  });
});

describe("본문 블록·값 채우기", () => {
  const ctx: DocContext = {
    fields: [f("회사명"), f("이용 요금", { type: "money" }), f("계약일")],
    values: { 회사명: "에이스상사", "이용 요금": "11000000", 계약일: "2026-11-24" },
    lineItems: [], lineItemsConfig: null, docNumber: "C-2026-0001", date: TODAY, docName: "계약서", author: "홍길동", authorEmail: "hong@x.kr",
  };
  it("제목·조항·목록·빈 줄·품목 표", () => {
    const blocks = parseBody("# 계약서\n\n## 제1조\n- {{회사명}} 담당\n\n\n{{품목표}}\n본문");
    expect(blocks.map((b) => b.type)).toEqual(["h1", "gap", "h2", "li", "gap", "items", "p"]);
    expect(blocks[3]).toEqual({ type: "li", segs: [{ f: "회사명" }, { t: " 담당" }] });
  });
  it("메일 양식 채우기: 금액·날짜 표시 형식, 시스템 항목, 빈 값", () => {
    expect(fillText("[{{회사명}}] {{이용 요금}}원 {{계약일}} {{문서번호}} {{작성자}} {{없는값}}", ctx, "_")).toBe(
      "[에이스상사] 11,000,000원 2026년 11월 24일 C-2026-0001 홍길동 _"
    );
  });
});

describe("메일 MIME", () => {
  it("한글 제목은 RFC 2047로 인코딩하고 줄바꿈(헤더 인젝션)을 없앤다", () => {
    const h = encodeHeader("견적서 송부\r\nBcc: evil@x.com");
    expect(h).not.toMatch(/\r\nBcc/);
    expect(h.startsWith("=?UTF-8?B?")).toBe(true);
    const decoded = h.split(/\r\n /).map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("");
    expect(decoded).toBe("견적서 송부 Bcc: evil@x.com");
  });
  it("본문 + PDF 첨부 (multipart/mixed)", () => {
    const raw = buildMime(
      { to: ["kim@ace.co.kr"], cc: [], subject: "견적서", body: "안녕하세요\n첨부드립니다", attachment: { fileName: "견적서_에이스.pdf", contentType: "application/pdf", data: new Uint8Array([37, 80, 68, 70]) } },
      "BOUNDARY"
    );
    expect(raw).toContain("To: kim@ace.co.kr\r\n");
    expect(raw).not.toContain("Cc:");
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="BOUNDARY"');
    expect(raw).toContain(`filename*=UTF-8''${encodeURIComponent("견적서_에이스.pdf")}`);
    expect(raw).toContain(Buffer.from("안녕하세요\r\n첨부드립니다").toString("base64"));
    expect(raw).toContain("JVBERg=="); // %PDF
    expect(raw.trimEnd().endsWith("--BOUNDARY--")).toBe(true);
  });
});
