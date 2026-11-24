# CLAUDE.md

> 이 파일은 Claude가 이 저장소에서 작업할 때 매번 읽는 프로젝트 가이드입니다.
> 짧고 구체적으로 유지하세요.

## 프로젝트 개요

- **서비스**: Pipeline CRM — 세일즈 리드를 칸반 보드(Funnel)로 관리하는 웹앱. 카드를 Drag & Drop으로 단계 이동
- **주요 사용자**: 영업 담당자
- **핵심 도메인 용어**:
  - 리드(Lead): 영업 대상 회사 + 담당자 + 예상 금액
  - 단계(Stage): `new`(신규 리드) → `contacted`(첫 컨택) → `qualified`(니즈 확인) → `proposal`(제안/견적) → `negotiation`(협상) → `won`(수주) / `lost`(실주)
  - 우선순위(Priority): `high` / `mid` / `low`
  - 파이프라인: `won`·`lost`를 제외한 진행 중 리드의 금액 합계

## 기술 스택

- **프레임워크**: Next.js 16 (App Router, Turbopack), React 19
- **언어**: TypeScript (strict 모드)
- **스타일**: 일반 CSS — `web/app/globals.css` 한 파일, CSS 변수(디자인 토큰) + 라이트/다크 테마
- **상태/데이터**: React `useState` + 커스텀 훅 `useLeads` (fetch로 API 호출, 낙관적 업데이트)
- **검증**: 직접 작성한 검증 함수 (`web/lib/validate.ts`)
- **DB**: PostgreSQL + `pg` 드라이버 (ORM 없음, SQL 직접 작성)
  - 로컬: 로컬 PostgreSQL `ai_crm` DB
  - 배포: Supabase (`aicrm` 프로젝트, 도쿄 리전)
- **배포**: Vercel (`aicrm` 프로젝트, Root Directory = `web`, GitHub push 시 자동 배포)
- **인증**: 구글 로그인(직접 구현, DB 세션 + httpOnly 쿠키), `ALLOWED_EMAILS` 허용 목록. 아래 "로그인 / 구글 캘린더" 참고
- **테스트**: Vitest(unit·integration) + Playwright(e2e). 린트는 아직 없음
- **패키지 매니저**: npm
- **Node**: nvm으로 설치 (`nvm use node`)

## 자주 쓰는 명령어

앱 명령어는 모두 `web/` 폴더에서 실행합니다.

```bash
cd web
npm install          # 의존성 설치
npm run dev          # 개발 서버 (http://localhost:3000)
npm run build        # 프로덕션 빌드 (타입 체크 포함) — 작업 후 반드시 실행
npm run start        # 빌드 결과 실행
npm run db:init      # 테이블 생성 + 샘플 데이터 (테이블이 비어 있을 때만 시드)
```

```bash
# Supabase(배포 DB)에 SQL 실행 — 프로젝트 루트에서
npx supabase db query --remote=hwxuufpaupnpawlgnyvx --read-only "select count(*) from leads"
npx supabase db query --remote=hwxuufpaupnpawlgnyvx --yes -f web/db/schema.sql
```

## 디렉터리 구조

```
AI CRM/                      # git 저장소 루트
├── CLAUDE.md
├── prompts/history.md       # 사용자 프롬프트 기록 (아래 작업 규칙 참고)
├── index.html               # 초기 단독 HTML 프로토타입 (localStorage). 앱에서 사용 안 함
├── package.json             # 루트: Supabase CLI 전용 (앱 의존성 아님)
└── web/                     # Next.js 앱 (Vercel Root Directory)
    ├── app/
    │   ├── layout.tsx       # 폰트, 테마 깜빡임 방지 스크립트
    │   ├── (crm)/           # 경로 그룹: layout.tsx가 CrmApp을 렌더 → / 와 /meetings가 상태 공유
    │   │   ├── page.tsx         # / 파이프라인 (빈 page)
    │   │   └── meetings/page.tsx # /meetings 미팅 노트 (빈 page)
    │   ├── globals.css      # 모든 스타일
    │   └── api/leads/       # Route Handlers
    │       ├── route.ts             # GET 목록, POST 생성
    │       ├── [id]/route.ts        # PATCH 수정, DELETE 삭제
    │       └── [id]/move/route.ts   # POST 카드 이동 (stage + 순서)
    │   └── api/assistant/route.ts   # POST AI Assistant 질문 → OpenAI 답변
    │   └── api/meetings/            # 미팅 노트: route.ts(GET·POST), [id](GET·PATCH·DELETE), transcribe(음성→텍스트), summarize(AI 요약)
    ├── components/          # CrmApp, Header, StatsBar, Board, Column, LeadCard, LeadModal, Toast, AssistantPanel, MeetingList, NoteListItem, MeetingNoteModal, MeetingRecorder, CompanyList, CompanyDetail, CompanyModal, CompanyCombobox
    ├── lib/
    │   ├── db.ts            # 서버 전용: pg 커넥션 풀, 환경별 DB 선택
    │   ├── useLeads.ts      # 클라이언트 데이터 훅 (모든 데이터 변경의 단일 진입점)
    │   ├── validate.ts      # API 입력 검증
    │   ├── events.ts        # 서버 전용: lead_events 이력 기록, 트랜잭션 헬퍼
    │   ├── assistant.ts     # 서버 전용: 리드+이력+미팅 노트 컨텍스트 구성
    │   ├── openai.ts        # 서버 전용: OpenAI 채팅·전사 호출, 이메일·전화번호 마스킹
    │   ├── meetings.ts      # 서버 전용: 미팅 노트 컬럼/매핑/이력 diff, AI 요약
    │   ├── useMeetings.ts   # 클라이언트 미팅 노트 훅 · api.ts: fetch 헬퍼
    │   ├── audioFile.ts     # 클라이언트: 녹음 파일 → 업로드 가능한 WAV 구간으로 분할
    │   ├── companies.ts     # 서버 전용: 회사 컬럼/매핑, 리드 회사 결정, 중복(409) 처리
    │   ├── company.ts       # 공용 순수 함수: 회사명 정규화, 사업자번호·도메인, 검색, 회사별 집계 · useCompanies.ts: 클라이언트 훅
    │   ├── types.ts · constants.ts · format.ts
    └── db/
        ├── schema.sql       # 테이블/인덱스/RLS (IF NOT EXISTS로 재실행 안전)
        ├── seed.sql         # 샘플 데이터
        └── init.mjs         # npm run db:init
```

## 코딩 컨벤션

### 일반
- 컴포넌트는 `components/PascalCase.tsx`에 `export default function`으로 작성 (기존 패턴 유지).
- `lib/` 파일은 camelCase (`useLeads.ts`, `validate.ts`).
- `any` 사용 금지. 불가피하면 `unknown` 후 타입 가드.
- import 경로는 `@/` 별칭 사용 (`@/lib/...`, `@/components/...`).
- 단계·우선순위·색상 등 상수는 `lib/constants.ts`에 둠. 단계를 추가/변경하면 `db/schema.sql`의 CHECK 제약도 함께 수정.

### React / Next.js
- Next.js 16은 학습 데이터와 API가 다를 수 있음. 코드 작성 전 `web/node_modules/next/dist/docs/`의 해당 가이드를 확인 (`web/AGENTS.md` 참고).
- Route Handler의 `params`는 `Promise` — `const { id } = await params`.
- 상태·이벤트·브라우저 API가 필요한 컴포넌트만 `"use client"`.
- 클라이언트에서 DB 직접 접근 금지. 데이터 변경은 `app/api` Route Handler → `useLeads` 경유.
- `lib/db.ts`는 `server-only` — 클라이언트 컴포넌트에서 import 금지.

### 스타일
- `globals.css`의 CSS 변수(`--bg`, `--surface`, `--primary`, `--prio-*` 등)만 사용. 색상 하드코딩 지양.
- 새 색상 토큰은 라이트(`:root`)와 다크(두 군데: `prefers-color-scheme` 블록, `[data-theme="dark"]`) 모두에 정의.

### 데이터 / API
- 모든 API 입력은 `lib/validate.ts`로 검증. id는 `UUID_RE`로 확인.
- SQL은 항상 파라미터 바인딩(`$1, $2`) 사용. 문자열 연결로 SQL 작성 금지.
- 응답 형식: 성공 시 데이터 그대로(`Lead`, `Lead[]`), 실패 시 `{ error: "한국어 메시지" }` + 적절한 상태 코드.
- 카드 순서는 `position`(double precision) — 이웃 카드 position의 중간값으로 이동 (`move/route.ts`).
- 클라이언트 변경은 낙관적 업데이트 → 실패 시 `reload()`로 서버 상태 복구 + 에러 배너.
- 리드를 변경하는 API는 같은 트랜잭션에서 `lead_events`에 이력을 남김 (`lib/events.ts`의 `withTransaction` + `recordEvent`). 새 변경 API도 동일하게.
- AI Assistant는 조회 전용. OpenAI는 SDK 없이 `fetch`로 호출, 기본 모델 `gpt-6-luna`(`OPENAI_MODEL`로 변경). 이메일·전화번호는 OpenAI로 보내지 않음.

## 환경 변수 / DB 연결

| 환경 | 변수 | 대상 |
|---|---|---|
| 로컬 | `DATABASE_URL` (`web/.env.local`) | 로컬 PostgreSQL `ai_crm` (사용자 `crm_app`) |
| Vercel | `POSTGRES_URL` (Vercel 환경 변수, Sensitive) | Supabase pooler (`aws-0-ap-northeast-1.pooler.supabase.com:6543`, 사용자 `crm_app.<ref>`) |
| 공통 | `OPENAI_API_KEY` (로컬 `.env.local`, Vercel 환경 변수 Sensitive) | AI Assistant·미팅 노트 요약·녹음 전사용 OpenAI 키. 선택: `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `OPENAI_TRANSCRIBE_MODEL`(본문 전사, 기본 `gpt-4o-transcribe-diarize` 화자 구분) — 2027-02-26 지원 종료 예정이라 그 전에 교체 필요 |

- 선택 로직은 `lib/db.ts`의 `connectionConfig()`. Vercel에서는 `POSTGRES_URL` 우선.
- 원격 DB는 SSL 사용, URL의 `sslmode` 파라미터는 제거 후 `ssl` 옵션으로 지정 (pg가 검증 모드로 해석해 실패하므로).
- Supabase 직접 호스트(`db.<ref>.supabase.co`)는 IPv6 전용이라 Vercel에서 접속 불가 → 반드시 pooler 사용.
- 새 환경 변수는 `web/.env.example`에 키만 추가.

## 테스트

`web/` 폴더에서 실행. 작업 완료 전 `npm run build`(타입 체크) + 관련 테스트 통과 확인.

```bash
npm test                  # unit + integration (Vitest)
npm run test:unit         # 순수 함수·OpenAI 응답 처리 (DB·네트워크 없음, fetch는 가짜)
npm run test:integration  # Route Handler를 로컬 테스트 DB에 직접 호출
npm run test:e2e          # Playwright: 테스트 DB에 연결한 dev 서버(3100)를 띄워 Chrome으로 확인
```

- 위치: `web/test/unit`, `web/test/integration`, `web/e2e`. 설정: `vitest.config.mts`, `playwright.config.ts`.
- **테스트 DB**: 로컬 `ai_crm_test` (없으면 자동 생성 + `schema.sql` 적용, 테스트마다 TRUNCATE).
  `TEST_DATABASE_URL`로 변경 가능하지만(다른 worktree·세션이 동시에 테스트하면 데이터가 서로 지워지므로 `ai_crm_test_<작업명>`처럼 따로 쓰는 것을 권장) 로컬의 이름에 `test`가 들어간 DB만 허용 — 개발(`ai_crm`)·운영 DB를 넣지 말 것.
- OpenAI는 실제로 호출하지 않는다: unit·integration은 `fetch`를, e2e는 `page.route`로 API 응답을 가짜로 대체. e2e 녹음은 가짜 마이크(`getUserMedia` 대체) 사용.
- e2e는 설치된 Chrome(`channel: "chrome"`)을 쓰므로 브라우저 다운로드 불필요. 순서대로 1개씩 실행(같은 DB).
- e2e 로그인: `e2e/global-setup.ts`가 테스트 DB에 테스트 사용자·세션을 만들고 모든 요청에 세션 쿠키를 붙인다(서버 `ALLOWED_EMAILS`=테스트 계정). 노트 저장 후 자동 요약·다음 미팅 추출은 `fakeNoteAi`로 가짜 응답.
- 새 기능을 추가하면 중요한 흐름은 테스트를 함께 추가. API 변경 시 integration 테스트로 이력(`lead_events`) 기록까지 확인.

## Git / 작업 규칙

- 현재 `main` 브랜치에 직접 커밋, GitHub `noreply319/aicrm`에 push → Vercel 자동 배포.
- commit·push는 사용자가 요청할 때만. 기본적으로 사용자가 직접 실행하므로 명령어를 안내.
- zsh 사용 — 명령어 안내 시 `!`가 들어간 문자열은 작은따옴표로 감쌀 것 (히스토리 확장 에러 방지).
- **사용자의 모든 프롬프트를 `prompts/history.md`에 기록**: 번호, 날짜, 제목, 프롬프트 원문 인용, 결과 한 줄.

### Git worktree

- 별도 브랜치 작업용 worktree는 저장소 안의 **`worktress/`** 폴더에 만든다 (`.gitignore`에 포함).
  ```bash
  # 프로젝트 루트에서
  git worktree add worktress/<작업명> -b <브랜치명> main
  cd worktress/<작업명>/web && npm install   # worktree마다 node_modules 따로 설치
  git worktree list                          # 목록
  git worktree remove worktress/<작업명>      # 작업 후 정리 (브랜치는 merge 후 git branch -d)
  ```
- worktree에는 `.env.local`이 없다(커밋되지 않음). 필요하면 원본의 `web/.env.local`을 복사하되 커밋하지 않는다. 테스트는 `.env.local` 없이 동작한다.
- 원본 checkout에서 `npm run dev`가 3000을 쓰고 있으면 worktree에서는 다른 포트(`npx next dev -p 3001`)를 쓴다. 다른 사람이 띄운 dev 서버를 포트 기준으로 종료하지 말 것.

## 보안 / 하지 말아야 할 것

- `.env*` 파일, DB 비밀번호, 토큰을 커밋하거나 코드에 하드코딩하지 않음. 출력에 비밀번호를 노출하지 않음.
- **인증**: `web/proxy.ts`가 `/login`·`/api/auth/*` 외 모든 페이지·API에서 세션을 확인 (페이지 → /login, API → 401, 다른 사이트의 변경 요청 → 403). 새 API도 자동 보호됨. 데이터는 로그인 사용자 전체(팀) 공유.
- 구글 리프레시 토큰은 `TOKEN_ENCRYPTION_KEY`로 암호화해 `users`에 저장. 토큰·세션 값은 로그·응답에 남기지 않음.
- Supabase `leads` 테이블은 RLS 활성화 + `crm_app` 역할 전용 정책만 존재 (anon/authenticated 차단). 새 테이블도 RLS를 켜고 정책을 명시.
- Supabase(운영 DB)에 쓰기 SQL 실행, 테이블 삭제, 데이터 삭제, 비밀번호 변경 등 되돌리기 어려운 작업은 실행 전 반드시 확인 요청. 조회는 `--read-only` 사용.
- 새 패키지 추가 전 기존 의존성으로 해결 가능한지 검토하고, 추가 시 이유를 설명. 버전은 정확히 고정(`--save-exact`)하고 `npm audit` 확인.
- 자동 생성 파일(`web/next-env.d.ts`, `web/AGENTS.md`의 Next.js 블록, `.vercel/`)은 직접 수정하지 않음.

## Claude 작업 방식

- 큰 변경 전에는 계획을 먼저 짧게 제시하고 진행.
- 기존 코드 패턴을 먼저 찾아보고 그와 일관되게 작성.
- 확실하지 않은 요구사항은 추측하지 말고 질문.
- 사용자가 "명령어만 알려줘"처럼 범위를 정하면 그 범위만 답변.
- 작업 후 변경한 파일과 확인 방법을 간단히 요약.
- 답변과 코드 주석은 한국어, 변수·함수명은 영어.

## 로그인 / 구글 캘린더

- 문서: `docs/google-calendar/requirements.md`
- 흐름: `/login` → `/api/auth/google`(openid email profile) → `/api/auth/callback` → 세션 쿠키 7일. 설정 → Google 연동은 `/api/calendar/connect`로 캘린더 권한 추가(같은 콜백, state 쿠키의 purpose로 구분).
- 구글 OAuth 앱은 "외부 + 테스트" 상태 → 리프레시 토큰 7일 만료. 만료되면 `users.calendar_expired = true`, 설정에서 다시 연동.
- 서버: `lib/auth.ts`(세션·허용 이메일), `lib/google.ts`(OAuth·토큰), `lib/calendar.ts`(Calendar REST, fetch), `lib/schedules.ts`(노트 → 다음 미팅 후보 AI 추출), `lib/crypto.ts`.
- API: `/api/me`, `/api/calendar/{connect,connection,calendars,events,events/[eventId]}`, `/api/schedules`, `/api/meetings/[id]/schedule-candidates`.
- 화면: 헤더 메뉴 `캘린더`(`/calendar`, CalendarView·EventModal), `설정`(`/settings`, SettingsView). 노트 저장 후 ScheduleSuggestModal, 리드 상세 `다음 미팅` 탭.
- 테이블: `users`, `sessions`, `scheduled_meetings`(candidate → scheduled/dismissed, scheduled → canceled). 이력 타입 `meeting_scheduled/rescheduled/canceled`, `lead_events.user_id`(변경자).
- 노트 저장 시 날짜·시간이 확정된 다음 미팅은 확인 없이 자동 등록(`extractAndAutoRegister`), 시간 미정은 후보. CRM 일정 제목은 구글에 `[AI CRM]` 접두어(`CRM_TITLE_PREFIX`), DB에는 접두어 없이 저장.
- 일정 수정·삭제는 CRM에서 등록한 **본인** 일정만. AI Assistant는 `list_calendar_events` 도구(function calling)로 본인 캘린더 조회 — 제목·시간·장소만 OpenAI로 전송.
- 로컬 OAuth 콜백은 `http://localhost:3000/api/auth/callback`만 등록돼 있으므로 개발 서버는 3000 포트로 실행.

## Gmail 연동

- 설정 → Gmail → `/api/gmail/connect`로 `gmail.readonly` 권한 추가 (같은 콜백, purpose `gmail`). Google Cloud Console에서 **Gmail API 사용 설정** 필요, 테스트 사용자만 사용 가능(제한 범위).
- 리프레시 토큰은 사용자당 하나(`users.google_refresh_token`)를 캘린더·Gmail이 공유. 기능별 사용 여부는 `users.calendar_enabled`·`gmail_enabled`, 만료는 `calendar_expired`(공통). 상태 계산은 `lib/auth.ts`의 `featureState()`.
- 연동 해제(`disconnectFeature`): 다른 기능이 켜져 있으면 해당 기능만 끄고, 마지막 기능이면 구글에 토큰 폐기 후 삭제 (구글 폐기는 앱 권한 전체를 없애므로).
- 서버: `lib/gmail.ts`(Gmail REST, fetch). 검색 대상은 `leadTarget()`: 리드 이메일이 회사 도메인이면 `@도메인` 전체(같은 회사 다른 사람 포함, 화면에 "회사" 배지), 무료 메일(`FREE_MAIL_DOMAINS`)·내 계정과 같은 도메인이면 담당자 주소만. 검색어 `{from:x to:x cc:x bcc:x}` 후 헤더로 정확히 다시 거른다(`involvesTarget`).
- 메일 캐시 `lead_emails`(`lib/emailStore.ts`): 사용자·리드별로 제목·헤더·미리보기·AI 요약 저장, **본문은 저장 안 함**(요약할 때·열 때만 Gmail에서 읽음). 동기화는 Gmail id 목록만 받아 처음 보는 메일만 저장 → `summary_status = pending` → 10건씩 묶어 OpenAI 요약(`done`/`failed`). 이미 저장·요약한 메일은 다시 불러오거나 요약하지 않음. Gmail 연동 해제 시 해당 사용자 행 삭제.
- API: `/api/gmail/{connect,connection}`, `/api/leads/[id]/emails`(GET 저장된 목록, Gmail 호출 없음), `.../emails/sync`(POST 새 메일 저장, `{pageToken}`이면 이전 페이지), `.../emails/summarize`(POST pending 요약, 최대 20건, `{retryFailed}`), `.../emails/[messageId]`(본문 — 리드 주소가 헤더에 있는 메일만).
- 화면: 리드 상세 `이메일` 탭(`LeadEmails`: 저장 목록 즉시 표시 → sync → summarize, 목록에 AI 요약), 설정 Gmail 카드.
- AI Assistant: 컨텍스트 `emails`에 **질문과 관련된 저장 메일만**(`findRelevantEmails`: 질문에 나온 회사·담당자의 메일 + 제목·요약 키워드 일치, 최대 30건, 제목·요약만). `search_lead_emails` 도구는 저장된 요약 검색(leadId면 새 메일 동기화·요약 후). 이메일 주소는 이름만 남기고 제목·요약은 `maskPii` 후 전송.

## 회사

- 문서: `docs/companies/requirements.md`(13장: 구현하면서 바뀐 점), `docs/companies/wireframe.html`
- 테이블 `companies`(정규화 키 `name_key` 유니크, `email_domain` 유니크), `leads.company_id`(FK `ON DELETE RESTRICT` → 리드가 있는 회사는 삭제 불가).
  `leads.company`는 **회사명 사본**으로 유지 — 회사명을 바꾸면 `PATCH /api/companies/[id]`가 같은 트랜잭션에서 연결 리드의 사본을 바꾸고 리드마다 `updated {company}` 이력을 남긴다.
- 정규화: SQL `crm_company_key()` = `lib/company.ts` `companyKey()` (소문자, 공백 제거, (주)·㈜·주식회사·(유)·유한회사 제거). 바꾸면 둘 다 수정 (integration 테스트로 비교).
- 리드 API: `companyId`로 회사 지정(회사명은 서버가 채움). `companyId` 없이 `company`만 오면 같은 이름의 회사를 찾거나 만든다(`resolveLeadCompany`). 마이그레이션은 `crm_link_lead_companies()`(schema.sql·seed.sql 끝에서 호출, 재실행 안전).
- API: `/api/companies`(GET·POST, 409면 `{ error, company: 기존 회사 }`), `/api/companies/[id]`(GET·PATCH·DELETE), `/api/team`(담당 영업 선택용 팀원 id·이름).
- 화면: 헤더 `회사`(`/companies` CompanyList, `/companies/[id]` CompanyDetail), CompanyModal(등록·수정), 리드 모달 CompanyCombobox(검색·키보드 선택·이름만으로 바로 생성). 회사별 리드 수·금액은 클라이언트 `leads`로 계산(`statsByCompany`).
- AI Assistant 컨텍스트 `companies`: 이름·업종·규모·등급·태그·담당 영업·도메인, 메모는 질문에 회사명이 나온 회사만. 전화·주소·사업자번호·대표자명은 보내지 않음.

## 참고 문서

- Next.js 16 문서: `web/node_modules/next/dist/docs/`
- Vercel 모범 사례: 루트 `AGENTS.md`
- 배포: Vercel 프로젝트 `aicrm` (팀 `no-margin`), Supabase 프로젝트 `aicrm` (ref `hwxuufpaupnpawlgnyvx`)
