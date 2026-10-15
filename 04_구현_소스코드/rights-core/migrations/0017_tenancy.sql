-- 멀티테넌시(v2.8 3.1 tenant, 아키텍처 문서 "멀티테넌시"). 테넌트는 로그인 조직 단위이고 정산 금액은 파티에 귀속된다.
-- 요청 범위는 트랜잭션 설정으로 넘긴다: rc.scope = system(워커·내부) | platform(플랫폼 운영 테넌트 사용자) | tenant, rc.tenant_id.
-- 앱 역할(rc_app)에만 RLS가 걸린다. 테이블 소유자(마이그레이션 역할)는 RLS를 우회한다.

CREATE TABLE tenant (
  tenant_id   mdrl_id PRIMARY KEY,
  tenant_type TEXT NOT NULL CHECK (tenant_type IN ('LABEL','AGENCY','PUBLISHER','CMO','PLATFORM_OPS','B2B_PARTNER')),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','TERMINATED')),
  created_at  TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);
INSERT INTO tenant VALUES ('tnt_platform', 'PLATFORM_OPS', 'dobedubpop 플랫폼 운영', 'ACTIVE', '2026-01-01T00:00:00Z');
GRANT SELECT, INSERT ON tenant TO rc_app;

CREATE FUNCTION rc_tenant() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('rc.tenant_id', true), '') $$;
-- 범위 설정이 없으면 아무것도 보이지 않는다(fail-closed).
CREATE FUNCTION rc_sees_all() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('rc.scope', true), '') IN ('system', 'platform') $$;
CREATE FUNCTION rc_owns(owner text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT rc_sees_all() OR owner = rc_tenant() $$;

-- 소속: 사용자와 파티. 기존 행과 범위 없는 삽입은 플랫폼 테넌트로 둔다.
ALTER TABLE user_account ADD COLUMN tenant_id mdrl_id NOT NULL DEFAULT 'tnt_platform' REFERENCES tenant;
ALTER TABLE party ADD COLUMN tenant_id mdrl_id NOT NULL DEFAULT COALESCE(rc_tenant(), 'tnt_platform') REFERENCES tenant;
CREATE INDEX party_tenant ON party (tenant_id);
-- 참여 데이터: 그 파티가 소속된 테넌트만 본다. party 자체는 다른 테넌트의 권리자를 참조해야 하므로 RLS를 걸지 않는다.
CREATE FUNCTION rc_party_visible(p text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT rc_sees_all() OR EXISTS (SELECT 1 FROM party WHERE party_id = p AND tenant_id = rc_tenant())
$$;

-- 소유 데이터: 등록한 테넌트(owner_tenant_id)만 읽고 쓴다. 쓰기는 부모 행이 보여야 한다(다른 테넌트의 곡 밑에 녹음·스템·주장을 붙일 수 없다).
-- 정책 식의 부모 조회도 RLS를 받으므로 "부모가 보인다" = "부모를 소유했다(또는 전체 범위)"다.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('work',              NULL),
    ('facts_scope',       'EXISTS (SELECT 1 FROM work p WHERE p.work_id = facts_scope.work_id)'),
    ('recording_version', 'EXISTS (SELECT 1 FROM work p WHERE p.work_id = recording_version.work_id)'),
    ('part_slot',         'EXISTS (SELECT 1 FROM recording_version p WHERE p.recording_id = part_slot.recording_id)'),
    ('stem',              'EXISTS (SELECT 1 FROM part_slot p WHERE p.slot_id = stem.slot_id)'),
    ('voice',             'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = voice.facts_scope_id)'),
    ('right_claim',       'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = right_claim.facts_scope_id)'),
    ('mandate',           'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = mandate.facts_scope_id)'),
    ('dispute',           'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = dispute.facts_scope_id)'),
    ('vocal_pack',        'EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = vocal_pack.facts_scope_id)'),
    ('pack_claimant',     'EXISTS (SELECT 1 FROM vocal_pack p WHERE p.pack_id = pack_claimant.pack_id)'),
    ('policy_version',    'EXISTS (SELECT 1 FROM vocal_pack p WHERE p.pack_id = policy_version.pack_id)')
  ) AS v(tbl, parent) LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN owner_tenant_id mdrl_id NOT NULL DEFAULT COALESCE(rc_tenant(), %L) REFERENCES tenant', t.tbl, 'tnt_platform');
    EXECUTE format('CREATE INDEX %I ON %I (owner_tenant_id)', t.tbl || '_owner', t.tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('CREATE POLICY owner_rw ON %I USING (rc_owns(owner_tenant_id)) WITH CHECK (rc_owns(owner_tenant_id)%s)',
      t.tbl, CASE WHEN t.parent IS NULL THEN '' ELSE ' AND ' || t.parent END);
  END LOOP;
END $$;

-- 발행 데이터: 팩이 보이는 테넌트만 본다(발행은 플랫폼 범위에서 일어난다).
ALTER TABLE rights_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY pack_visible ON rights_snapshot USING (rc_sees_all() OR EXISTS (SELECT 1 FROM vocal_pack p WHERE p.pack_id = rights_snapshot.pack_id));
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['snapshot_stem_assignment', 'snapshot_member_pct', 'issue_seal'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY snapshot_visible ON %I USING (rc_sees_all() OR EXISTS (SELECT 1 FROM rights_snapshot s WHERE s.snapshot_id = %I.snapshot_id))', t, t);
  END LOOP;
END $$;

-- 참여 데이터: 정산 라인·지급·지급 프로필·파티 계정과 그 전기.
ALTER TABLE allocation_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY party_visible ON allocation_line USING (rc_party_visible(party_id));
ALTER TABLE payout_instruction ENABLE ROW LEVEL SECURITY;
CREATE POLICY party_visible ON payout_instruction USING (rc_party_visible(party_id));
ALTER TABLE party_payout_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY party_visible ON party_payout_profile USING (rc_party_visible(party_id));
ALTER TABLE ledger_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY party_visible ON ledger_account USING (rc_sees_all() OR (party_id IS NOT NULL AND rc_party_visible(party_id)));
ALTER TABLE posting ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_visible ON posting USING (rc_sees_all() OR EXISTS (SELECT 1 FROM ledger_account a WHERE a.account_id = posting.account_id));

-- 플랫폼 운영 데이터: 테넌트 범위에서는 읽을 수 없다. 감사 로그·outbox는 테넌트 요청도 쓴다(읽기만 막는다).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['revenue_event', 'revenue_supersede', 'settlement_batch', 'settlement_batch_skip', 'settlement_run', 'settlement_run_event',
                           'settlement_run_event_refund', 'pool_line', 'unallocated_holding', 'reversal_run', 'hold_release', 'hold_release_reversal',
                           'quarantine', 'psp_webhook_inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_only ON %I USING (rc_sees_all())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit_log', 'outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_read ON %I FOR SELECT USING (rc_sees_all())', t);
    EXECUTE format('CREATE POLICY anyone_insert ON %I FOR INSERT WITH CHECK (true)', t);
  END LOOP;
END $$;
-- outbox 처리 표시(UPDATE)는 폴러(system 범위)만 한다.
CREATE POLICY platform_update ON outbox FOR UPDATE USING (rc_sees_all());
