-- 표준 분배 규칙 템플릿(테넌트 정책 결정 TD13, 진행 TN14).
-- 1인 테넌트(독립 아티스트)는 정책 편집 ≠ 승인 ≠ 활성화를 혼자 지킬 수 없다. 법무가 승인한 템플릿을 값 그대로 쓰면
-- 템플릿 승인이 두 번째 눈이 되어, 같은 사람이 편집·승인·활성화할 수 있다. 템플릿을 고치면(직접 쓴 정책) 직무 분리가 그대로 적용된다.
CREATE TABLE policy_template (
  template_id  mdrl_id NOT NULL,
  version      INT NOT NULL CHECK (version >= 1),
  title        TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description  TEXT NOT NULL,
  -- 분배 규칙 폼(engine-bridge/policy-form.ts PolicyForm)에서 packId를 뺀 값. 계약 몫(특정 당사자)은 둘 수 없다.
  form         JSONB NOT NULL CHECK (jsonb_typeof(form) = 'object' AND NOT form ? 'packId'),
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  -- 시드(v1)는 법무 초안으로 들어와 작성·승인자가 없다. 이후 버전은 작성자(LEGAL) ≠ 승인자(LEGAL).
  seeded       BOOLEAN NOT NULL DEFAULT false,
  authored_by  mdrl_id NULL REFERENCES user_account,
  approved_by  mdrl_id NULL REFERENCES user_account,
  created_at   TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  approved_at  TIMESTAMPTZ NULL CHECK (approved_at = date_trunc('milliseconds', approved_at)),
  PRIMARY KEY (template_id, version),
  CHECK (status <> 'APPROVED' OR seeded OR (approved_by IS NOT NULL AND approved_by <> authored_by))
);
ALTER TABLE policy_template ENABLE ROW LEVEL SECURITY;
CREATE POLICY template_read ON policy_template FOR SELECT USING (true);
CREATE POLICY template_insert ON policy_template FOR INSERT WITH CHECK (rc_sees_all());
CREATE POLICY template_update ON policy_template FOR UPDATE USING (rc_sees_all()) WITH CHECK (rc_sees_all());
GRANT SELECT, INSERT ON policy_template TO rc_app;
GRANT UPDATE (status, approved_by, approved_at) ON policy_template TO rc_app;

INSERT INTO policy_template (template_id, version, title, description, form, status, seeded, created_at, approved_at) VALUES
('ptpl_indie_standard', 1, '독립 아티스트 표준(녹음·실연·작품)',
 '팬앱 구매·감상 매출의 70%를 권리자 몫으로 하고, 그 안에서 녹음 40% · 실연 45%(참여 멤버 고정 40% + 부른 시간 60%, 위임대로) · 작품 15%(위임대로 — 신탁단체가 있으면 신탁단체가 받는다)로 나눈다.',
 '{"events":["PRIMARY","TRAFFIC"],"tier1":{"platformBps":2500,"opsBps":500,"rightsBps":7000},"master":{"bps":4000},"performer":{"bps":4500,"mode":"HYBRID","fixedBps":4000,"usageBps":6000,"featuredWeightBps":7000,"viaMandate":true},"work":{"bps":1500,"viaMandate":true},"contracts":[]}',
 'APPROVED', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
('ptpl_indie_simple', 1, '독립 아티스트 단순(녹음 + 작품)',
 '실연 몫 없이 권리자 몫 70%를 녹음 70% · 작품 30%(위임대로)로 나눈다. 혼자 녹음하고 곡도 쓴 경우.',
 '{"events":["PRIMARY","TRAFFIC"],"tier1":{"platformBps":2500,"opsBps":500,"rightsBps":7000},"master":{"bps":7000},"performer":{"bps":0,"mode":"HYBRID","viaMandate":false},"work":{"bps":3000,"viaMandate":true},"contracts":[]}',
 'APPROVED', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- 정책 버전이 어느 템플릿에서 왔는지(값을 바꾸지 않은 경우만 채운다).
ALTER TABLE policy_version ADD COLUMN template_id mdrl_id NULL, ADD COLUMN template_version INT NULL;
ALTER TABLE policy_version ADD CONSTRAINT policy_version_template_fk FOREIGN KEY (template_id, template_version) REFERENCES policy_template;
