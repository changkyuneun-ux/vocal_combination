-- 이용허락 동의(v2.8 3.4 consent_agreement의 부분 집합, 다음 작업 2). 원천 동의(T0) 한 단계만 다룬다.
-- 한 행 = 한 파티가 한 자산(보이스·녹음·작품)에 대해 한 권리 종류로 한 허락. 엔진 GrantRule과 1:1로 대응한다.
-- 철회는 행을 지우지 않고 revoked_at을 한 번 기록한다. known_at 기준 상태는 signed_at·revoked_at으로 복원한다.

ALTER TABLE portal_role DROP CONSTRAINT portal_role_role_check;
ALTER TABLE portal_role ADD CONSTRAINT portal_role_role_check
  CHECK (role IN ('RIGHTS_EDITOR','EDITOR','WORK_APPROVER','ACTIVATOR','ISSUER','SPACE_OPS','SPACE_SETTLE','SYSTEM','PERFORMER'));
-- 실연자 본인 계정은 자기 파티와 연결된다(v2.8 user_account.party_id). PERFORMER 역할은 이 파티의 동의만 서명·철회한다.
ALTER TABLE user_account ADD COLUMN party_id mdrl_id NULL REFERENCES party;

-- 소속사 없는 개인(실연자·팬)의 기본 테넌트(v2.8 tnt_platform_default). 같은 테넌트의 개인끼리 서로의 데이터를 보면 안 되므로,
-- 이 테넌트 사용자는 테넌트가 아니라 자기 파티 범위(rc.scope = party, rc.party_id)로 조회한다.
ALTER TABLE tenant DROP CONSTRAINT tenant_tenant_type_check;
ALTER TABLE tenant ADD CONSTRAINT tenant_tenant_type_check
  CHECK (tenant_type IN ('LABEL','AGENCY','PUBLISHER','CMO','PLATFORM_OPS','B2B_PARTNER','PLATFORM_DEFAULT'));
INSERT INTO tenant VALUES ('tnt_platform_default', 'PLATFORM_DEFAULT', '개인(소속 없음)', 'ACTIVE', '2026-01-01T00:00:00Z');

CREATE FUNCTION rc_party() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('rc.party_id', true), '') $$;
-- 파티 범위는 아무 소유 데이터도 갖지 않는다(등록·정책 권한이 없다).
CREATE OR REPLACE FUNCTION rc_owns(owner text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT rc_sees_all() OR (current_setting('rc.scope', true) = 'tenant' AND owner = rc_tenant())
$$;
CREATE OR REPLACE FUNCTION rc_party_visible(p text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT rc_sees_all()
      OR (current_setting('rc.scope', true) = 'tenant' AND EXISTS (SELECT 1 FROM party WHERE party_id = p AND tenant_id = rc_tenant()))
      OR (current_setting('rc.scope', true) = 'party' AND p = rc_party())
$$;

CREATE TABLE consent_agreement (
  consent_id         mdrl_id PRIMARY KEY,
  facts_scope_id     mdrl_id NOT NULL REFERENCES facts_scope,
  party_id           mdrl_id NOT NULL REFERENCES party,
  right_type         TEXT NOT NULL CHECK (right_type IN ('PERFORMER','MASTER','WORK')),
  asset_id           mdrl_id NOT NULL,
  scope_actions      TEXT[] NOT NULL CHECK (cardinality(scope_actions) > 0),
  territories        TEXT[] NOT NULL CHECK (cardinality(territories) > 0),
  media              TEXT[] NOT NULL CHECK (cardinality(media) > 0),
  audience           TEXT[] NOT NULL CHECK (cardinality(audience) > 0),
  -- 무기한 포괄 동의 금지(v2.8): valid_to 필수.
  valid_from         TIMESTAMPTZ NOT NULL CHECK (valid_from = date_trunc('milliseconds', valid_from)),
  valid_to           TIMESTAMPTZ NOT NULL CHECK (valid_to = date_trunc('milliseconds', valid_to)),
  source_contract_uri TEXT NULL,
  signed_by          mdrl_id NOT NULL REFERENCES user_account,
  signed_at          TIMESTAMPTZ NOT NULL CHECK (signed_at = date_trunc('milliseconds', signed_at)),
  revoked_by         mdrl_id NULL REFERENCES user_account,
  revoked_at         TIMESTAMPTZ NULL CHECK (revoked_at = date_trunc('milliseconds', revoked_at)),
  revoke_reason      TEXT NULL,
  owner_tenant_id    mdrl_id NOT NULL DEFAULT COALESCE(rc_tenant(), 'tnt_platform') REFERENCES tenant,
  CHECK (valid_to > valid_from),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= signed_at)
);
CREATE INDEX consent_scope ON consent_agreement (facts_scope_id, signed_at);
CREATE INDEX consent_party ON consent_agreement (party_id);

-- 추가 전용: 철회 기록(revoked_*를 NULL에서 값으로 한 번)만 허용한다.
CREATE FUNCTION rc_consent_revoke_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append-only table %: DELETE rejected', TG_TABLE_NAME USING ERRCODE = 'RC001';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (to_jsonb(NEW) - 'revoked_at' - 'revoked_by' - 'revoke_reason') <> (to_jsonb(OLD) - 'revoked_at' - 'revoked_by' - 'revoke_reason') THEN
    RAISE EXCEPTION 'append-only table %: only a single revocation is allowed', TG_TABLE_NAME USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_revoke_only BEFORE UPDATE OR DELETE ON consent_agreement FOR EACH ROW EXECUTE FUNCTION rc_consent_revoke_only();

-- 가시성: 기록한 테넌트, 동의한 파티(의 테넌트·본인), 그 곡(범위)을 소유한 테넌트.
-- 서명: 동의 파티가 보이는 범위(파티의 테넌트·본인·플랫폼). 철회: 동의 파티 쪽 또는 기록한 테넌트(누가 기록했든 본인은 철회할 수 있다).
ALTER TABLE consent_agreement ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_read ON consent_agreement FOR SELECT
  USING (rc_owns(owner_tenant_id) OR rc_party_visible(party_id)
         OR EXISTS (SELECT 1 FROM facts_scope p WHERE p.facts_scope_id = consent_agreement.facts_scope_id));
CREATE POLICY consent_sign ON consent_agreement FOR INSERT WITH CHECK (rc_party_visible(party_id));
CREATE POLICY consent_revoke ON consent_agreement FOR UPDATE
  USING (rc_party_visible(party_id) OR rc_owns(owner_tenant_id)) WITH CHECK (rc_party_visible(party_id) OR rc_owns(owner_tenant_id));

GRANT SELECT, INSERT ON consent_agreement TO rc_app;
GRANT UPDATE (revoked_by, revoked_at, revoke_reason) ON consent_agreement TO rc_app;
GRANT UPDATE (party_id) ON user_account TO rc_app;
