# 연락처(Contacts) 관리 + 리드 담당자 선택 요구사항 / 구현 계획

- 작성일: 2026-11-24
- 상태: **구현됨** (`feature/contacts`, 회사 기능 위) — 2026-11-24 1·2차 질의응답 반영 (2장, 11장). 구현하면서 바뀐 점은 13장
- 와이어프레임: `docs/contacts/wireframe.html`
- 선행 작업: `docs/companies/requirements.md` (회사 관리, 확정·구현 전)
- 관련 화면: 헤더 메뉴(신규 `연락처`), 연락처 목록·상세·등록 모달(신규), 리드 모달 담당자 입력란(변경), 회사 상세(소속 연락처 섹션 추가)

## 1. 배경 / 목적

지금은 리드마다 담당자 이름·직함·이메일·전화를 텍스트로 직접 입력한다. 그래서

- 같은 사람과 리드가 여러 건이면 정보를 매번 다시 입력하고, 한 곳에서 바꾸면 나머지는 옛 정보로 남는다.
- "이 사람과 진행한 건"을 모아 볼 수 없고, 부서·역할·LinkedIn 같은 사람 정보를 저장할 곳이 없다.
- 리드 없이 알게 된 사람(행사에서 받은 명함 등)을 등록할 곳이 없다.

이번 작업으로:

1. 상단 메뉴 `연락처`에서 **연락처를 등록·수정·조회**하고, 사람별 연결 리드를 본다.
2. 리드를 등록·수정할 때 담당자를 **연락처에서 검색·선택**한다 (회사 콤보박스와 같은 방식).
3. 없으면 리드 모달 안에서 **바로 생성**한다 (이름 + 직함·이메일·휴대폰).
4. 기존 리드의 담당자 정보로 연락처를 **자동 생성·연결**한다.

## 2. 결정 사항 (2026-11-24 1차 질의응답)

| 항목 | 결정 |
|---|---|
| 리드와의 관계 | **리드 담당자를 연락처에서 선택** (리드 1건 = 담당 연락처 0~1명). 리드의 `contact`·`title`·`email`·`phone`은 **사본으로 유지** |
| 회사 연결 | **선택 사항**. 회사 없는 연락처(프리랜서·개인 고객) 허용. 회사 상세에 소속 연락처 목록 |
| 기존 데이터 | 리드 담당자 정보로 **자동 생성·연결**. 이메일이 같으면 같은 사람, 이메일이 없으면 회사 + 이름 기준. 담당자가 빈 리드는 건너뜀 |
| 항목 | 기본(이름·회사·직함·이메일·휴대폰) + **부서·유선 전화** + **영업 관리**(역할·담당 영업·태그) + **메모·LinkedIn**. 재직/퇴사 상태는 제외 |

## 3. 범위

| 포함 (이번 작업) | 제외 (추후 검토) |
|---|---|
| 헤더 메뉴 `연락처`(`/contacts`), 목록·검색·필터·정렬 | 리드 1건에 연락처 여러 명(N:M, 역할별) |
| 연락처 상세(`/contacts/[id]`): 정보, 연결 리드 | 재직/퇴사 상태, 이직 이력 |
| 연락처 등록·수정·삭제 모달 | 연락처 병합(중복 합치기) |
| 리드 모달 담당자 콤보박스(검색·키보드·바로 생성) | 명함 사진 OCR, vCard/CSV 가져오기·내보내기 |
| 연락처 수정 → 연결 리드 담당자 사본 갱신 + 이력 | 연락처별 Gmail 메일·미팅 노트 모아 보기 |
| 회사 상세에 소속 연락처 섹션 + `연락처 추가` | 구글 주소록 동기화 |
| 기존 리드 담당자 → 연락처 마이그레이션 | 연락처 단위 변경 이력(`contact_events`) |
| AI Assistant 컨텍스트에 연락처 정보(조회 전용, 개인정보 제외) | 생일·기념일 알림 |

## 4. 용어

- **연락처(Contact)**: 영업 상대방 한 사람. 회사에 소속될 수도, 안 될 수도 있다. 팀 전체 공유.
- **연결 리드**: `leads.contact_id`가 이 연락처인 리드. 한 연락처가 여러 리드의 담당자일 수 있다.
- **역할(Role)**: 영업 관점에서 이 사람의 역할. `decision_maker`(의사결정자) / `practitioner`(실무자) / `influencer`(영향력자) / 없음.
- **담당 영업(Owner)**: 이 연락처를 맡은 팀원(`users`). 비어 있을 수 있다.
- **담당자 사본**: 리드의 `contact`(이름)·`title`(직함)·`email`·`phone` 컬럼. 연결된 연락처 값을 복사해 둔 것 — 기존 화면·이력·Gmail·Assistant가 그대로 쓴다.

## 5. 기능 요구사항

### 5.1 메뉴

- FR-1. 헤더 메뉴에 `연락처`(`/contacts`)를 `회사` 바로 다음에 추가한다. (`파이프라인 · 회사 · 연락처 · 미팅 노트 · 캘린더 · 설정`, 계약서 메뉴가 생기면 그 뒤)
- FR-2. 연락처 화면에서 헤더 추가 버튼은 `연락처 등록`, 검색 placeholder는 `이름, 회사, 이메일, 부서, 태그 검색…`.
- FR-3. `(crm)` 경로 그룹에 `contacts/page.tsx`, `contacts/[id]/page.tsx`(빈 page) 추가, `CrmApp`의 `viewOf()`·Header `View`에 `contacts` 추가. 연락처 목록은 레이아웃 상태로 유지(메뉴 이동 시 다시 불러오지 않음).

### 5.2 연락처 목록

- FR-4. 표(데스크톱): 이름(+역할 배지), 회사, 부서·직함, 이메일, 휴대폰, 담당 영업, 태그, **진행 리드 수**, 최근 리드 변경일.
- FR-5. 검색: 이름·회사명·이메일·부서·직함·태그 (헤더 검색창, 대소문자·공백 무시).
- FR-6. 필터: `내 담당만`, 역할, 회사(콤보박스), `진행 리드 있음`, `회사 없음`. 정렬: 이름순(기본) / 최근 등록순 / 최근 리드 변경순.
- FR-7. 행 클릭 → 연락처 상세. 이메일은 `mailto:`, 휴대폰은 `tel:` 링크(행 클릭과 분리). 빈 상태: "등록된 연락처가 없어요" + `연락처 등록`.
- FR-8. 모바일(640px 이하): 카드 목록(이름·역할, 회사·직함, 전화/메일 아이콘 버튼).

### 5.3 연락처 등록·수정 모달

- FR-9. 섹션: **기본 정보** / **연락 수단** / **영업 관리** / **메모**.

  | 항목 | 입력 | 검증 |
  |---|---|---|
  | 이름 * | 텍스트 | 1~50자 |
  | 회사 | 회사 콤보박스(회사 기능의 `CompanyCombobox` 재사용, 바로 생성 가능), 비워 둘 수 있음 | `companies.id` |
  | 부서 | 텍스트 + 기존 값 자동완성(datalist, 같은 회사 값 우선) | 50자 |
  | 직함 | 텍스트 | 50자 |
  | 이메일 | 이메일 | 형식 검사, 소문자 저장, 254자, **다른 연락처와 중복 불가**(409 + 기존 연락처 안내) |
  | 휴대폰 | 텍스트 | 30자, 숫자·`-`·`+`·공백만 |
  | 유선 전화 | 텍스트 (내선 포함 `02-1234-5678 #123`) | 30자 |
  | LinkedIn | URL | `http(s)://` 없으면 `https://` 자동, 500자 |
  | 역할 | `의사결정자` / `실무자` / `영향력자` / 없음 | 목록 값만 |
  | 담당 영업 | 팀원 선택, 기본값 없음 | `users.id` |
  | 태그 | 칩 입력(Enter), 기존 태그 자동완성 | 최대 10개, 각 20자 |
  | 메모 | 여러 줄 | 5000자 |

- FR-10. 회사를 고르지 않았는데 이메일 도메인과 같은 회사(`companies.email_domain`)가 있으면 "이메일 도메인이 같은 회사: 에이스상사 [선택]" 힌트 (회사 기능 FR-24와 같은 방식).
- FR-11. 같은 회사 + 같은 이름 연락처가 이미 있으면 저장 전 경고 "같은 회사에 '김민수'가 이미 있어요 · [그 연락처 보기]" (저장은 허용 — 동명이인).
- FR-12. 저장은 낙관적 업데이트 → 실패 시 `reload()` + 에러 배너.
- FR-13. 삭제: 연결 리드가 있어도 삭제 가능. 확인 창에 "연결된 리드 N건은 담당자 연결만 해제돼요. 리드에 적힌 담당자 이름·연락처는 그대로 남아요" 표시. 리드는 `contact_id` NULL(사본 유지) + 리드마다 `lead_events` `updated` `{ contactId: {from, to: null}, via: "contact_deleted" }`.

### 5.4 연락처 상세 (`/contacts/[id]`)

- FR-14. 상단: 이름, 역할 배지, 회사 링크(→ 회사 상세)·부서·직함, 태그, `메일`·`전화`·`LinkedIn` 바로가기, `수정` 버튼.
- FR-15. 왼쪽 연락처 정보(빈 항목 `—`), 오른쪽 **연결 리드**: 단계 배지·회사·금액·마감일, 진행 중 → 수주/실주 순. 클릭하면 기존 리드 모달. 요약 줄: 진행 N건 · 파이프라인 ₩ · 수주 ₩.
- FR-16. `+ 이 사람으로 리드 추가` → 리드 모달을 담당자(+연락처의 회사)가 선택된 상태로 연다.
- FR-17. 없는/잘못된 id → "연락처를 찾을 수 없어요" + 목록 링크.

### 5.5 리드 모달 — 담당자 검색·선택 (콤보박스)

- FR-18. 기존 `담당자`·`직책`·`이메일`·`전화번호` 4개 입력을 **담당자 콤보박스 1개 + 선택된 연락처 정보 표시**로 바꾼다. 담당자는 **선택 사항**(지금처럼 비워 둘 수 있음).
- FR-19. 검색 대상: 이름·이메일·부서. 결과 최대 8개, 일치 부분 굵게, 각 항목에 `회사 · 직함`.
  - 리드에 회사가 선택돼 있으면 **그 회사 연락처를 위에**(`에이스상사 연락처`), 나머지는 아래 `다른 회사` 그룹.
  - 입력 전 포커스만 해도 선택된 회사의 연락처를 보여 준다 (회사 연락처가 2~3명일 때 바로 고름).
- FR-20. 드롭다운 맨 아래 **`+ "입력값" 새 연락처로 만들기`** → 콤보박스 자리에 **간이 입력 폼**(이름(입력값), 직함, 이메일, 휴대폰, `만들기`·`취소`)이 펼쳐진다. 회사는 리드의 회사로 자동. `만들기` → `POST /api/contacts` → 성공하면 선택 상태 + 토스트 "연락처 '정하늘'을 만들었어요". 리드 모달은 닫히지 않고 입력값 유지. 리드를 취소해도 연락처는 남는다.
- FR-21. 선택된 상태: 칩 `👤 김민수 · 구매팀장 ✕` + 아래에 이메일·휴대폰 읽기 전용 표시 + `연락처 정보 →`(상세로 이동) / `수정`(연락처 모달을 위에 띄워 수정 → 리드 모달로 복귀). 리드 모달에서는 **읽기 전용** — 연락처 정보는 연락처에서만 수정.
- FR-22. 회사가 없는 리드에서 회사가 있는 연락처를 고르면 리드 회사도 그 회사로 자동 선택 + 안내 "회사를 에이스상사로 채웠어요". 리드 회사와 다른 회사의 연락처를 고르면 경고만 "선택한 연락처는 블루웨이브 소속이에요" (저장 허용).
- FR-23. 키보드: ↑/↓, Enter 선택, Esc 닫기. ARIA `combobox`/`listbox`/`option`(그룹은 `group`). 회사 콤보박스와 같은 공통 컴포넌트(`EntityCombobox`)로 구현 검토.
- FR-24. 리드 저장 시 서버가 `contact_id`의 연락처 값으로 사본(`contact`·`title`·`email`·`phone`)을 채운다(클라이언트 값 무시). `phone` = 휴대폰, 없으면 유선 전화. 담당자를 비우면 사본도 빈 값.

### 5.6 기존 화면 영향

- FR-25. 칸반 카드·리드 검색·미팅 노트·캘린더 초대·Gmail `leadTarget()`·계약서 자동 채움은 **변경 없이** 리드의 담당자 사본을 쓴다.
- FR-26. 연락처의 이름·직함·이메일·전화를 바꾸면 연결 리드의 사본을 **같은 트랜잭션에서** 갱신하고, 바뀐 리드마다 `lead_events` `updated` `{ contact: {from,to}, email: {...}, via: "contact" }` 이력을 남긴다. 대상은 **모든 연결 리드**(수주·실주 포함).
- FR-27. 리드의 담당자를 바꾸면 `updated` `{ contactId, contact: {from,to} }` 이력.
- FR-28. 회사 상세(회사 기능 FR-15) 왼쪽 아래에 **소속 연락처** 섹션: 이름·역할·직함, `+ 연락처 추가`(회사 선택된 상태로 연락처 모달). 회사 삭제 가능 조건은 그대로(연결 리드 기준) — 소속 연락처가 있으면 확인 창에 "소속 연락처 N명은 회사 없음으로 바뀌어요".
- FR-29. 리드 이메일이 바뀌어 Gmail 검색 대상이 달라지면 기존 `lead_emails` 캐시는 그대로 두고 다음 동기화부터 새 주소로 검색 (기존 동작과 동일).
- FR-30. AI Assistant 컨텍스트: 질문에 나온 연락처의 이름·회사·부서·직함·역할·태그·담당 영업·메모 요약과 연결 리드. **이메일·전화·LinkedIn은 보내지 않음**(기존 규칙), 메모는 `maskPii` 후 전송.

## 6. 비기능 요구사항

- **성능**: 첫 로드에 전체 목록(예상 수백~수천 건, 연결 리드 수는 클라이언트 `leads`로 계산). 3,000건 초과 시 서버 검색 전환 검토.
- **개인정보**: 연락처는 개인정보 — 로그에 이메일·전화 출력 금지, Assistant 전송 제외(FR-30). 삭제 시 실제 행 삭제(소프트 삭제 없음).
- **접근성**: 콤보박스 ARIA, 결과 수 `aria-live`.
- **스타일**: `globals.css` 기존 토큰만. 역할 배지는 기존 배지 스타일 재사용, 새 토큰은 라이트/다크 모두.

## 7. 데이터 모델 (안)

**설계 방향**: 회사와 같이 `leads`의 담당자 컬럼은 **사본으로 유지**하고 `leads.contact_id`를 추가한다. 담당자 값을 쓰는 곳(칸반, Gmail, 캘린더 초대, 계약서, Assistant, 이력)이 많아 JOIN으로 바꾸면 범위가 커지기 때문.

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 50),
  company_id    uuid REFERENCES companies(id) ON DELETE SET NULL,
  department    text NOT NULL DEFAULT '',
  title         text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',        -- 소문자
  mobile        text NOT NULL DEFAULT '',
  office_phone  text NOT NULL DEFAULT '',
  linkedin_url  text NOT NULL DEFAULT '',
  role          text CHECK (role IN ('decision_maker','practitioner','influencer')),
  owner_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  notes         text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts (company_id);
-- 이메일 중복 불가 (빈 값 제외)
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_idx ON contacts (email) WHERE email <> '';
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
-- crm_app 전용 정책 (lead_events와 같은 DO $$ 블록 패턴)

ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS leads_contact_idx ON leads (contact_id);
```

- **마이그레이션** (schema.sql 끝, 회사 마이그레이션 다음, 재실행 안전):
  1. 대상: `contact_id IS NULL AND trim(contact) <> ''`인 리드.
  2. 사람 키: 이메일이 있으면 `lower(trim(email))`, 없으면 `company_id` + 정규화 이름(공백 정리·소문자).
  3. 키마다 연락처 1건 생성. 값이 리드마다 다르면 **가장 최근 `updated_at` 리드** 값 사용. `phone`이 `01`로 시작하면 휴대폰, 아니면 유선 전화. `company_id`는 그 리드의 회사.
  4. `UPDATE leads SET contact_id = ...` 로 연결. 사본 값은 바꾸지 않음(이력 없음).
  5. 같은 이메일인데 회사가 다른 경우(이직 등)는 최근 리드의 회사로 1건 — 결과 건수를 확인 쿼리로 보고.
- **`lead_events`**: 새 타입 없음 (FR-26·27은 `updated`).
- **타입**(`lib/types.ts`): `Contact`, `ContactInput`, `ContactRole`, `Lead`에 `contactId: string | null`.
- **상수**(`lib/constants.ts`): `CONTACT_ROLES`(`{ id, label }`), `CONTACT_TAG_MAX`. 바꾸면 schema CHECK도 함께.

## 8. API (안)

모두 `proxy.ts`로 자동 보호, 입력은 `lib/validate.ts`(`validateContactInput`), id는 `UUID_RE`.

| 메서드 · 경로 | 설명 | 응답 |
|---|---|---|
| `GET /api/contacts` | 전체 목록 | `Contact[]` |
| `POST /api/contacts` | 생성 (리드 모달 간이 생성 포함) | `201 Contact` / `409 { error, contact }` (이메일 중복 시 기존 연락처) |
| `GET /api/contacts/[id]` | 상세 | `Contact` / 404 |
| `PATCH /api/contacts/[id]` | 수정. 사본 필드가 바뀌면 연결 리드 사본 갱신 + 이력 (트랜잭션) | `Contact` |
| `DELETE /api/contacts/[id]` | 삭제. 연결 리드는 연결 해제 + 이력 (트랜잭션) | `{ ok: true }` |
| `POST /api/leads`, `PATCH /api/leads/[id]` | **변경**: `contactId` 받음(선택), 담당자 사본은 서버가 채움 | 기존 |

- 서버: `lib/contacts.ts`(컬럼 매핑, 사본 전파 `syncLeadContactCopies(client, contactId, before, after)`).
- 클라이언트: `lib/useContacts.ts`(목록·생성·수정·삭제, 낙관적 업데이트). 연락처 수정 성공 후 `useLeads`의 해당 리드 사본도 로컬 갱신(또는 `reload()`).
- 컴포넌트: `ContactList`, `ContactDetail`, `ContactModal`, `ContactCombobox`(리드 모달), 회사 상세의 `CompanyContacts` 섹션.

## 9. 구현 순서

0. **선행**: 회사 기능(`docs/companies`) 구현 완료 후 시작 — 연락처의 `company_id`, `CompanyCombobox` 재사용. 콤보박스는 회사 구현 때부터 공통 컴포넌트(`EntityCombobox`)로 만들어 두면 좋음.
1. **DB**: `contacts`, `leads.contact_id`, RLS, 마이그레이션 → 로컬 `npm run db:init` 확인, `seed.sql` 샘플 연락처.
2. **서버**: `lib/contacts.ts`, `validate.ts`, `/api/contacts`, 리드 API `contactId` 처리 + 사본 채움·전파.
3. **클라이언트 데이터**: `types.ts`, `useContacts.ts`, `useLeads`에 `contactId`.
4. **리드 모달 담당자 콤보박스** + 간이 생성 폼.
5. **연락처 메뉴**: Header NAV, `viewOf`, 목록·상세·모달. 회사 상세 소속 연락처 섹션.
6. **Assistant 컨텍스트**.
7. **테스트**
   - unit: 이메일 정규화, 전화번호 분류(휴대폰/유선), LinkedIn URL 정규화, 마이그레이션 사람 키 규칙.
   - integration: 연락처 CRUD, 이메일 중복 409, 리드 생성 시 `contactId` → 사본 채움, 연락처 수정 → 리드 사본 갱신 + `lead_events`, 삭제 시 리드 연결 해제 + 사본 유지 + 이력, 마이그레이션(같은 이메일 → 1건, 재실행 안전).
   - e2e: 리드 모달 검색·선택·저장 / 간이 생성·저장 / 연락처 메뉴 등록 → 상세 → 이 사람으로 리드 추가.
8. `npm run build` + `npm test` + `npm run test:e2e`.
9. **배포**: Supabase에 `schema.sql` 실행(쓰기 — 실행 전 사용자 확인) → 생성 연락처 수·미연결 리드(담당자 있는데 `contact_id` NULL) 0건 `--read-only` 확인.

## 10. 제약 / 리스크

- **회사 기능 의존**: 회사가 먼저 없으면 `company_id`·회사 필터·도메인 추천이 동작하지 않음.
- **사본 불일치**: 사본을 서버에서만 채우고 연락처 수정 시 전파하므로, 직접 SQL로 리드를 수정하면 어긋날 수 있음 → 운영 수정은 API로.
- **마이그레이션 오인**: 이메일 없는 같은 이름(동명이인 같은 회사)은 1명으로 합쳐짐, 이메일만 다른 같은 사람은 2명이 됨 → 병합 기능 전까지 수동 정리.
- **개인정보 증가**: 휴대폰·LinkedIn 등 개인정보가 한 테이블에 모임 — RLS·로그 규칙 준수.

## 11. 추가 결정 사항 (2026-11-24 2차 질의응답)

| # | 질문 | 결정 |
|---|---|---|
| Q1 | 연결 리드가 있는 연락처 삭제 | **삭제 허용, 연결만 해제**. 리드의 담당자 사본 텍스트는 남김 (FR-13) |
| Q2 | 연락처 수정 시 리드 담당자 사본 갱신 범위 | **모든 연결 리드** (수주·실주 포함) + 리드마다 이력 (FR-26) |
| Q3 | 리드 모달에서 연락처 정보 직접 수정 | **읽기 전용** + `수정` 버튼으로 연락처 모달 (FR-21) |
| Q4 | 같은 이메일 연락처 | **중복 불가** (409 + 기존 연락처 이동/선택). 마이그레이션도 이메일 기준 한 사람 |
| Q5 | 구현 순서 | **회사 기능 먼저**, 이어서 연락처 |
| Q6 | 담당자 없는 리드 | **허용** (선택 사항 유지) |

## 12. 완료 기준

- [x] 사이드바 `연락처` 메뉴 → 목록 검색·필터·정렬, 상세, 등록·수정·삭제 동작 (e2e)
- [x] 리드 모달에서 담당자 검색·선택 / 간이 생성 / 키보드 조작 동작, 회사 자동 채움 (e2e)
- [x] 연락처 수정 시 연결 리드 사본·이력 반영 (integration·e2e)
- [x] 기존 리드 담당자가 연락처로 생성·연결됨 — 테스트 DB, 로컬 `ai_crm`(2026-11-24: 회사 8·연락처 8, 미연결 0건)
- [ ] 운영(Supabase) 적용 — **배포와 같은 시점에** (14장)
- [x] 회사 상세 소속 연락처 섹션
- [x] 라이트/다크, 모바일(640px 이하) 스크린샷 확인 — 목록 표가 좁을 때 글자 단위 줄바꿈 → 줄바꿈 없이 가로 스크롤로 수정
- [x] `npm run build`, `npm test`, `npm run test:e2e` 통과

## 13. 구현하면서 정한 점 (2026-11-24)

- **마이그레이션 1회 실행**: `crm_link_lead_contacts()`는 `crm_migrations`(`contacts_from_leads`)에 기록하고 **한 번만** 실행한다.
  재실행 안전한 함수지만, 매번 돌리면 연락처를 삭제해 연결이 끊긴 리드(Q1)로 연락처가 다시 만들어지기 때문. `seed.sql`은 연락처가 0명일 때만 호출.
- **리드 API**: `contactId`가 있으면 담당자 사본을 서버가 채운다. `contactId` 없이 담당자 텍스트만 오면 **그대로 저장**(연락처 자동 생성 안 함 — 회사의 `resolveLeadCompany`와 다름).
  리드 모달에서는 연결 안 된 담당자 텍스트를 "연락처에 연결되지 않은 담당자: ○○ [지우기]"로 보여준다.
- **이력**: 연락처 수정 전파는 `updated { contact|title|email|phone: {from,to}, via: "contact" }`, 연락처 삭제는 `updated { contactLink: {from: 이름, to: null}, via: "contact_deleted" }`.
- **역할 순서**: 의사결정자 → 영향력자 → 실무자 (회사 상세 소속 연락처 정렬).
- **리드 모달 위 연락처 수정**: `Modal`에 열린 순서 스택을 두어 **Esc는 맨 위 모달만** 닫는다 (디자인 시스템 `components/ui/Modal.tsx`).
- **화면**: 목록·상세는 회사 화면 스타일(`.companies`, `.company-table` 등)을 재사용. 연락처 상세의 연락 버튼은 `mailto:`·`tel:`.
- **e2e 포트**: 다른 worktree와 동시에 돌릴 수 있게 `E2E_PORT`(기본 3100) 추가.

## 14. 운영 적용 시점 주의

- 기존 리드 → 연락처 마이그레이션은 **한 번만** 실행된다(13장). 운영에 `schema.sql`을 먼저 적용하고 코드 배포가 늦어지면, 그 사이 이전 코드로 만든 리드는 담당자 텍스트만 있고 연락처에 연결되지 않는다.
- 따라서 운영 적용은 **회사·연락처 코드를 main에 병합해 Vercel 배포하는 시점에 바로 이어서** 한다. 늦게 적용했다면 `SELECT crm_link_lead_contacts();`를 한 번 더 실행해 남은 리드를 연결한다(재실행 안전, 단 삭제된 연락처의 리드도 다시 연결될 수 있음).
- 회사 기능(`docs/companies`)의 운영 스키마도 아직 적용 전이다 — 같은 `schema.sql` 한 번으로 함께 적용된다.
