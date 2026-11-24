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
  type        text NOT NULL CHECK (type IN ('created','updated','moved','deleted')),
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
