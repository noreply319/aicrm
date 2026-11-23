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
