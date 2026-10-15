-- 플랫폼 조회의 단계별 통제(다음 작업 7, v2.8 inspection_audit_log). 플랫폼은 권리 오너가 아니다.
-- 1단계 열람: 운영 채널에서 다른 테넌트의 레코드 상세를 보면 열람 기록을 남긴다.
-- 2단계 마스킹 해제: 지급 계좌 토큰은 기본 마스킹, 해제는 사유와 함께 같은 트랜잭션에서 기록한다.
-- 3단계 break-glass: 플랫폼이 테넌트 소유 데이터를 바꾸려면 대상 테넌트·사유·만료(최대 1시간)가 있는 긴급 권한이 있어야 한다.

CREATE TABLE inspection_audit_log (
  inspection_id    BIGSERIAL PRIMARY KEY,
  occurred_at      TIMESTAMPTZ NOT NULL CHECK (occurred_at = date_trunc('milliseconds', occurred_at)),
  actor_user_id    mdrl_id NOT NULL REFERENCES user_account,
  target_tenant_id mdrl_id NOT NULL REFERENCES tenant,
  node_type        TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  panel            TEXT NOT NULL CHECK (panel IN ('PARTY','RIGHTS_IMAGE','PACK','SETTLEMENT_TRACE')),
  pii_unmasked     BOOLEAN NOT NULL DEFAULT false,
  reason           TEXT NULL,
  break_glass_id   BIGINT NULL,
  ip_address       TEXT NOT NULL,
  CHECK (NOT pii_unmasked OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);
CREATE INDEX inspection_tenant_time ON inspection_audit_log (target_tenant_id, occurred_at DESC);
CREATE TRIGGER inspection_audit_log_immutable BEFORE UPDATE OR DELETE ON inspection_audit_log FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

CREATE TABLE break_glass (
  break_glass_id   BIGSERIAL PRIMARY KEY,
  user_id          mdrl_id NOT NULL REFERENCES user_account,
  target_tenant_id mdrl_id NOT NULL REFERENCES tenant,
  reason           TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  started_at       TIMESTAMPTZ NOT NULL CHECK (started_at = date_trunc('milliseconds', started_at)),
  expires_at       TIMESTAMPTZ NOT NULL CHECK (expires_at = date_trunc('milliseconds', expires_at)),
  ended_at         TIMESTAMPTZ NULL CHECK (ended_at = date_trunc('milliseconds', ended_at)),
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '1 hour'),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX break_glass_user ON break_glass (user_id, expires_at DESC);

-- 테넌트는 플랫폼이 자기 데이터를 언제 무엇을 봤는지·바꿀 권한을 열었는지 볼 수 있다(투명성).
ALTER TABLE inspection_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY inspection_read ON inspection_audit_log FOR SELECT USING (rc_sees_all() OR target_tenant_id = rc_tenant());
CREATE POLICY inspection_write ON inspection_audit_log FOR INSERT WITH CHECK (rc_sees_all());
ALTER TABLE break_glass ENABLE ROW LEVEL SECURITY;
CREATE POLICY break_glass_read ON break_glass FOR SELECT USING (rc_sees_all() OR target_tenant_id = rc_tenant());
CREATE POLICY break_glass_write ON break_glass FOR INSERT WITH CHECK (rc_sees_all());
CREATE POLICY break_glass_end ON break_glass FOR UPDATE USING (rc_sees_all()) WITH CHECK (rc_sees_all());

GRANT SELECT, INSERT ON inspection_audit_log, break_glass TO rc_app;
GRANT UPDATE (ended_at) ON break_glass TO rc_app;
GRANT USAGE ON SEQUENCE inspection_audit_log_inspection_id_seq, break_glass_break_glass_id_seq TO rc_app;

-- 쓰기 권한: 워커(system)는 전부, 테넌트는 자기 소유, 플랫폼은 자기 소유 또는 break-glass로 연 테넌트 소유만.
-- 읽기(rc_owns)는 그대로다: 플랫폼은 전부 본다.
CREATE FUNCTION rc_can_write(owner text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE current_setting('rc.scope', true)
    WHEN 'system' THEN true
    WHEN 'tenant' THEN owner = rc_tenant()
    WHEN 'platform' THEN owner = rc_tenant() OR owner = NULLIF(current_setting('rc.break_glass_tenant', true), '')
    ELSE false
  END
$$;

-- 소유 테이블의 정책을 읽기·쓰기로 나눈다(0017의 owner_rw를 대체). UPDATE는 보이는 행을 잠글 수 있게 USING은 읽기 기준,
-- WITH CHECK는 쓰기 기준이라 권한 없는 수정은 조용히 0행이 아니라 RLS 위반(42501 → 403 TENANT_FORBIDDEN)으로 끝난다.
-- 새 행은 부모 행에도 쓸 수 있어야 한다: 플랫폼이 테넌트 곡 밑에 자기 소유 행을 붙이는 것도 막는다.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('work',              NULL),
    ('facts_scope',       'EXISTS (SELECT 1 FROM work p WHERE p.work_id = facts_scope.work_id AND rc_can_write(p.owner_tenant_id))'),
    ('recording_version', 'EXISTS (SELECT 1 FROM work p WHERE p.work_id = recording_version.work_id AND rc_can_write(p.owner_tenant_id))'),
    ('part_slot',         'EXISTS (SELECT 1 FROM recording_version p WHERE p.recording_id = part_slot.recording_id AND rc_can_write(p.owner_tenant_id))'),
    ('stem',              'EXISTS (SELECT 1 FROM part_slot p WHERE p.slot_id = stem.slot_id AND rc_can_write(p.owner_tenant_id))'),
    ('voice',             'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = voice.facts_scope_id AND rc_can_write(p.owner_tenant_id))'),
    ('right_claim',       'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = right_claim.facts_scope_id AND rc_can_write(p.owner_tenant_id))'),
    ('mandate',           'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = mandate.facts_scope_id AND rc_can_write(p.owner_tenant_id))'),
    ('dispute',           'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = dispute.facts_scope_id AND rc_can_write(p.owner_tenant_id))'),
    ('vocal_pack',        'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = vocal_pack.facts_scope_id AND rc_can_write(p.owner_tenant_id))'),
    ('pack_claimant',     'EXISTS (SELECT 1 FROM vocal_pack p WHERE p.pack_id = pack_claimant.pack_id AND rc_can_write(p.owner_tenant_id))'),
    ('policy_version',    'EXISTS (SELECT 1 FROM vocal_pack p WHERE p.pack_id = policy_version.pack_id AND rc_can_write(p.owner_tenant_id))')
  ) AS v(tbl, parent) LOOP
    EXECUTE format('DROP POLICY owner_rw ON %I', t.tbl);
    EXECUTE format('CREATE POLICY owner_read ON %I FOR SELECT USING (rc_owns(owner_tenant_id))', t.tbl);
    EXECUTE format('CREATE POLICY owner_insert ON %I FOR INSERT WITH CHECK (rc_can_write(owner_tenant_id)%s)',
      t.tbl, CASE WHEN t.parent IS NULL THEN '' ELSE ' AND ' || t.parent END);
    EXECUTE format('CREATE POLICY owner_update ON %I FOR UPDATE USING (rc_owns(owner_tenant_id)) WITH CHECK (rc_can_write(owner_tenant_id))', t.tbl);
    EXECUTE format('CREATE POLICY owner_delete ON %I FOR DELETE USING (rc_can_write(owner_tenant_id))', t.tbl);
  END LOOP;
END $$;

-- break-glass로 대행하는 동안 새로 만드는 행은 대상 테넌트 소유가 된다(플랫폼이 테넌트 곡 밑에 자기 소유 행을 남기지 않는다).
CREATE FUNCTION rc_owner_default() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('rc.break_glass_tenant', true), ''), rc_tenant(), 'tnt_platform')
$$;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work', 'facts_scope', 'recording_version', 'part_slot', 'stem', 'voice', 'right_claim', 'mandate', 'dispute',
                           'vocal_pack', 'pack_claimant', 'policy_version', 'consent_agreement'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN owner_tenant_id SET DEFAULT rc_owner_default()', t);
  END LOOP;
END $$;
