import { guessField } from "./docTemplate";
import type { DocTemplateInput, TemplateField } from "./types";

/** 템플릿이 하나도 없을 때 "기본 템플릿 불러오기"로 넣는 샘플 (계약서 1개 + 견적서 1개) */

const field = (key: string, over: Partial<TemplateField> = {}): TemplateField => ({ ...guessField(key), ...over });

export const DEFAULT_EMAIL_SUBJECT = "[{{회사명}}] {{문서명}} 송부드립니다";
export const DEFAULT_EMAIL_BODY = `{{담당자}} 님, 안녕하세요.
{{작성자}}입니다.

논의드린 내용으로 {{문서명}} 파일을 첨부드립니다.
검토 후 회신 부탁드립니다.

감사합니다.
{{작성자}} 드림 | {{작성자_이메일}}`;

export const SAMPLE_TEMPLATES: DocTemplateInput[] = [
  {
    kind: "contract",
    name: "SaaS 서비스 이용 계약서",
    description: "구독형 서비스 이용 계약 기본 양식",
    body: `# 서비스 이용 계약서

{{회사명}}(이하 "고객")와 노마진 주식회사(이하 "회사")는 회사가 제공하는 {{서비스명}} 이용에 관하여 다음과 같이 계약(이하 "본 계약")을 체결한다.

## 제1조 (목적)
본 계약은 회사가 제공하는 서비스의 이용 조건 및 절차, 당사자의 권리·의무를 정함을 목적으로 한다.

## 제2조 (계약 기간)
계약 기간은 {{계약 시작일}}부터 {{계약 종료일}}까지({{계약 기간}})로 한다.

## 제3조 (이용 요금 및 지급)
고객은 이용 요금으로 금 {{이용 요금}}원(부가세 별도)을 {{결제 방식}}으로 회사에 지급한다.

## 제4조 (담당자)
- 고객 담당자: {{담당자}} ({{담당자 이메일}})
- 회사 담당자: {{작성자}} ({{작성자_이메일}})

## 제5조 (비밀 유지)
양 당사자는 본 계약과 관련하여 알게 된 상대방의 정보를 상대방의 서면 동의 없이 제3자에게 누설하지 않는다.

## 제6조 (특약 사항)
{{특약 사항}}

본 계약의 성립을 증명하기 위하여 계약서 2부를 작성하여 각자 서명 날인 후 1부씩 보관한다.

계약일: {{계약일}}

고객: {{회사명}} / 대표: {{고객 대표자}} (인)
회사: 노마진 주식회사 / 대표: 홍길동 (인)`,
    fields: [
      field("회사명", { leadSource: "company" }),
      field("서비스명", { type: "choice", options: ["Pipeline CRM", "Pipeline CRM Pro"] }),
      field("계약 시작일", { type: "date", hint: "예: 2026-12-01, 다음 달 1일" }),
      field("계약 기간", { type: "period", hint: "예: 1년, 6개월" }),
      field("계약 종료일", { type: "date", hint: "시작일과 기간을 알려주시면 자동으로 계산돼요" }),
      field("이용 요금", { type: "money", leadSource: "value" }),
      field("결제 방식", { type: "choice", options: ["월 분할", "분기 분할", "연 일시불"] }),
      field("담당자", { leadSource: "contact" }),
      field("담당자 이메일", { type: "email", leadSource: "email" }),
      field("고객 대표자", { question: "고객사 대표자 성함을 알려주세요." }),
      field("특약 사항", { type: "multiline", required: false, question: "특약 사항이 있으면 알려주세요. 없으면 건너뛰기를 누르세요." }),
      field("계약일", { type: "date" }),
    ],
    lineItems: null,
    emailSubject: DEFAULT_EMAIL_SUBJECT,
    emailBody: DEFAULT_EMAIL_BODY,
  },
  {
    kind: "quote",
    name: "표준 견적서",
    description: "품목·수량·단가 견적서 (부가세 별도)",
    body: `# 견 적 서

견적번호: {{문서번호}}
견적일: {{작성일}}
수신: {{회사명}} {{담당자}} 귀하
유효기간: 견적일로부터 {{유효기간}}

공급자: 노마진 주식회사 (사업자등록번호 123-45-67890)
담당: {{작성자}} ({{작성자_이메일}})

아래와 같이 견적합니다.
합계 금액: {{합계_한글}}

{{품목표}}

## 비고
{{비고}}`,
    fields: [
      field("회사명", { leadSource: "company" }),
      field("담당자", { leadSource: "contact" }),
      field("유효기간", { type: "period", defaultValue: "30일", hint: "예: 30일" }),
      field("비고", { type: "multiline", required: false, question: "비고에 적을 내용이 있나요? 없으면 건너뛰기를 누르세요." }),
    ],
    lineItems: { spec: true, vat: "excluded" },
    emailSubject: DEFAULT_EMAIL_SUBJECT,
    emailBody: DEFAULT_EMAIL_BODY,
  },
];
