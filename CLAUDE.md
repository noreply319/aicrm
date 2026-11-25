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
    │   ├── (crm)/           # 경로 그룹: layout.tsx가 CrmApp을 렌더 → 모든 화면이 상태 공유
    │   │   ├── page.tsx         # / 첫 화면: AI Assistant 대화 (빈 page)
    │   │   ├── pipeline/page.tsx # /pipeline 파이프라인 (빈 page)
    │   │   └── meetings/page.tsx # /meetings 미팅 노트 (빈 page)
    │   ├── globals.css      # 모든 스타일
    │   └── api/leads/       # Route Handlers
    │       ├── route.ts             # GET 목록, POST 생성
    │       ├── [id]/route.ts        # PATCH 수정, DELETE 삭제
    │       └── [id]/move/route.ts   # POST 카드 이동 (stage + 순서)
    │   └── api/assistant/route.ts   # POST AI Assistant 질문 → OpenAI 답변
    │   └── api/meetings/            # 미팅 노트: route.ts(GET·POST), [id](GET·PATCH·DELETE), transcribe(음성→텍스트), summarize(AI 요약)
    ├── components/          # CrmApp, Sidebar(왼쪽 메뉴), Header(상단 바), StatsBar, Board, Column, LeadCard, LeadModal, Toast, AssistantPanel(일반 대화·견적서 탭), QuoteChat, MeetingList, NoteListItem, MeetingNoteModal, MeetingRecorder, ContractsView·DocAssistant·DocPaper·SendDocModal·TemplateEditor(계약서), CompanyList, CompanyDetail, CompanyModal, CompanyCombobox, ContactList, ContactDetail, ContactModal, ContactCombobox
    │   └── ui/              # 디자인 시스템 컴포넌트: Button·IconButton, Badge, Field·Input·Select·Textarea·Checkbox, Tabs, Alert, Panel, EmptyState, Avatar, Icon, Modal (index.ts에서 import)
    ├── assets/fonts/        # PDF 한글 폰트 (나눔고딕, OFL)
    ├── lib/
    │   ├── db.ts            # 서버 전용: pg 커넥션 풀, 환경별 DB 선택
    │   ├── useLeads.ts      # 클라이언트 데이터 훅 (모든 데이터 변경의 단일 진입점)
    │   ├── validate.ts      # API 입력 검증
    │   ├── events.ts        # 서버 전용: lead_events 이력 기록, 트랜잭션 헬퍼
    │   ├── assistant.ts     # 서버 전용: 리드+이력+미팅 노트 컨텍스트 구성
    │   ├── openai.ts        # 서버 전용: OpenAI 채팅·전사 호출, 이메일·전화번호 마스킹
    │   ├── meetings.ts      # 서버 전용: 미팅 노트 컬럼/매핑/이력 diff, AI 요약
    │   ├── useMeetings.ts   # 클라이언트 미팅 노트 훅 · api.ts: fetch 헬퍼
    │   ├── useDocDraft.ts   # 클라이언트: 문서 작성 대화 상태 (ContractsView·QuoteChat 공용)
    │   ├── audioFile.ts     # 클라이언트: 녹음 파일 → 업로드 가능한 WAV 구간으로 분할
    │   ├── companies.ts     # 서버 전용: 회사 컬럼/매핑, 리드 회사 결정, 중복(409) 처리
    │   ├── company.ts       # 공용 순수 함수: 회사명 정규화, 사업자번호·도메인, 검색, 회사별 집계 · useCompanies.ts: 클라이언트 훅
    │   ├── contacts.ts      # 서버 전용: 연락처 컬럼/매핑, 리드 담당자 사본 채움·전파, 중복(409) 처리
    │   ├── contact.ts       # 공용 순수 함수: 이름 키, 담당자 사본, 검색, 연락처별 집계 · useContacts.ts: 클라이언트 훅
    │   ├── businessCard.ts  # 서버 전용: 명함 이미지 분석(OpenAI 비전)·기존 회사/연락처 찾기·한 트랜잭션 저장 · useBusinessCards.ts·imageFile.ts: 클라이언트
    │   ├── types.ts · constants.ts · format.ts
    └── db/
        ├── schema.sql       # 테이블/인덱스/RLS (IF NOT EXISTS로 재실행 안전)
        ├── seed.sql         # 샘플 데이터
        ├── templates.sql    # 계약서·견적서 템플릿 추가 (같은 이름 있으면 건너뜀, 로컬·운영에 직접 실행)
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

### 스타일 / 디자인 시스템 (Evergreen — Greenhouse 계열 에버그린·그린·민트)
- 문서: `docs/design-system/design-system.html`(토큰·컴포넌트 카탈로그, 앱 `globals.css`를 그대로 불러옴), `wireframe.html`(사이드바 레이아웃).
- 버튼·배지·입력·탭·알림·모달·빈 상태·아바타는 `@/components/ui`만 사용. `<button className="btn …">`, 새 `.xxx-pill` 클래스 등 직접 마크업 금지. 모달의 Esc·바깥 클릭은 `Modal`이 처리.
- 우선순위 색은 `PRIORITY_TONE`, 연동 상태는 `STATE_TONE`(Sidebar.tsx) → Badge tone. e2e가 쓰는 클래스(`.card`, `.note-badge`, `.unassigned-pill`, `.autosave-note` 등)는 className으로 유지.
- 메뉴는 왼쪽 `Sidebar`의 `NAV`에만 추가(1024px 이하 아이콘 레일, 640px 이하는 상단 바 왼쪽 햄버거 버튼 → 화면 전체를 덮는 메뉴 `.sidebar.menu-open`, 하단 탭 없음). 상단 바(`Header`)는 (모바일 햄버거)·제목·검색·테마·Assistant·추가 버튼.
- 메뉴 접기(`html.sb-collapsed`, `crm.sidebar`)·Assistant 숨기기(`.assistant.closed`, `crm.assistant`)는 localStorage에 저장, 첫 페인트 전 적용은 `layout.tsx` 스크립트. 전환 애니메이션은 `html.ui-anim`이 붙은 뒤에만.
- `globals.css`의 CSS 변수(`--bg`, `--surface`, `--primary`, `--primary-soft`, `--success-*`/`--warning-*`/`--danger-*`/`--info-*`, `--sidebar-*` 등)만 사용. 색상 하드코딩 지양.
- 새 색상 토큰은 라이트(`:root`)와 다크(`[data-theme="dark"]`) 모두에 정의. 다크는 테마 버튼으로만 켜짐(기기 다크 모드 안 따름).
- 설정은 메뉴가 아닌 모달: 프로필 메뉴 "설정" 또는 `useOpenSettings()`(`lib/settingsModal.ts`)로 연다. `/settings` 주소(OAuth 복귀)도 모달로 열림. AI Assistant는 상단 바 아래~화면 끝 고정 패널로 메인과 나란히(641px 이상, 겹치지 않음) — 메인(`.workspace-main`)은 메뉴·Assistant를 뺀 남은 폭 전체를 쓰고 숨기거나 접으면 넓어짐. 모바일(640px 이하) 다른 화면에서는 상단 바 `AI` 버튼 → 상단 바·메인을 숨기고 채팅이 화면 전체를 쓰는 별도 화면(`.app-shell.ai-open`, 팝업·시트 아님), 상단 왼쪽 뒤로 가기로 닫음.
- 첫 화면 `/`(view `assistant`, 메뉴 `AI Assistant`)는 같은 `AssistantPanel`이 메인 영역 전체를 쓰는 대화 화면(`.app-shell.home`, 숨기기·뒤로 가기 없음, 상단 바 유지, 대화 내용은 가운데 880px). 파이프라인은 `/pipeline`. 패널은 언마운트하지 않으므로 첫 화면과 다른 화면 패널의 대화가 이어진다.
- Assistant 패널 상단 탭 `일반 대화`(조회형, `/api/assistant`) / `견적서`(`QuoteChat` — 계약서 메뉴의 `DocAssistant`를 견적서 템플릿만으로 재사용, `문서 보기` 모달로 미리보기·직접 수정, PDF·메일). 견적서 탭은 처음 누를 때 만들고 이후 탭을 바꿔도 유지.

### 데이터 / API
- 모든 API 입력은 `lib/validate.ts`로 검증. id는 `UUID_RE`로 확인.
- SQL은 항상 파라미터 바인딩(`$1, $2`) 사용. 문자열 연결로 SQL 작성 금지.
- 응답 형식: 성공 시 데이터 그대로(`Lead`, `Lead[]`), 실패 시 `{ error: "한국어 메시지" }` + 적절한 상태 코드.
- 카드 순서는 `position`(double precision) — 이웃 카드 position의 중간값으로 이동 (`move/route.ts`).
- 클라이언트 변경은 낙관적 업데이트 → 실패 시 `reload()`로 서버 상태 복구 + 에러 배너.
- 리드를 변경하는 API는 같은 트랜잭션에서 `lead_events`에 이력을 남김 (`lib/events.ts`의 `withTransaction` + `recordEvent`). 새 변경 API도 동일하게.
- AI Assistant는 조회 전용(예외: 명함 확인 카드에서 사용자가 `생성`을 누를 때 회사·연락처 저장). OpenAI는 SDK 없이 `fetch`로 호출, 기본 모델 `gpt-6-luna`(`OPENAI_MODEL`로 변경). 이메일·전화번호는 OpenAI로 보내지 않음 — **유일한 예외는 명함 이미지 분석**(아래 "명함").

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
- `schema.sql`이 바뀐 커밋을 받거나 병합한 뒤에는 로컬 DB에 `npm run db:init` 실행(운영은 위 Supabase 명령). 안 하면 새 이력 타입·컬럼에서 CHECK 위반(23514)·없는 컬럼 에러로 500 — `withTransaction`이 이런 에러면 서버 로그에 안내를 남긴다. 테이블은 `crm_app` 소유로 만들 것(다른 계정으로 `schema.sql`을 실행하면 이후 `db:init`이 "must be owner"로 실패).

## 테스트

`web/` 폴더에서 실행. 작업 완료 전 `npm run build`(타입 체크) + 관련 테스트 통과 확인.

```bash
npm test                  # unit + integration (Vitest)
npm run test:unit         # 순수 함수·OpenAI 응답 처리 (DB·네트워크 없음, fetch는 가짜)
npm run test:integration  # Route Handler를 로컬 테스트 DB에 직접 호출
npm run test:e2e          # Playwright: 테스트 DB에 연결한 dev 서버(3100, E2E_PORT로 변경)를 띄워 Chrome으로 확인
```

- 위치: `web/test/unit`, `web/test/integration`, `web/e2e`. 설정: `vitest.config.mts`, `playwright.config.ts`.
- **테스트 DB**: 로컬 `ai_crm_test` (없으면 자동 생성 + `schema.sql` 적용, 테스트마다 TRUNCATE).
  `TEST_DATABASE_URL`로 변경 가능하지만(다른 worktree·세션이 동시에 테스트하면 데이터가 서로 지워지므로 `ai_crm_test_<작업명>`처럼 따로 쓰는 것을 권장) 로컬의 이름에 `test`가 들어간 DB만 허용 — 개발(`ai_crm`)·운영 DB를 넣지 말 것.
- OpenAI는 실제로 호출하지 않는다: unit·integration은 `fetch`를, e2e는 `page.route`로 API 응답을 가짜로 대체. e2e 녹음은 가짜 마이크(`getUserMedia` 대체) 사용.
- e2e는 설치된 Chrome(`channel: "chrome"`)을 쓰므로 브라우저 다운로드 불필요. 순서대로 1개씩 실행(같은 DB).
- 여러 워크트리에서 동시에 테스트하면 같은 DB·포트를 써서 서로 데이터를 지운다 → 워크트리별로 `TEST_DATABASE_URL=postgresql://localhost:5432/ai_crm_<작업명>_test`, `E2E_PORT=3101` 등을 지정.
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
- 화면: 메뉴 `캘린더`(`/calendar`, CalendarView·EventModal), 설정 모달(SettingsView, 프로필 메뉴 또는 `/settings`). 노트 저장 후 ScheduleSuggestModal, 리드 상세 `다음 미팅` 탭.
- 테이블: `users`, `sessions`, `scheduled_meetings`(candidate → scheduled/dismissed, scheduled → canceled). 이력 타입 `meeting_scheduled/rescheduled/canceled`, `lead_events.user_id`(변경자).
- 노트 저장 시 날짜·시간이 확정된 다음 미팅은 확인 없이 자동 등록(`extractAndAutoRegister`), 시간 미정은 후보. CRM 일정 제목은 구글에 `[AI CRM]` 접두어(`CRM_TITLE_PREFIX`), DB에는 접두어 없이 저장.
- 일정 수정·삭제는 CRM에서 등록한 **본인** 일정만. AI Assistant는 `list_calendar_events` 도구(function calling)로 본인 캘린더 조회 — 제목·시간·장소만 OpenAI로 전송.
- 로컬 OAuth 콜백은 `http://localhost:3000/api/auth/callback`만 등록돼 있으므로 개발 서버는 3000 포트로 실행.

## Gmail 연동

- 설정 → Gmail → `/api/gmail/connect`로 `gmail.readonly` + `gmail.send` 권한 추가 (같은 콜백, purpose `gmail`, `?next=`로 돌아갈 화면 지정 가능). 발송 권한 여부는 `users.google_scopes`로 판단(`canSendGmail`, `/api/me`의 `gmail.canSend`) — 발송 기능 도입 전에 연동한 사용자는 다시 연동해야 함. Google Cloud Console에서 **Gmail API 사용 설정** 필요, 테스트 사용자만 사용 가능(제한 범위).
- 리프레시 토큰은 사용자당 하나(`users.google_refresh_token`)를 캘린더·Gmail이 공유. 기능별 사용 여부는 `users.calendar_enabled`·`gmail_enabled`, 만료는 `calendar_expired`(공통). 상태 계산은 `lib/auth.ts`의 `featureState()`.
- 연동 해제(`disconnectFeature`): 다른 기능이 켜져 있으면 해당 기능만 끄고, 마지막 기능이면 구글에 토큰 폐기 후 삭제 (구글 폐기는 앱 권한 전체를 없애므로).
- 서버: `lib/gmail.ts`(Gmail REST, fetch). 검색 대상은 `leadTarget()`: 리드 이메일이 회사 도메인이면 `@도메인` 전체(같은 회사 다른 사람 포함, 화면에 "회사" 배지), 무료 메일(`FREE_MAIL_DOMAINS`)·내 계정과 같은 도메인이면 담당자 주소만. 검색어 `{from:x to:x cc:x bcc:x}` 후 헤더로 정확히 다시 거른다(`involvesTarget`).
- 메일 캐시 `lead_emails`(`lib/emailStore.ts`): 사용자·리드별로 제목·헤더·미리보기·AI 요약 저장, **본문은 저장 안 함**(요약할 때·열 때만 Gmail에서 읽음). 동기화는 Gmail id 목록만 받아 처음 보는 메일만 저장 → `summary_status = pending` → 10건씩 묶어 OpenAI 요약(`done`/`failed`). 이미 저장·요약한 메일은 다시 불러오거나 요약하지 않음. Gmail 연동 해제 시 해당 사용자 행 삭제.
- API: `/api/gmail/{connect,connection}`, `/api/leads/[id]/emails`(GET 저장된 목록, Gmail 호출 없음), `.../emails/sync`(POST 새 메일 저장, `{pageToken}`이면 이전 페이지), `.../emails/summarize`(POST pending 요약, 최대 20건, `{retryFailed}`), `.../emails/[messageId]`(본문 — 리드 주소가 헤더에 있는 메일만).
- 화면: 리드 상세 `이메일` 탭(`LeadEmails`: 저장 목록 즉시 표시 → sync → summarize, 목록에 AI 요약), 설정 Gmail 카드.
- AI Assistant: 컨텍스트 `emails`에 **질문과 관련된 저장 메일만**(`findRelevantEmails`: 질문에 나온 회사·담당자의 메일 + 제목·요약 키워드 일치, 최대 30건, 제목·요약만). `search_lead_emails` 도구는 저장된 요약 검색(leadId면 새 메일 동기화·요약 후). 이메일 주소는 이름만 남기고 제목·요약은 `maskPii` 후 전송.

## 계약서·견적서

- 문서: `docs/contracts/requirements.md`, `docs/contracts/wireframe.html`
- 화면: 왼쪽 메뉴 `계약서`(`/contracts`, `ContractsView`) — 탭 `새 문서`(왼쪽 `DocAssistant` / 오른쪽 `DocPaper`), `작성한 문서`, `템플릿`(`TemplateEditor`). 메일은 `SendDocModal`. 이 화면에서는 조회형 AI Assistant 패널을 숨긴다.
- 템플릿: 본문의 `{{항목}}`이 바뀌는 부분(`#` 제목, `##` 조항, `-` 목록, `{{품목표}}` 견적 표). 예약 항목: 자동 `{{문서번호}} {{작성일}} {{문서명}} {{작성자}} {{작성자_이메일}}`, 견적 계산 `{{공급가액}} {{부가세}} {{합계}} {{합계_한글}}`. 항목 설정은 저장할 때 본문·메일 양식에 맞춰 동기화(`syncFields`).
- 공용 로직 `lib/docTemplate.ts`(서버·클라이언트): 본문 블록, 값 해석(날짜·금액·기간·선택지 등), 합계·한글 금액, 종료일 자동 계산. 서버 `lib/documents.ts`(조회·저장, `rev`로 동시 수정 감지), `lib/docChat.ts`(대화 엔진), `lib/pdf.ts`(pdf-lib), `lib/mime.ts`(첨부 메일).
- 대화: 다음 질문은 **서버가 결정**(리드 → 견적 품목 → 빈 항목 순서대로 → 완성). 답변은 규칙으로 먼저 해석하고 안 될 때만 OpenAI. OpenAI에는 항목 이름·유형·보기, 품목, 이번 답변(`maskPii`)만 보내고 문서 본문·다른 값·리드 연락처는 보내지 않는다. 이메일·전화번호 항목은 AI로 채우지 않는다.
- 문서는 생성 시점의 템플릿을 복사(snapshot)해 가진다. 상태 `draft → completed → sent`, 발송한 문서는 수정·삭제 불가(복제로 새 문서번호).
- PDF: 나눔고딕(`web/assets/fonts`, OFL) 전체 임베드(pdf-lib subset은 한글이 깨짐, 약 750KB). `next.config.ts`의 `outputFileTracingIncludes`로 배포 번들에 포함.
- 발송: `/api/documents/[id]/send` → Gmail `messages.send` → 같은 트랜잭션에서 `document_sends`(받는 사람 주소), 문서 `sent`, `lead_events.document_sent`(주소 없이 받는 사람 수만 — Assistant 컨텍스트로 쓰이므로). 발송 후 리드 단계 이동은 버튼 제안만(견적서 → 제안/견적, 계약서 → 협상).
- 테이블: `document_templates`, `documents`(`field_values` — `values`는 예약어), `document_sends`.
- API: `/api/templates`(GET·POST), `[id]`(GET·PATCH·DELETE 보관한 것만), `[id]/duplicate`, `defaults`(기본 템플릿) · `/api/documents`(GET·POST), `[id]`(GET·PATCH 직접 수정·DELETE), `[id]/chat`, `[id]/duplicate`, `[id]/pdf`, `[id]/email-draft`, `[id]/send`.

## 회사

- 문서: `docs/companies/requirements.md`(13장: 구현하면서 바뀐 점), `docs/companies/wireframe.html`
- 테이블 `companies`(정규화 키 `name_key` 유니크, `email_domain` 유니크), `leads.company_id`(FK `ON DELETE RESTRICT` → 리드가 있는 회사는 삭제 불가).
  `leads.company`는 **회사명 사본**으로 유지 — 회사명을 바꾸면 `PATCH /api/companies/[id]`가 같은 트랜잭션에서 연결 리드의 사본을 바꾸고 리드마다 `updated {company}` 이력을 남긴다.
- 정규화: SQL `crm_company_key()` = `lib/company.ts` `companyKey()` (소문자, 공백 제거, (주)·㈜·주식회사·(유)·유한회사 제거). 바꾸면 둘 다 수정 (integration 테스트로 비교).
- 리드 API: `companyId`로 회사 지정(회사명은 서버가 채움). `companyId` 없이 `company`만 오면 같은 이름의 회사를 찾거나 만든다(`resolveLeadCompany`). 마이그레이션은 `crm_link_lead_companies()`(schema.sql·seed.sql 끝에서 호출, 재실행 안전).
- API: `/api/companies`(GET·POST, 409면 `{ error, company: 기존 회사 }`), `/api/companies/[id]`(GET·PATCH·DELETE), `/api/team`(담당 영업 선택용 팀원 id·이름).
- 화면: 사이드바 `회사`(`/companies` CompanyList, `/companies/[id]` CompanyDetail), CompanyModal(등록·수정), 리드 모달 CompanyCombobox(검색·키보드 선택·이름만으로 바로 생성). 회사별 리드 수·금액은 클라이언트 `leads`로 계산(`statsByCompany`).
- AI Assistant 컨텍스트 `companies`: 이름·업종·규모·등급·태그·담당 영업·도메인, 메모는 질문에 회사명이 나온 회사만. 전화·주소·사업자번호·대표자명은 보내지 않음.

## 연락처

- 문서: `docs/contacts/requirements.md`(13장: 구현하면서 정한 점), `docs/contacts/wireframe.html`
- 테이블 `contacts`(이메일 소문자, 빈 값이 아니면 유니크 `contacts_email_idx`, `company_id` 선택 — 회사 삭제 시 NULL), `leads.contact_id`(FK `ON DELETE SET NULL`).
  리드의 `contact`·`title`·`email`·`phone`은 **담당자 사본** — 리드 API는 `contactId`가 있으면 연락처 값으로 채우고(전화 = 휴대폰, 없으면 유선), `PATCH /api/contacts/[id]`는 연결된 **모든** 리드의 사본을 같은 트랜잭션에서 바꾸고 리드마다 `updated {…, via: "contact"}` 이력. 삭제는 리드 연결만 끊고 사본은 남김(`via: "contact_deleted"`).
- 마이그레이션 `crm_link_lead_contacts()`(이메일 같으면 한 사람, 없으면 회사+`crm_person_key` 이름)는 `crm_migrations`에 기록해 **한 번만** 실행. `crm_person_key()` = `lib/contact.ts` `personKey()`.
- API: `/api/contacts`(GET·POST, 409면 `{ error, contact: 기존 연락처 }`), `/api/contacts/[id]`(GET·PATCH·DELETE).
- 화면: 사이드바 `연락처`(`/contacts` ContactList, `/contacts/[id]` ContactDetail), ContactModal, 리드 모달 ContactCombobox(회사 연락처 먼저, 간이 생성 폼, `연락처 수정`은 리드 모달 위에 ContactModal), 회사 상세 소속 연락처.
- AI Assistant 컨텍스트 `contacts`: 이름·회사·부서·직함·역할·태그·담당 영업, 메모는 질문에 이름이 나온 사람만. 이메일·전화·LinkedIn은 보내지 않음.

## Sales Agent

- 문서: `docs/agent/security.md`(승인 모델·OpenAI로 보내는 데이터·인젝션 대비·사용량 제한·감사 기록)
- 화면: 사이드바 `Sales Agent`(`/agent`, `AgentView`·`useAgentChat`) — NDJSON 스트림(진행 단계·답변·실행 계획 카드), 승인·취소·수정 요청, 초안 카드, 발송 후 단계 이동 같은 후속 계획 카드.
- 엔진 `lib/agent.ts`: 조회 도구는 바로, 변경 도구는 `agent_actions`에 `pending`으로 저장 → `decideAction`(본인만·한 번만·1시간 만료·`expect` 충돌 확인·같은 트랜잭션 실행, 커밋 후 `after`·`next`). 도구는 `lib/agentToolKit.ts` 형식(prepare/execute)으로 `agentTools.ts`(리드)·`agentCrmTools.ts`(회사·연락처)·`agentMeetingTools.ts`(노트·캘린더)·`agentMailTools.ts`(메일·문서)에 추가.
- 변경 로직은 Route Handler와 공용(`leadOps`·`companyOps`·`contactOps`·`noteOps`·`scheduleOps`·`docOps`) — 이력은 `via: "agent"`.
- 새 도구 규칙: 개인정보(이메일·전화 등)는 인자로 받지도 결과로 보내지도 않는다, 메일 받는 사람은 서버가 정한다, 되돌릴 수 없는 작업은 `danger`, 발송 도구는 `sends`(시간당 제한). 한도는 `lib/agentLimits.ts`.

## 명함 → 회사·연락처 (AIC-10)

- 화면: AI Assistant 패널(`일반 대화`)·Sales Agent 입력창 왼쪽 카메라 버튼(`BusinessCardAttach`, `capture` 속성 없이 사진 찍기/보관함 선택, 여러 장 → 장마다 카드), 대화 영역 드래그 앤 드롭. 대화 안 확인 카드 `BusinessCardConfirm`(읽는 중 → 확인·수정 → 생성 → 연락처·회사 보기·`이 담당자로 리드 만들기`, `뒷면 추가`로 2장 함께 다시 분석). 카드는 **화면 전용**(`useBusinessCards`, `afterIndex`로 메시지 사이에 표시) — OpenAI 대화·Agent 도구로 보내지 않는다. Agent 화면 카드는 CrmApp이 가짐(화면 이동 후에도 유지).
- 클라이언트: `lib/imageFile.ts` `shrinkImage`(긴 변 2000px JPEG, 1장 2MB 이하 — Vercel 요청 4.5MB 한도).
- API: `POST /api/business-cards/extract`(multipart `image` 1~2장, 매직 바이트 `sniffImage`로 JPEG·PNG·WebP만, DB 저장·이미지 보관 없음 → `{ draft, match }`, 이름·회사명을 못 읽으면 422), `POST /api/business-cards`(`{ companyId | company, contact }` → `withTransaction`으로 회사 생성(같은 이름·도메인 회사가 있으면 연결) + 연락처 생성, 같은 이메일이면 409 + `{ error, contact }`이고 회사 생성도 되돌림).
- 서버 `lib/businessCard.ts`: 비전 호출(`ChatContentPart` `image_url` data URL), `parseCardJson`(전화 표시 제거·휴대폰/유선 정리, 회사 도메인 = 회사 메일 → 웹사이트, 무료 메일 제외), `findCardMatch`(`findCompanyMatch`·`findContactByEmail`·`findSamePerson` — Agent 중복 확인과 공용), `saveBusinessCard`(연락처 태그 `명함`·메모 `명함으로 등록 (날짜)`, 별도 이력 테이블 없음).
- 같은 이메일 연락처: 덮어쓰지 않고 `빈 항목만 채우기`(부서·직함·휴대폰·유선·LinkedIn·회사, 기존 `PATCH /api/contacts/[id]`).
- 개인정보: 명함 이미지에는 이메일·전화가 있어 OpenAI 전송 원칙의 예외 — 카드에 "AI(OpenAI)로 분석, 저장 안 함" 안내. 분석 결과·이미지는 로그에 남기지 않는다.

## 참고 문서

- Next.js 16 문서: `web/node_modules/next/dist/docs/`
- Vercel 모범 사례: 루트 `AGENTS.md`
- 배포: Vercel 프로젝트 `aicrm` (팀 `no-margin`), Supabase 프로젝트 `aicrm` (ref `hwxuufpaupnpawlgnyvx`)
