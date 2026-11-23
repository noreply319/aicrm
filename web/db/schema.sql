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
