# 구글 로그인 + 구글 캘린더 연동 요구사항

- 작성일: 2026-11-24
- 상태: **구현 완료(1차)** — 2026-11-24. 구현하면서 바뀐 내용은 11장 참고
- 브랜치 / 워크트리: `feature/google-calendar` / `../aicrm-google-calendar`
- 관련 화면: 로그인 화면(신규), 헤더(사용자 메뉴), 미팅 노트 작성·상세(MeetingNoteModal), 리드 상세(LeadModal), 리드 카드, AI Assistant 패널

## 1. 배경 / 목적

영업 담당자는 미팅 중 "다음 주 화요일 2시에 데모 드릴게요"처럼 다음 일정을 정하지만,
이를 캘린더에 따로 옮겨 적어야 해서 누락이 생긴다. CRM을 구글 캘린더와 연결해:

1. 미팅 노트에서 **다음 미팅 일정을 찾아 저장 시 등록을 제안**하고, 확정하면 캘린더에 등록·갱신한다.
2. AI Assistant에서 **"이번 주 일정 뭐 있어?"** 같은 질문에 실제 캘린더를 조회해 답한다.

현재 앱에는 인증이 없어 "누구의" 캘린더인지 구분할 수 없고, 배포 URL을 아는 누구나 캘린더를 읽고 쓸 수 있게 된다.
그래서 **구글 로그인(인증)을 먼저 도입**하고, 로그인 시 받은 권한으로 사용자별 캘린더를 연동한다.

## 2. 결정 사항 (2026-11-24 질의응답)

| 항목 | 결정 |
|---|---|
| 연동 방식 | 인증 먼저 도입 → **사용자별 캘린더 연동** |
| 로그인 방식 | **구글 로그인** (로그인과 캘린더 권한을 한 번에) |
| 구글 계정 | **개인 Gmail** → 구글 앱은 "외부 + 테스트" 상태. 리프레시 토큰이 7일마다 만료됨 (5.1 FR-6 참고) |
| 로그인 허용 | **허용 이메일 목록** (`ALLOWED_EMAILS` 환경 변수 + 구글 앱 테스트 사용자에 동일하게 등록) |
| 데이터 공유 | **팀 전체 공유** — 리드·미팅 노트는 모두 공유, 캘린더만 사용자별. 노트·일정에 작성자 기록 |
| 세션 구현 | **직접 구현, 새 패키지 없음** — `fetch`로 구글 OAuth 호출, 세션은 DB 테이블 + httpOnly 쿠키 |
| 일정 등록 | **저장 시 확인 카드 → 사용자가 확정하면 캘린더 등록**. 자동 등록 없음. 시간 미정 일정은 CRM에 "확인 필요"로 보관 |
| 챗봇 조회 범위 | **전체 일정, 최소 정보만** — 제목·시간·장소만 OpenAI로 전송 (참석자·설명·회의 링크 제외) |

## 3. 범위

| 포함 (이번 작업) | 제외 (추후 검토) |
|---|---|
| 구글 로그인 / 로그아웃, 허용 이메일 제한, 전체 페이지·API 보호 | 이메일+비밀번호 로그인, 역할(관리자/일반) 권한 |
| 로그인 시 캘린더 권한 동의 → 사용자별 캘린더 연동 | Outlook·iCloud 등 다른 캘린더 |
| 미팅 노트에서 다음 미팅 일정 추출 (AI) | 구글 캘린더 → CRM 실시간 동기화 (웹훅·푸시 알림) |
| 노트 저장 시 확인 카드 → 확정 시 캘린더 이벤트 생성 | 반복 일정 |
| 등록한 일정의 변경(재확정)·취소 → 캘린더 반영 | Google Meet 링크 자동 생성 |
| 리드 상세 "예정된 미팅", 리드 카드 다음 미팅 배지 | 사용자별 데이터 분리 |
| AI Assistant의 캘린더 조회 (조회 전용) | Assistant가 일정을 생성·수정 |
| 노트·일정에 작성자 표시 | 구글 앱 검증·게시 (7일 만료 해소) |

## 4. 용어

- **사용자(User)**: 허용 이메일 목록에 있는 구글 계정으로 로그인한 영업 담당자.
- **세션(Session)**: 로그인 상태. DB `sessions` 테이블의 랜덤 토큰을 httpOnly 쿠키로 보관.
- **캘린더 연동(Connection)**: 로그인 시 받은 구글 리프레시 토큰을 서버에 암호화 저장해, 서버가 해당 사용자의 캘린더를 읽고 쓸 수 있는 상태.
- **일정 후보(Candidate)**: AI가 미팅 노트에서 찾은 "다음 미팅" 정보. 아직 캘린더에 없음.
- **예정 미팅(Scheduled)**: 사용자가 후보를 확정해 구글 캘린더 이벤트로 만든 일정. CRM DB에 리드·노트·이벤트 id·작성자와 함께 보관.
- **확인 필요(Tentative)**: 날짜·시간이 정해지지 않았거나("다음 주 중") 상대 확인이 필요한 후보.

## 5. 기능 요구사항

### 5.1 구글 로그인 (인증)

- FR-1. 로그인하지 않은 사용자는 모든 페이지에서 `/login`으로 이동한다. `/login`에는 `Google로 로그인` 버튼만 있다.
- FR-2. 모든 `/api/*`는 로그인 세션이 없으면 `401 { error: "로그인이 필요합니다" }`를 반환한다 (예외: `/api/auth/*`).
  - 1차 차단은 `proxy.ts`(Next.js 16의 middleware)에서 쿠키 존재 여부로, 실제 세션 검증은 각 Route Handler에서 `requireUser()`로 한다 (Next.js 인증 가이드 권장 방식).
- FR-3. 로그인은 구글 OAuth 2.0 Authorization Code + PKCE로 한다. 요청 권한(scope): `openid email profile` + `https://www.googleapis.com/auth/calendar.events` + `https://www.googleapis.com/auth/calendar.calendarlist.readonly`. `access_type=offline`, `prompt=consent`로 리프레시 토큰을 받는다.
- FR-4. 구글이 확인한 이메일(`email_verified=true`)이 `ALLOWED_EMAILS`(쉼표 구분)에 없으면 로그인을 거부하고 "접근 권한이 없는 계정입니다"를 보여준다.
- FR-5. 처음 로그인하면 `users`에 사용자를 만들고, 이후에는 이름·프로필 사진·토큰을 갱신한다.
- FR-6. 세션 유효기간은 **7일**(테스트 상태 구글 앱의 리프레시 토큰 수명과 동일)로 한다. 만료되면 다시 로그인하면서 캘린더 권한도 자동으로 새로 받는다. 세션 중 캘린더 토큰이 먼저 끊기면 "캘린더 연동이 만료되었습니다. 다시 로그인하세요" 배너를 보여주고 캘린더 기능만 비활성화한다.
- FR-7. 사용자가 동의 화면에서 캘린더 권한을 해제하고 로그인하면 로그인은 허용하되 캘린더 기능은 "연동 안 됨" 상태로 둔다.
- FR-8. 헤더 오른쪽에 사용자 메뉴(프로필 사진·이름): 연결된 캘린더, 일정 등록 캘린더 선택(기본 `primary`), `로그아웃`.
- FR-9. 로그아웃 시 세션을 삭제하고 쿠키를 지운다. 구글 토큰은 유지한다 (다음 로그인 때 갱신).
- FR-10. 기존 데이터(로그인 도입 전 리드·노트)는 그대로 팀 공유 데이터로 유지하며, 작성자는 "알 수 없음"으로 표시한다.

### 5.2 작성자 기록

- FR-11. 미팅 노트·예정 미팅·`lead_events`에 작성자(`user_id`)를 기록한다. 리드는 공유 데이터이므로 이력에만 변경자를 남긴다.
- FR-12. 노트 리스트·상세에 작성자 이름을 표시한다. AI Assistant 이력 컨텍스트에도 변경자 이름을 포함한다 ("김영업님이 A사를 협상으로 이동").

### 5.3 미팅 노트에서 다음 미팅 추출

- FR-13. 노트를 **저장할 때** 본문(+ 요약·다음 액션)을 AI로 분석해 다음 미팅 후보를 찾는다. 노트 저장은 추출을 기다리지 않는다 (저장 완료 후 모달에 "일정 확인 중…" → 결과 표시).
- FR-14. `AI 요약`을 실행할 때도 같은 추출을 함께 수행한다 (요약 프롬프트 JSON에 `nextMeetings` 추가 → 저장 시 재호출 생략).
- FR-15. 추출 항목: 시작 일시(필수), 종료 일시(없으면 1시간), 종일 여부, 제목(기본 `{회사명} {목적} 미팅`), 장소/방식(언급 시), 참석자 이름(언급 시), 근거 문장(원문 발췌), 확실도(`confirmed` / `tentative`).
- FR-16. "다음 주 화요일", "모레 오후 3시" 같은 상대 표현은 **노트의 미팅 일시(`met_at`) 기준, Asia/Seoul**로 계산한다. 과거 일시로 계산되면 후보에서 제외한다.
- FR-17. 노트에 없는 일정을 만들어내지 않는다. 후보는 최대 3개.
- FR-18. 같은 노트에서 이미 등록·무시한 일정과 같은 일시·제목이면 다시 제안하지 않는다 (노트 수정 후 재저장 시 중복 방지).

### 5.4 일정 등록 확인 / 확정

- FR-19. 후보가 있으면 노트 모달에 **확인 카드**: 일시, 제목, 장소, 근거 문장 + `캘린더에 등록` / `수정 후 등록` / `나중에` / `무시`.
- FR-20. `수정 후 등록`에서 시작·종료 일시, 제목, 장소, 메모를 편집. `tentative` 후보는 시간을 입력하기 전까지 등록 버튼 비활성화.
- FR-21. 등록하면 **현재 로그인 사용자의 선택 캘린더**에 이벤트를 만든다. 이벤트 설명: 리드 회사명·단계, 노트 제목, 다음 액션, CRM 리드 링크. 이메일·전화번호는 넣지 않는다.
- FR-22. 고객 초대: 확인 카드에 `담당자에게 초대 메일 보내기` 체크박스(기본 해제). 체크하면 리드 이메일을 참석자로 추가하고 `sendUpdates=all`로 보낸다. 리드 이메일이 없으면 체크박스를 숨긴다.
- FR-23. 생성된 이벤트는 `scheduled_meetings`에 리드·노트·작성자·구글 이벤트 id와 함께 저장하고, 같은 트랜잭션에서 `lead_events`에 `meeting_scheduled` 이력을 남긴다.
- FR-24. 순서: 구글 이벤트 생성 → 성공 시 DB 저장. DB 저장이 실패하면 방금 만든 이벤트를 삭제(보상)하고 에러를 보여준다.
- FR-25. `나중에` 보관한 후보는 리드 상세에 "일정 확인 필요"로 표시하고 거기서 등록한다. `무시`한 후보는 `dismissed`로 남겨 재제안을 막는다.

### 5.5 일정 변경 / 취소

- FR-26. 예정 미팅은 리드 상세·노트 상세의 "예정된 미팅"에서 **변경(재확정)** / **취소**할 수 있고, 구글 이벤트를 갱신·삭제한다 (`meeting_rescheduled`, `meeting_canceled` 이력).
- FR-27. 변경·취소는 **일정을 등록한 사용자만** 할 수 있다 (본인 캘린더 이벤트이므로). 다른 사용자에게는 "○○님 캘린더 일정" 표시와 읽기만 제공.
- FR-28. 리드 상세를 열 때 등록자 본인이면 구글 이벤트 상태를 조회해, 구글에서 직접 삭제·변경한 일정을 CRM에 반영한다 (조회 시 동기화).

### 5.6 리드 화면 표시

- FR-29. 리드 상세(LeadModal)에 "예정된 미팅" 섹션: 예정 미팅(날짜 오름차순, 등록자 표시), 확인 필요 후보, `구글 캘린더에서 열기` 링크(등록자 본인만).
- FR-30. 리드 카드에 가장 가까운 예정 미팅 날짜 배지 (예: `📅 11/28`, 없으면 표시 안 함).

### 5.7 AI Assistant 캘린더 조회

- FR-31. 일정 질문("오늘 일정", "이번 주 A사 미팅 언제야?", "다음 주 화요일 오후 비어 있어?")에 **로그인 사용자 본인의 구글 캘린더**를 조회해 답한다.
- FR-32. OpenAI **function calling**으로 `list_calendar_events(start, end, query?)` 도구를 제공해, 모델이 필요한 기간만 조회한다. 기간 최대 90일, 결과 최대 100건. 도구 호출 반복은 최대 3회.
- FR-33. OpenAI로 보내는 이벤트 정보는 **제목·시작/종료·종일 여부·장소·CRM 연결(회사명·단계)** 만. 참석자, 설명, 회의 링크, 이메일·전화번호는 보내지 않는다 (제목·장소에 포함된 이메일·전화번호도 마스킹).
- FR-34. 다른 팀원의 CRM 예정 미팅은 `scheduled_meetings`(DB)에서 답한다 ("A사 미팅 누가 언제 잡았어?").
- FR-35. Assistant는 계속 **조회 전용**. "일정 잡아줘"에는 미팅 노트·리드 상세에서 등록하는 방법을 안내한다.
- FR-36. 캘린더 연동이 없거나 만료되면 그 사실을 알리고 CRM 예정 미팅만으로 답한다.

## 6. 데이터 / API 설계 (안)

### 6.1 테이블

```sql
CREATE TABLE IF NOT EXISTS users (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub             text NOT NULL UNIQUE,       -- 구글 계정 고유 id
  email                  text NOT NULL UNIQUE,
  name                   text NOT NULL DEFAULT '',
  picture                text NOT NULL DEFAULT '',
  google_refresh_token   text,                       -- AES-256-GCM 암호화, 캘린더 권한 없으면 NULL
  google_scopes          text NOT NULL DEFAULT '',
  calendar_id            text NOT NULL DEFAULT 'primary',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           text PRIMARY KEY,                      -- 쿠키 토큰의 SHA-256 해시 (원문은 저장 안 함)
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_meetings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  note_id          uuid REFERENCES meeting_notes(id) ON DELETE SET NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,   -- 등록자(캘린더 소유자)
  status           text NOT NULL CHECK (status IN ('candidate','scheduled','canceled','dismissed')),
  certainty        text NOT NULL DEFAULT 'confirmed' CHECK (certainty IN ('confirmed','tentative')),
  title            text NOT NULL CHECK (length(trim(title)) > 0),
  starts_at        timestamptz,
  ends_at          timestamptz,
  all_day          boolean NOT NULL DEFAULT false,
  location         text NOT NULL DEFAULT '',
  evidence         text NOT NULL DEFAULT '',
  invite_sent      boolean NOT NULL DEFAULT false,
  google_event_id  text,
  google_html_link text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 작성자 컬럼 추가 (기존 행은 NULL = 알 수 없음)
ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lead_events   ADD COLUMN IF NOT EXISTS user_id uuid;
```

- 새 테이블 모두 RLS + `crm_app` 전용 정책 + GRANT (기존 schema.sql 패턴).
- `lead_events.type` CHECK에 `meeting_scheduled`, `meeting_rescheduled`, `meeting_canceled` 추가.
- 구글 액세스 토큰은 DB에 저장하지 않고, 요청 시 리프레시 토큰으로 발급해 서버 메모리에 만료 전까지 캐시.
- 만료 세션은 로그인 시점에 정리 (별도 크론 없음).

### 6.2 API (Route Handler)

| 메서드 · 경로 | 설명 |
|---|---|
| `GET /api/auth/google` | 로그인 시작: state·PKCE verifier 쿠키 발급 후 구글로 리다이렉트 |
| `GET /api/auth/callback` | state 검증 → 코드 교환 → id_token 검증·허용 이메일 확인 → 사용자 저장 → 세션 쿠키 발급 → `/` |
| `POST /api/auth/logout` | 세션 삭제, 쿠키 제거 |
| `GET /api/me` · `PATCH /api/me` | 로그인 사용자·캘린더 연동 상태 / 일정 등록 캘린더 변경 |
| `GET /api/calendar/calendars` | 쓰기 가능한 캘린더 목록 |
| `POST /api/meetings/[id]/extract-schedule` | 노트에서 후보 추출 → `candidate` 저장 후 반환 |
| `GET /api/schedules?leadId=` | 리드별 예정 미팅·후보 (리드 카드 배지용 전체 조회 포함) |
| `POST /api/schedules/[id]/confirm` | 후보(수정값·초대 여부 포함) 확정 → 구글 이벤트 생성 |
| `PATCH /api/schedules/[id]` · `DELETE /api/schedules/[id]` | 변경(구글 갱신) / 취소(구글 삭제) 또는 후보 무시 |

- 구글 API는 OpenAI처럼 **SDK 없이 `fetch`** (`lib/google.ts`: OAuth·토큰, `lib/calendar.ts`: 이벤트 CRUD, `lib/auth.ts`: 세션·`requireUser()`; 모두 server-only). 새 패키지 없음.
- id_token은 구글 토큰 엔드포인트에서 TLS로 직접 받은 값이므로 서명 검증 대신 `aud`(client id)·`iss`·`exp`·`email_verified`를 확인한다 (OpenID Connect 규격상 허용).
- 세션 쿠키: `httpOnly`, `secure`(배포), `sameSite=lax`, `path=/`, 7일.
- 기존 변경 API(리드·노트)는 `requireUser()`로 사용자를 받아 `recordEvent`에 `user_id`를 넘긴다.

### 6.3 환경 변수 (`web/.env.example`에 키만 추가)

| 변수 | 설명 |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth 클라이언트 (웹 애플리케이션) |
| `APP_URL` (선택) | 콜백 URL·Origin 검사 기준 주소. 없으면 Vercel은 `VERCEL_PROJECT_PRODUCTION_URL`(자동 제공), 로컬은 요청 주소(`http://localhost:3000`)를 사용. 커스텀 도메인 등 다른 주소를 쓸 때만 설정 |
| `ALLOWED_EMAILS` | 로그인 허용 이메일 (쉼표 구분) |
| `TOKEN_ENCRYPTION_KEY` | 리프레시 토큰 암호화 키 (32바이트 base64, `openssl rand -base64 32`) |

## 7. 비기능 요구사항

- NFR-1. 기존 패턴 유지: Route Handler + 클라이언트 훅(`useSchedules`, `useMe`), 낙관적 업데이트 → 실패 시 `reload()` + 에러 배너, `lib/validate.ts` 검증, SQL 파라미터 바인딩.
- NFR-2. 클라이언트 `api.ts`는 401을 받으면 `/login`으로 이동한다.
- NFR-3. 시간대는 `Asia/Seoul` 고정. 구글 이벤트 생성 시 `timeZone: "Asia/Seoul"` 지정.
- NFR-4. 토큰·세션 값은 로그·응답·에러 메시지에 노출하지 않는다. OAuth `state` + PKCE로 CSRF·코드 탈취 방지. 세션 토큰은 해시로만 저장.
- NFR-5. 변경 API(POST/PATCH/DELETE)는 `Origin` 헤더가 앱 주소(`APP_URL` 또는 자동 판단 주소)와 다르면 403 (쿠키 인증 CSRF 방지).
- NFR-6. 구글 API 호출 타임아웃 10초, 429/5xx 1회 재시도.
- NFR-7. 스타일은 `globals.css` CSS 변수만, 라이트/다크 테마 지원.
- NFR-8. Supabase 운영 DB 스키마 적용은 사용자 확인 후 실행. CLAUDE.md의 "인증 없음" 항목과 디렉터리 구조를 갱신.

## 8. 구현 순서 (안)

1. **인증**: 스키마(users·sessions) → `lib/auth.ts`·`lib/google.ts` → `/api/auth/*` → `proxy.ts` + 기존 API에 `requireUser()` → 로그인 화면·사용자 메뉴 → 작성자 기록
2. **캘린더 기반**: `lib/calendar.ts`, `/api/me`, 캘린더 선택
3. **일정 추출·등록**: 스키마(scheduled_meetings) → 추출 API·요약 프롬프트 확장 → 확인 카드 → 확정·변경·취소 → 리드 상세·카드 배지
4. **Assistant**: function calling 루프, 캘린더 도구, CRM 예정 미팅 컨텍스트
5. `npm run build`, 로컬에서 로그인·등록·챗봇 흐름 확인 → 문서 갱신

## 9. 사전 준비 (사용자 작업)

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성 → **Google Calendar API** 사용 설정
2. OAuth 동의 화면: 사용자 유형 **외부**, 게시 상태 **테스트**, 범위에 `calendar.events`·`calendar.calendarlist.readonly` 추가, **테스트 사용자**에 로그인할 Gmail 등록(최대 100명)
3. 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션) 생성, 승인된 리디렉션 URI:
   - `http://localhost:3000/api/auth/callback`
   - `https://aicrm-orcin.vercel.app/api/auth/callback`
4. `web/.env.local`과 Vercel 환경 변수(Sensitive)에 6.3 값 설정 (`APP_URL`은 생략 가능)

> 참고: 테스트 상태에서는 동의 화면에 "Google에서 확인하지 않은 앱" 경고가 표시되며, 리프레시 토큰이 7일 후 만료된다. 해소하려면 구글 앱 검증(민감한 범위) 후 게시가 필요하다 (이번 범위 제외).

## 10. 기본값으로 정한 항목 (확인 필요)

질문하지 않고 권장안으로 정한 항목입니다. 다르게 원하시면 알려주세요.

| # | 항목 | 기본값 |
|---|---|---|
| D1 | 고객 초대 메일 | 확인 카드 체크박스, **기본 해제** (FR-22) |
| D2 | Google Meet 링크 | 이번엔 **제외** |
| D3 | 리드 카드 배지·리드 상세 "예정된 미팅" | **포함** (FR-29, FR-30) |
| D4 | 다른 사용자가 등록한 일정 | 읽기만, 변경·취소는 **등록자만** (FR-27) |
| D5 | 세션 유효기간 | **7일** (구글 테스트 앱 토큰 수명과 맞춤) |
| D6 | 일정 기본 길이 | **1시간** |
| D7 | 배포 시점 | 인증이 들어가면 배포 즉시 로그인 필수가 되므로, Vercel 환경 변수·구글 설정을 먼저 마친 뒤 merge |

## 11. 구현 반영 사항 (2026-11-24 추가 요청 포함)

추가 요청: "상단에 캘린더 메뉴 추가 + 연동한 캘린더 일정 표시 + 일정 추가, 설정 메뉴에서 Google 연동"

| 항목 | 구현 |
|---|---|
| 헤더 메뉴 | `파이프라인 / 미팅 노트 / 캘린더 / 설정` + 오른쪽 프로필 메뉴(캘린더 상태·설정·로그아웃) |
| 로그인과 캘린더 연동 분리 | 로그인은 `openid email profile`만 요청. **설정 → Google 연동**에서 캘린더 권한을 추가로 받음(include_granted_scopes). FR-3·FR-7 대체 |
| 캘린더 화면 | 선택한 캘린더의 월간 보기(6주), 날짜 선택 시 하루 일정 목록, 상단 `＋ 일정 추가`, 헤더 검색으로 일정 필터, 상단에 "확인이 필요한 다음 미팅" 후보 목록 |
| 일정 수정·삭제 | CRM에서 등록한 **내** 일정만 (다른 구글 일정은 보기 + 구글 캘린더에서 열기) |
| **자동 등록 (2026-11-24 변경, Q3 결정 변경)** | 노트를 저장하면 날짜·시간이 확정된 다음 미팅은 **확인 없이 저장한 사용자의 캘린더에 바로 등록**하고 토스트로 알림. 시간 미정(tentative)이거나 캘린더 미연동·만료·오류면 "확인이 필요한 다음 미팅" 창으로 묻는다. 같은 리드·같은 시작 시각 일정이 이미 있으면 중복 등록하지 않음. 잘못 등록된 일정은 캘린더·리드 상세에서 취소 |
| **제목 표시** | CRM에서 만든 모든 구글 일정 제목 앞에 **`[AI CRM]`** (DB에는 표시 없이 저장, 수정 폼에서도 뺌, 구글 동기화 시 떼고 비교) |
| 확인 창 버튼 | 확인이 필요한 후보는 **`확인 후 등록`** → 일정 폼에서 시간 입력 후 등록 |
| 추출 시점 | 노트를 직접 저장할 때만 (녹음 자동 저장 제외). FR-14(AI 요약과 함께 추출)는 미구현 — 저장 시 별도 호출 |
| 노트 삭제 | 그 노트에서 찾은 미확정·무시 후보도 함께 삭제 (등록된 일정은 유지) |
| 작성자 | `meeting_notes.user_id`, `lead_events.user_id` 저장, Assistant 이력에 변경자 이름 포함. 노트 화면의 작성자 표시(FR-12 일부)는 미구현 |
| 일정 메모 | `scheduled_meetings.memo`에 저장, 구글 설명 = 메모 + "— Pipeline CRM에서 등록" + 리드·노트 정보 |
