# Prompt History

## 1. 2026-11-23 — 칸반 CRM 생성

> CRM을 만들려고 하는데, 칸반 보드 형태로, Sales Lead를 등록하고, 칸반 Funnel에서 Drag & Drop 으로 이동할 수 있게 만들고 싶어. 모던한 디자인으로 html로 구현해줘.

- 결과: `index.html` 생성 (7단계 파이프라인, 리드 등록/수정/삭제, Drag & Drop, 통계, 검색, 다크 모드, localStorage 저장)

## 2. 2026-11-23 — 프롬프트 기록

> prompt는 @prompts/history.md 에 저장해줘.

- 결과: 이 파일에 프롬프트 기록 시작

## 3. 2026-11-23 — Next.js 웹앱 전환

> 해당 html 앱을 next.js 웹앱으로 구현해줘.

- 결과: `web/` 폴더에 Next.js 15 (App Router, TypeScript) 프로젝트 생성. 기존 기능/디자인을 React 컴포넌트(Header, StatsBar, Board, Column, LeadCard, LeadModal, Toast)와 `useLeads` 훅으로 이전

## 4. 2026-11-23 — Node.js 설치 후 실행

> node.js 설치했어.

- 결과: 패키지 설치, 보안 취약점이 있던 Next 15.3.3 → Next 16.4.6 / React 19.3.1로 업그레이드 (취약점 0), 빌드 성공, `npm run dev`로 http://localhost:3000 실행

## 5. 2026-11-23 — 서버 종료 방법

> 서버 stop은 어떻게 해?

- 결과: 개발 서버 종료 방법 안내 (Ctrl+C, 포트로 프로세스 종료, Claude 백그라운드 작업 종료)

## 6. 2026-11-23 — 데이터 저장 위치

> 현재 데이터는 어디에 저장돼?

- 결과: 브라우저 localStorage(`crm.leads.v1`)에 저장됨을 안내, 확인 방법과 한계, DB 전환 옵션 설명

## 7. 2026-11-23 — PostgreSQL 연결

> 현재 브라우저 스토리지에 저장한 부분 database로 대체 하려고해. postgresql 로컬에 설치했고, postgresql에 db 생성해서 연결해줘.

- 결과: 로컬 PostgreSQL에 `ai_crm` DB와 `crm_app` 사용자 생성, `leads` 테이블 + 샘플 데이터. Next.js API 라우트(`/api/leads`, `/api/leads/[id]`, `/api/leads/[id]/move`)와 `pg` 드라이버로 연결, `useLeads`를 localStorage → API 호출로 교체. CRUD/이동 API 테스트 통과

## 8. 2026-11-23 — index.html 사용 여부

> @index.html 은 이제 더이상 안쓰여?

- 결과: Next.js 앱은 index.html을 참조하지 않음(독립 실행 프로토타입, localStorage 저장)을 안내, 보관/삭제 옵션 제시

## 9. 2026-11-23 — git init 위치

> 현재 git init의 경우 어느 폴더에서 해야해?

- 결과: 프로젝트 루트(`AI CRM/`)에서 init 권장 안내 (web/, prompts/ 함께 관리, web/.gitignore가 node_modules·.env.local 제외)

## 10. 2026-11-23 — 실행 명령어

> 실행 명령어가 어떻게 돼?

- 결과: 앱 실행(dev/build/start, db:init) 및 git 초기화 명령어 정리

## 11. 2026-11-23 — zsh `event not found` 에러

> 아래 처럼 에러가 나는데 뭐가 문제고 어떻게 수정해?
> jaerimee@jaerimees-MacBook-Pro AI CRM % printf "node_modules/\n.DS_Store\n.env*\n!.env.example\n" > .gitignore
> zsh: event not found: .env.example\n

- 결과: 큰따옴표 안의 `!`를 zsh가 히스토리 확장으로 해석한 문제. 작은따옴표 사용으로 해결 방법 안내, 루트 `.gitignore` 직접 생성

## 12. 2026-11-23 — GitHub push

> github https://github.com/noreply319/aicrm.git 에 push하려면 어떤 명령어를 처야해?

- 결과: remote 추가 → main 브랜치 → push 명령어 안내

## 13. 2026-11-23 — 로컬 커밋을 없애는 이유

> 로컬 커밋을 왜 없애야해. 쉽게 설명해줘.

- 결과: git은 모든 커밋을 통째로 올리므로, 첫 커밋 안의 111MB 파일 때문에 push가 거부된다는 점을 비유로 설명
