-- 계약서·견적서 템플릿 추가 (같은 이름의 템플릿이 있으면 건너뜀 → 재실행 안전)
-- 로컬:  psql "$DATABASE_URL" -f web/db/templates.sql
-- 운영:  npx supabase db query --remote=hwxuufpaupnpawlgnyvx --yes -f web/db/templates.sql

INSERT INTO document_templates (kind, name, description, body, fields, line_items, email_subject, email_body)
SELECT $tpl$contract$tpl$, $tpl$소프트웨어 구축 용역 계약서$tpl$, $tpl$CRM·시스템 구축 프로젝트 용역 계약 (검수·하자보수·지식재산권 포함)$tpl$, $tpl$# 소프트웨어 구축 용역 계약서

{{회사명}}(이하 "갑")과 노마진 주식회사(이하 "을")는 "{{프로젝트명}}"(이하 "본 용역")의 수행에 관하여 다음과 같이 계약(이하 "본 계약")을 체결한다.

## 제1조 (목적)
본 계약은 을이 갑에게 본 용역을 제공하고, 갑이 그 대가를 지급함에 있어 필요한 당사자의 권리와 의무를 정함을 목적으로 한다.

## 제2조 (용역 범위)
을이 수행하는 용역의 범위는 다음과 같으며, 세부 내용은 양 당사자가 합의한 제안서 및 요구사항 정의서에 따른다.
{{용역 범위}}

## 제3조 (계약 기간)
본 용역의 수행 기간은 {{계약 시작일}}부터 {{계약 종료일}}까지({{계약 기간}})로 한다. 기간의 변경은 양 당사자의 서면 합의로 한다.

## 제4조 (계약 금액 및 지급)
- 계약 금액: 금 {{계약 금액}}원 (부가가치세 별도)
- 지급 조건: {{지급 조건}}
- 갑은 을이 발행한 세금계산서를 받은 날부터 30일 이내에 을이 지정한 계좌로 현금 지급한다.

## 제5조 (검수)
을은 용역 결과물을 납품한 후 갑에게 검수를 요청하며, 갑은 요청일부터 {{검수 기간}} 이내에 검수 결과를 서면으로 통보한다. 기간 내 통보가 없으면 검수에 합격한 것으로 본다.

## 제6조 (하자 보수)
을은 검수 완료일부터 {{하자보수 기간}} 동안 결과물에서 발견된 하자를 무상으로 보수한다. 단, 갑의 귀책 사유 또는 갑의 요청에 따른 기능 변경은 제외한다.

## 제7조 (지식재산권)
본 용역으로 새로 개발된 결과물의 지식재산권은 대금 지급이 완료된 때 갑에게 귀속된다. 단, 을이 본 계약 이전부터 보유하던 솔루션·라이브러리의 권리는 을에게 있으며, 갑은 결과물 이용에 필요한 범위에서 이를 사용할 수 있다.

## 제8조 (비밀 유지 및 개인정보 보호)
양 당사자는 본 계약과 관련하여 알게 된 상대방의 영업상·기술상 정보를 상대방의 서면 동의 없이 제3자에게 누설하거나 본 계약 외의 목적으로 사용하지 않는다. 을은 용역 수행 중 취급하는 개인정보를 관계 법령에 따라 보호한다. 본 조는 계약 종료 후에도 3년간 유효하다.

## 제9조 (계약의 해지)
일방이 본 계약을 위반하고 상대방으로부터 서면 시정 요구를 받은 날부터 14일 이내에 시정하지 않으면, 상대방은 서면 통지로 본 계약을 해지할 수 있다. 해지 시 갑은 해지일까지 수행된 용역에 대한 대금을 정산하여 지급한다.

## 제10조 (손해배상)
일방이 본 계약을 위반하여 상대방에게 손해를 입힌 경우 이를 배상한다. 단, 고의 또는 중과실이 없는 한 배상 총액은 계약 금액을 한도로 한다.

## 제11조 (분쟁 해결)
본 계약에 관한 분쟁은 상호 협의로 해결하며, 협의가 되지 않을 경우 서울중앙지방법원을 제1심 관할 법원으로 한다.

## 제12조 (담당자)
- 갑 담당자: {{담당자}} ({{담당자 이메일}})
- 을 담당자: {{작성자}} ({{작성자_이메일}})

## 제13조 (특약 사항)
{{특약 사항}}

본 계약의 성립을 증명하기 위하여 계약서 2부를 작성하여 갑과 을이 서명 날인한 후 각 1부씩 보관한다.

계약일: {{계약일}}

갑: {{회사명}} / 대표: {{고객 대표자}} (인)
을: 노마진 주식회사 / 대표: 홍길동 (인)$tpl$,
  $tpl$[{"key":"회사명","type":"text","question":"","hint":"","required":true,"defaultValue":"","leadSource":"company","options":[]},{"key":"프로젝트명","type":"text","question":"","hint":"예: 영업관리 CRM 구축","required":true,"defaultValue":"","leadSource":"","options":[]},{"key":"용역 범위","type":"multiline","question":"용역 범위를 알려주세요. 여러 항목이면 줄을 바꿔 적어주세요.","hint":"예: 요구사항 분석, 화면 설계, 개발, 데이터 이관, 사용자 교육","required":true,"defaultValue":"","leadSource":"","options":[]},{"key":"계약 시작일","type":"date","question":"","hint":"예: 2026-12-01, 다음 달 1일","required":true,"defaultValue":"","leadSource":"","options":[]},{"key":"계약 기간","type":"period","question":"","hint":"예: 3개월, 6개월","required":true,"defaultValue":"","leadSource":"","options":[]},{"key":"계약 종료일","type":"date","question":"","hint":"시작일과 기간을 알려주시면 자동으로 계산돼요","required":true,"defaultValue":"","leadSource":"","options":[]},{"key":"계약 금액","type":"money","question":"","hint":"","required":true,"defaultValue":"","leadSource":"value","options":[]},{"key":"지급 조건","type":"choice","question":"","hint":"","required":true,"defaultValue":"","leadSource":"","options":["계약 시 50%, 검수 완료 후 50%","계약 시 30%, 중간 보고 후 40%, 검수 완료 후 30%","검수 완료 후 일시불"]},{"key":"검수 기간","type":"period","question":"","hint":"예: 14일","required":true,"defaultValue":"14일","leadSource":"","options":[]},{"key":"하자보수 기간","type":"period","question":"","hint":"예: 6개월, 1년","required":true,"defaultValue":"1년","leadSource":"","options":[]},{"key":"담당자","type":"text","question":"","hint":"","required":true,"defaultValue":"","leadSource":"contact","options":[]},{"key":"담당자 이메일","type":"email","question":"","hint":"","required":true,"defaultValue":"","leadSource":"email","options":[]},{"key":"고객 대표자","type":"text","question":"고객사 대표자 성함을 알려주세요.","hint":"","required":true,"defaultValue":"","leadSource":"","options":[]},{"key":"특약 사항","type":"multiline","question":"특약 사항이 있으면 알려주세요. 없으면 건너뛰기를 누르세요.","hint":"","required":false,"defaultValue":"","leadSource":"","options":[]},{"key":"계약일","type":"date","question":"","hint":"","required":true,"defaultValue":"","leadSource":"","options":[]}]$tpl$::jsonb, NULL, $tpl$[{{회사명}}] {{문서명}} 송부드립니다$tpl$, $tpl${{담당자}} 님, 안녕하세요.
{{작성자}}입니다.

논의드린 내용으로 {{문서명}} 파일을 첨부드립니다.
검토 후 회신 부탁드립니다.

감사합니다.
{{작성자}} 드림 | {{작성자_이메일}}$tpl$
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE name = $tpl$소프트웨어 구축 용역 계약서$tpl$);

INSERT INTO document_templates (kind, name, description, body, fields, line_items, email_subject, email_body)
SELECT $tpl$quote$tpl$, $tpl$구축 용역 견적서$tpl$, $tpl$프로젝트 구축·라이선스 견적 (납기·결제 조건 포함, 부가세 별도)$tpl$, $tpl$# 견 적 서

견적번호: {{문서번호}}
견적일: {{작성일}}
수신: {{회사명}} {{담당자}} 귀하
건명: {{프로젝트명}}

공급자: 노마진 주식회사 (사업자등록번호 123-45-67890)
대표: 홍길동
담당: {{작성자}} ({{작성자_이메일}})

귀사의 무궁한 발전을 기원하며, 아래와 같이 견적합니다.
합계 금액: {{합계_한글}} (부가세 포함)

{{품목표}}

## 견적 조건
- 납기: {{납기}}
- 결제 조건: {{결제 조건}}
- 유효기간: 견적일로부터 {{유효기간}}
- 품목 단가는 부가가치세 별도 기준이며, 요구사항이 변경되면 금액이 달라질 수 있습니다.

## 비고
{{비고}}$tpl$,
  $tpl$[{"key":"회사명","type":"text","question":"","hint":"","required":true,"defaultValue":"","leadSource":"company","options":[]},{"key":"담당자","type":"text","question":"","hint":"","required":true,"defaultValue":"","leadSource":"contact","options":[]},{"key":"프로젝트명","type":"text","question":"","hint":"예: 영업관리 CRM 구축","required":true,"defaultValue":"","leadSource":"","options":[]},{"key":"납기","type":"text","question":"","hint":"예: 계약 후 8주, 2027-03-31까지","required":true,"defaultValue":"","leadSource":"","options":[]},{"key":"결제 조건","type":"choice","question":"","hint":"","required":true,"defaultValue":"","leadSource":"","options":["계약 시 50%, 검수 완료 후 50%","검수 완료 후 일시불","월 정기 결제"]},{"key":"유효기간","type":"period","question":"","hint":"예: 30일","required":true,"defaultValue":"30일","leadSource":"","options":[]},{"key":"비고","type":"multiline","question":"비고에 적을 내용이 있나요? 없으면 건너뛰기를 누르세요.","hint":"","required":false,"defaultValue":"","leadSource":"","options":[]}]$tpl$::jsonb, $tpl${"spec":true,"vat":"excluded"}$tpl$::jsonb, $tpl$[{{회사명}}] {{문서명}} 송부드립니다$tpl$, $tpl${{담당자}} 님, 안녕하세요.
{{작성자}}입니다.

논의드린 내용으로 {{문서명}} 파일을 첨부드립니다.
검토 후 회신 부탁드립니다.

감사합니다.
{{작성자}} 드림 | {{작성자_이메일}}$tpl$
WHERE NOT EXISTS (SELECT 1 FROM document_templates WHERE name = $tpl$구축 용역 견적서$tpl$);
