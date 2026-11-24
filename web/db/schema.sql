-- Pipeline CRM schema
CREATE TABLE IF NOT EXISTS leads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company     text NOT NULL CHECK (length(trim(company)) > 0),
  contact     text NOT NULL DEFAULT '',
  title       text NOT NULL DEFAULT '',
  email       text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  value       bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  close_date  date,
  stage       text NOT NULL DEFAULT 'new'
              CHECK (stage IN ('new','contacted','qualified','proposal','negotiation','won','lost')),
  priority    text NOT NULL DEFAULT 'mid' CHECK (priority IN ('high','mid','low')),
  notes       text NOT NULL DEFAULT '',
  position    double precision NOT NULL,          -- 칸반 내 정렬 순서 (작을수록 위)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_stage_position_idx ON leads (stage, position);

-- Supabase는 public 스키마 테이블을 공개 REST API(anon key)로 노출한다.
-- 앱은 서버에서 직접 접속하므로 RLS를 켜고 정책을 두지 않아 REST API 접근을 막는다.
-- (테이블 소유자/postgres 역할의 직접 접속은 영향 없음)
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- 리드 변경 이력 (AI Assistant가 "언제 생성/변경됐는지" 답할 때 사용)
-- lead_id는 FK를 걸지 않는다: 리드가 삭제돼도 이력은 남기기 위함 (company에 당시 회사명 보관)
CREATE TABLE IF NOT EXISTS lead_events (
  id          bigserial PRIMARY KEY,
  lead_id     uuid NOT NULL,
  company     text NOT NULL,
  type        text NOT NULL CHECK (type IN ('created','updated','moved','deleted','note_created','note_updated','note_deleted')),
  changes     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- updated/moved: { field: { from, to } }, created/deleted: 스냅샷
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_events_lead_idx ON lead_events (lead_id, created_at);
CREATE INDEX IF NOT EXISTS lead_events_created_idx ON lead_events (created_at DESC);

ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;

-- crm_app 역할 전용 정책 (anon/authenticated는 정책이 없으므로 차단)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'lead_events' AND policyname = 'lead_events_crm_app') THEN
    CREATE POLICY lead_events_crm_app ON lead_events FOR ALL TO crm_app USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 이력 기능 도입 전에 만들어진 리드: created_at 기준으로 'created' 이벤트를 채워 넣는다 (재실행 안전)
INSERT INTO lead_events (lead_id, company, type, changes, created_at)
SELECT l.id, l.company, 'created',
       jsonb_build_object('stage', l.stage, 'value', l.value, 'priority', l.priority, 'backfilled', true),
       l.created_at
FROM leads l
WHERE NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id);

-- 미팅 노트 이력 타입 추가 (이미 만들어진 lead_events 테이블의 CHECK 제약 갱신, 재실행 안전)
ALTER TABLE lead_events DROP CONSTRAINT IF EXISTS lead_events_type_check;
ALTER TABLE lead_events ADD CONSTRAINT lead_events_type_check
  CHECK (type IN ('created','updated','moved','deleted','note_created','note_updated','note_deleted',
                  'meeting_scheduled','meeting_rescheduled','meeting_canceled','document_sent'));

-- 미팅 노트: 리드에 연결(나중에 지정 가능 → NULL 허용), 리드 삭제 시 함께 삭제
-- 녹음 원본은 저장하지 않고 전사 텍스트만 body에 저장한다
CREATE TABLE IF NOT EXISTS meeting_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid REFERENCES leads(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (length(trim(title)) > 0),
  met_at        timestamptz NOT NULL DEFAULT now(),
  body          text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 50000),
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','recording','mixed')),
  summary       text NOT NULL DEFAULT '',   -- AI 요약 (사용자 수정 가능)
  next_actions  text NOT NULL DEFAULT '',   -- AI 다음 액션 (줄 단위)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 이미 만들어진 테이블: 리드 미지정 노트 허용 (녹음 완료 시 자동 저장 후 리드를 나중에 지정, 재실행 안전)
ALTER TABLE meeting_notes ALTER COLUMN lead_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS meeting_notes_lead_idx ON meeting_notes (lead_id, met_at DESC);
CREATE INDEX IF NOT EXISTS meeting_notes_met_at_idx ON meeting_notes (met_at DESC);

ALTER TABLE meeting_notes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'meeting_notes' AND policyname = 'meeting_notes_crm_app') THEN
    CREATE POLICY meeting_notes_crm_app ON meeting_notes FOR ALL TO crm_app USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 앱 접속 역할(crm_app) 권한: RLS 정책만으로는 부족하고 테이블 권한(GRANT)도 필요하다.
-- Supabase에서는 테이블 소유자가 postgres라 새 테이블마다 명시해야 한다 (재실행 안전).
-- lead_events는 이력 기록·조회만 하므로 SELECT, INSERT만 허용
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO crm_app;
    GRANT SELECT, INSERT ON lead_events TO crm_app;
    GRANT USAGE ON SEQUENCE lead_events_id_seq TO crm_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_notes TO crm_app;
  END IF;
END $$;

-- ───────────────────────── 로그인 + 구글 캘린더 ─────────────────────────

-- 사용자: 구글 로그인 계정. 허용 이메일(ALLOWED_EMAILS)만 로그인할 수 있다.
-- 캘린더 리프레시 토큰은 앱에서 AES-256-GCM으로 암호화한 값만 저장한다 (TOKEN_ENCRYPTION_KEY).
CREATE TABLE IF NOT EXISTS users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub            text NOT NULL UNIQUE,          -- 구글 계정 고유 id
  email                 text NOT NULL UNIQUE,
  name                  text NOT NULL DEFAULT '',
  picture               text NOT NULL DEFAULT '',
  google_refresh_token  text,                          -- 암호화된 값. NULL = 구글 기능(캘린더·Gmail) 미연동
  google_scopes         text NOT NULL DEFAULT '',
  calendar_id           text NOT NULL DEFAULT 'primary',
  calendar_expired      boolean NOT NULL DEFAULT false, -- 토큰 만료·폐기로 연동이 끊김 (캘린더·Gmail 공통)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 로그인 세션: 쿠키에는 랜덤 토큰, DB에는 그 SHA-256 해시만 저장한다
CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- 다음 미팅 일정: 미팅 노트에서 찾은 후보(candidate)와 캘린더에 등록한 일정(scheduled)
CREATE TABLE IF NOT EXISTS scheduled_meetings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          uuid REFERENCES leads(id) ON DELETE CASCADE,
  note_id          uuid REFERENCES meeting_notes(id) ON DELETE SET NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,   -- 등록자(캘린더 소유자)
  status           text NOT NULL CHECK (status IN ('candidate','scheduled','canceled','dismissed')),
  certainty        text NOT NULL DEFAULT 'confirmed' CHECK (certainty IN ('confirmed','tentative')),
  title            text NOT NULL CHECK (length(trim(title)) > 0),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  all_day          boolean NOT NULL DEFAULT false,
  location         text NOT NULL DEFAULT '',
  evidence         text NOT NULL DEFAULT '',                       -- 노트 원문 근거
  calendar_id      text,
  google_event_id  text,
  google_html_link text NOT NULL DEFAULT '',
  invite_sent      boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- 사용자가 쓴 일정 메모 (구글 이벤트 설명에는 메모 + CRM 연결 정보가 들어간다)
ALTER TABLE scheduled_meetings ADD COLUMN IF NOT EXISTS memo text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS scheduled_meetings_lead_idx ON scheduled_meetings (lead_id, starts_at);
CREATE INDEX IF NOT EXISTS scheduled_meetings_note_idx ON scheduled_meetings (note_id);
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_meetings_event_idx ON scheduled_meetings (google_event_id)
  WHERE google_event_id IS NOT NULL;

-- 구글 기능별 연동 여부 (리프레시 토큰은 사용자당 하나를 캘린더·Gmail이 같이 쓴다)
--   calendar_expired = 토큰 만료·폐기 (두 기능 공통)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'calendar_enabled') THEN
    ALTER TABLE users ADD COLUMN calendar_enabled boolean NOT NULL DEFAULT false;
    -- 이 컬럼 도입 전에 연동한 사용자는 캘린더 연동 상태를 유지한다
    UPDATE users SET calendar_enabled = true WHERE google_refresh_token IS NOT NULL;
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_enabled boolean NOT NULL DEFAULT false;

-- 작성자/변경자 기록 (로그인 도입 전 행은 NULL = 알 수 없음)
ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS user_id uuid;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_meetings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'users_crm_app') THEN
      CREATE POLICY users_crm_app ON users FOR ALL TO crm_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sessions' AND policyname = 'sessions_crm_app') THEN
      CREATE POLICY sessions_crm_app ON sessions FOR ALL TO crm_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'scheduled_meetings' AND policyname = 'scheduled_meetings_crm_app') THEN
      CREATE POLICY scheduled_meetings_crm_app ON scheduled_meetings FOR ALL TO crm_app USING (true) WITH CHECK (true);
    END IF;
    GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, scheduled_meetings TO crm_app;
  END IF;
END $$;

-- 리드 이메일 캐시: 사용자 Gmail에서 리드와 주고받은 메일의 제목·요약 (본문은 저장하지 않고 열 때 Gmail에서 읽는다)
-- 한 번 불러온 메일은 다시 불러오거나 다시 요약하지 않는다. Gmail 연동 해제 시 해당 사용자 행 삭제.
CREATE TABLE IF NOT EXISTS lead_emails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- 메일함 소유자
  lead_id          uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  gmail_id         text NOT NULL,
  thread_id        text NOT NULL DEFAULT '',
  subject          text NOT NULL DEFAULT '',
  from_header      text NOT NULL DEFAULT '',
  to_header        text NOT NULL DEFAULT '',
  cc_header        text NOT NULL DEFAULT '',
  direction        text NOT NULL CHECK (direction IN ('sent','received')),
  sent_at          timestamptz NOT NULL,
  snippet          text NOT NULL DEFAULT '',
  has_attachments  boolean NOT NULL DEFAULT false,
  summary          text NOT NULL DEFAULT '',
  summary_status   text NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending','done','failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lead_id, gmail_id)
);
CREATE INDEX IF NOT EXISTS lead_emails_lead_idx ON lead_emails (user_id, lead_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS lead_emails_user_idx ON lead_emails (user_id, sent_at DESC);

ALTER TABLE lead_emails ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'lead_emails' AND policyname = 'lead_emails_crm_app') THEN
      CREATE POLICY lead_emails_crm_app ON lead_emails FOR ALL TO crm_app USING (true) WITH CHECK (true);
    END IF;
    GRANT SELECT, INSERT, UPDATE, DELETE ON lead_emails TO crm_app;
  END IF;
END $$;

-- ───────────────────────── 계약서·견적서 ─────────────────────────

-- 문서 템플릿 (팀 공유). body의 {{항목}}이 문서마다 바뀌는 부분, fields는 항목 설정(유형·질문·필수·리드 자동 채움)
CREATE TABLE IF NOT EXISTS document_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('contract','quote')),
  name           text NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 100),
  description    text NOT NULL DEFAULT '',
  body           text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 50000),
  fields         jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_items     jsonb,                                  -- 견적서 품목 표 설정 { spec, vat }. 계약서는 NULL
  email_subject  text NOT NULL DEFAULT '',
  email_body     text NOT NULL DEFAULT '',
  archived       boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_templates_kind_idx ON document_templates (archived, kind, updated_at DESC);

-- 작성한 문서: 생성 시점의 템플릿 본문·항목을 복사(snapshot)해 두므로 템플릿을 고쳐도 영향이 없다
CREATE TABLE IF NOT EXISTS documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        uuid REFERENCES document_templates(id) ON DELETE SET NULL,
  kind               text NOT NULL CHECK (kind IN ('contract','quote')),
  title              text NOT NULL CHECK (length(trim(title)) > 0),
  doc_number         text NOT NULL UNIQUE,              -- C-2026-0001 / Q-2026-0001
  lead_id            uuid REFERENCES leads(id) ON DELETE SET NULL,
  body               text NOT NULL,
  fields             jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_items_config  jsonb,
  email_subject      text NOT NULL DEFAULT '',
  email_body         text NOT NULL DEFAULT '',
  field_values       jsonb NOT NULL DEFAULT '{}'::jsonb, -- { 항목: 값 }
  line_items         jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ name, spec, qty, unitPrice }]
  skipped            jsonb NOT NULL DEFAULT '[]'::jsonb, -- 건너뛴 항목
  messages           jsonb NOT NULL DEFAULT '[]'::jsonb, -- Assistant 대화 기록
  step               jsonb NOT NULL DEFAULT '{"type":"lead"}'::jsonb, -- Assistant가 기다리는 입력
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','completed','sent')),
  rev                integer NOT NULL DEFAULT 0,          -- 저장할 때마다 +1 (동시 수정 감지)
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  sent_at            timestamptz
);
CREATE INDEX IF NOT EXISTS documents_updated_idx ON documents (updated_at DESC);
CREATE INDEX IF NOT EXISTS documents_lead_idx ON documents (lead_id);
CREATE INDEX IF NOT EXISTS documents_template_idx ON documents (template_id);

-- 발송 기록 (재발송 가능). 메일 본문은 저장하지 않는다
CREATE TABLE IF NOT EXISTS document_sends (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  to_addrs          text[] NOT NULL,
  cc_addrs          text[] NOT NULL DEFAULT '{}',
  subject           text NOT NULL,
  file_name         text NOT NULL,
  gmail_message_id  text NOT NULL DEFAULT '',
  sent_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_sends_doc_idx ON document_sends (document_id, sent_at DESC);

ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_sends ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_templates' AND policyname = 'document_templates_crm_app') THEN
      CREATE POLICY document_templates_crm_app ON document_templates FOR ALL TO crm_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'documents' AND policyname = 'documents_crm_app') THEN
      CREATE POLICY documents_crm_app ON documents FOR ALL TO crm_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_sends' AND policyname = 'document_sends_crm_app') THEN
      CREATE POLICY document_sends_crm_app ON document_sends FOR ALL TO crm_app USING (true) WITH CHECK (true);
    END IF;
    GRANT SELECT, INSERT, UPDATE, DELETE ON document_templates, documents, document_sends TO crm_app;
  END IF;
END $$;

-- ───────── 회사 (docs/companies/requirements.md) ─────────
-- 회사명 정규화 키: 소문자, 공백 제거, (주)·㈜·주식회사·(유)·유한회사 제거. 중복 판단에 사용.
-- lib/companyKey.ts의 companyKey()와 같은 규칙이어야 한다 (integration 테스트로 확인).
CREATE OR REPLACE FUNCTION crm_company_key(name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    nullif(regexp_replace(lower(regexp_replace(coalesce(name, ''), '\(주\)|㈜|주식회사|\(유\)|유한회사', '', 'g')), '\s', '', 'g'), ''),
    regexp_replace(lower(coalesce(name, '')), '\s', '', 'g'))
$$;

CREATE TABLE IF NOT EXISTS companies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  name_key         text NOT NULL,
  website          text NOT NULL DEFAULT '',
  email_domain     text,                                   -- 소문자, 무료 메일 불가 (서버 검증)
  industry         text NOT NULL DEFAULT '',
  size             text CHECK (size IN ('1-10','11-50','51-200','201-1000','1000+')),
  phone            text NOT NULL DEFAULT '',
  address          text NOT NULL DEFAULT '',
  business_number  text NOT NULL DEFAULT '',               -- 숫자 10자리 (하이픈 없이)
  ceo_name         text NOT NULL DEFAULT '',
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,   -- 담당 영업
  tier             text CHECK (tier IN ('A','B','C')),
  tags             text[] NOT NULL DEFAULT '{}',
  notes            text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_key_idx ON companies (name_key);
CREATE UNIQUE INDEX IF NOT EXISTS companies_email_domain_idx ON companies (email_domain) WHERE email_domain IS NOT NULL;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'companies' AND policyname = 'companies_crm_app') THEN
      CREATE POLICY companies_crm_app ON companies FOR ALL TO crm_app USING (true) WITH CHECK (true);
    END IF;
    GRANT SELECT, INSERT, UPDATE, DELETE ON companies TO crm_app;
  END IF;
END $$;

-- 리드 → 회사. leads.company는 회사명 사본으로 유지한다 (회사명을 쓰는 곳이 많아 JOIN 대신 사본 + 이름 변경 시 갱신).
-- 리드가 있는 회사는 삭제할 수 없다 (RESTRICT). NOT NULL은 운영 데이터 연결 확인 후 적용 예정.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS leads_company_idx ON leads (company_id);

-- 회사가 연결되지 않은 리드: 정규화한 회사명으로 회사를 만들고(없을 때만) 연결한다. 재실행 안전.
-- 회사 표기는 그 이름으로 가장 먼저 만든 리드의 회사명. 연결한 리드의 회사명 사본도 회사 표기로 맞춘다.
CREATE OR REPLACE FUNCTION crm_link_lead_companies() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  linked integer;
BEGIN
  INSERT INTO companies (name, name_key)
  SELECT DISTINCT ON (crm_company_key(company)) left(trim(company), 100), crm_company_key(company)
  FROM leads
  WHERE company_id IS NULL
  ORDER BY crm_company_key(company), created_at
  ON CONFLICT (name_key) DO NOTHING;

  UPDATE leads l SET company_id = c.id, company = c.name
  FROM companies c
  WHERE l.company_id IS NULL AND c.name_key = crm_company_key(l.company);
  GET DIAGNOSTICS linked = ROW_COUNT;
  RETURN linked;
END $$;

SELECT crm_link_lead_companies();
