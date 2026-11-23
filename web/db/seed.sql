-- 샘플 데이터 (테이블이 비어 있을 때만 삽입)
INSERT INTO leads (company, contact, title, value, stage, priority, close_date, position)
SELECT * FROM (VALUES
  ('한빛소프트웨어', '김민지', 'CTO',          45000000::bigint,  'new',         'high', current_date + 30, 1::float8),
  ('그린에너지㈜',   '이준호', '구매팀장',      12000000,  'new',         'low',  current_date + 45, 2),
  ('스마트로지스',   '박서연', '운영이사',      28000000,  'contacted',   'mid',  current_date + 21, 3),
  ('메디케어랩',     '최도윤', 'IT 매니저',     67000000,  'qualified',   'high', current_date + 18, 4),
  ('퓨처리테일',     '정하은', '마케팅 본부장', 35000000,  'proposal',    'mid',  current_date + 12, 5),
  ('오션핀테크',     '강지훈', '대표',          120000000, 'negotiation', 'high', current_date + 7,  6),
  ('블루밍에듀',     '윤채원', '교육팀장',      18000000,  'won',         'mid',  current_date - 3,  7),
  ('트라이앵글푸드', '임성민', '총무팀',        9000000,   'lost',        'low',  current_date - 10, 8)
) AS v
WHERE NOT EXISTS (SELECT 1 FROM leads);
