-- 테넌트 정책(00_프로젝트_개요/테넌트_관리_기준과_정책_20261019.md, 결정 TD1~TD12) 1단계.
-- 참여 구분(TD1), 조직 정보·수명주기·확인 항목(TD5·TD7), 당사자 식별(TD2), 역할(TD3·TD4·TD12), 다중 소속(TD9).

-- ── 참여 구분(TD1): 조직 단위 값은 하나(tenant)로 두고, 그 종류를 명시한다 ─────────────────────────
-- RIGHTS = 권리 테넌트(권리를 등록·관리), PARTICIPANT = 참여 기관(신탁단체·유통 파트너, 연결로만 닿는다),
-- INDIVIDUAL = 개인 계정 모음(실연자·팬), PLATFORM = 플랫폼 운영.
ALTER TABLE tenant DROP CONSTRAINT tenant_tenant_type_check;
ALTER TABLE tenant ADD CONSTRAINT tenant_tenant_type_check
  CHECK (tenant_type IN ('LABEL','AGENCY','PUBLISHER','INDEPENDENT_ARTIST','CMO','B2B_PARTNER','PLATFORM_OPS','PLATFORM_DEFAULT'));
ALTER TABLE tenant ADD COLUMN org_class TEXT GENERATED ALWAYS AS (CASE tenant_type
  WHEN 'PLATFORM_OPS' THEN 'PLATFORM' WHEN 'PLATFORM_DEFAULT' THEN 'INDIVIDUAL'
  WHEN 'CMO' THEN 'PARTICIPANT' WHEN 'B2B_PARTNER' THEN 'PARTICIPANT' ELSE 'RIGHTS' END) STORED;

-- 조직 정보: 사업자번호(독립 아티스트는 없을 수 있다), 국가, 대표자.
ALTER TABLE tenant ADD COLUMN business_no TEXT NULL, ADD COLUMN country CHAR(2) NULL, ADD COLUMN representative TEXT NULL;

-- ── 수명주기(TD5·TD7): 신청 → 확인됨 → 활성 ⇄ 정지 → 해지 ────────────────────────────────────────
-- 기존 행과 직접 넣는 행(시험)은 ACTIVE 그대로다. 등록 API는 APPLIED로 만든다.
ALTER TABLE tenant DROP CONSTRAINT tenant_status_check;
ALTER TABLE tenant ADD CONSTRAINT tenant_status_check CHECK (status IN ('APPLIED','VERIFIED','ACTIVE','SUSPENDED','TERMINATED'));
ALTER TABLE tenant ADD COLUMN status_changed_at TIMESTAMPTZ NULL, ADD COLUMN status_reason TEXT NULL;
GRANT UPDATE (status, status_changed_at, status_reason, business_no, country, representative, name) ON tenant TO rc_app;

-- 확인 항목(KYB 체크리스트): 운영이 하나씩 확인한다. 확인됨·활성으로 넘어가려면 필요한 항목이 모두 있어야 한다(코드가 판정).
CREATE TABLE tenant_check (
  tenant_id   mdrl_id NOT NULL REFERENCES tenant,
  item        TEXT NOT NULL CHECK (item IN ('BUSINESS_ID','IDENTITY','REPRESENTATIVE','PLATFORM_AGREEMENT','RIGHTS_EVIDENCE','TRUST_LICENSE','DISTRIBUTION_AGREEMENT')),
  checked_by  mdrl_id NOT NULL REFERENCES user_account,
  checked_at  TIMESTAMPTZ NOT NULL CHECK (checked_at = date_trunc('milliseconds', checked_at)),
  note        TEXT NULL,
  document_id mdrl_id NULL,
  PRIMARY KEY (tenant_id, item)
);
ALTER TABLE tenant_check ENABLE ROW LEVEL SECURITY;
-- 자기 조직의 확인 상태는 그 조직도 본다. 쓰기는 플랫폼만.
CREATE POLICY own_read ON tenant_check FOR SELECT USING (rc_owns(tenant_id));
CREATE POLICY platform_write ON tenant_check FOR INSERT WITH CHECK (rc_sees_all());
CREATE POLICY platform_delete ON tenant_check FOR DELETE USING (rc_sees_all());
GRANT SELECT, INSERT, DELETE ON tenant_check TO rc_app;

-- ── 당사자 식별(TD2): 법인은 사업자번호, 개인은 본인 확인 참조. 계좌 예금주와 맞춰 본다 ─────────────────────
ALTER TABLE party ADD COLUMN legal_id TEXT NULL;
-- 같은 테넌트에 다른 법인을 둘 때의 근거(계열사 관리 위임 계약 원천 문서).
ALTER TABLE party ADD COLUMN management_document_id mdrl_id NULL;
-- 관리 이관(TN2): 플랫폼이 당사자의 관리 주체(party.tenant_id)를 옮긴다.
GRANT UPDATE (tenant_id) ON party TO rc_app;
ALTER TABLE party_payout_profile ADD COLUMN account_holder_id TEXT NULL;
GRANT UPDATE (account_holder_id) ON party_payout_profile TO rc_app;

-- 지급 보류: 관리 주체 조직이 정지되면 그 당사자 지급을 보류한다(정산은 계속 계산).
ALTER TABLE payout_instruction DROP CONSTRAINT payout_instruction_hold_reason_check;
ALTER TABLE payout_instruction ADD CONSTRAINT payout_instruction_hold_reason_check
  CHECK (hold_reason IN ('NO_PROFILE','NO_ACCOUNT','KYC_REQUIRED','INITIAL_HOLD','ACCOUNT_COOLING','ACCOUNT_SOD','TENANT_SUSPENDED'));

-- ── 역할(TD3·TD4·TD12) ───────────────────────────────────────────────────────────────────
-- TENANT_ADMIN = 조직 관리자(담당자 계정·역할·잠금), ONBOARDING = 플랫폼 온보딩(당사자 등록·위탁 당사자 계약),
-- TRUST_OFFICER = 신탁단체 신탁 담당(연결 확인·명세), PARTNER_INTEGRATION = 유통 파트너 연동 담당(리포트·상품 대응).
ALTER TABLE portal_role DROP CONSTRAINT portal_role_role_check;
ALTER TABLE portal_role ADD CONSTRAINT portal_role_role_check
  CHECK (role IN ('RIGHTS_EDITOR','EDITOR','WORK_APPROVER','ACTIVATOR','ISSUER','SPACE_OPS','SPACE_SETTLE','SYSTEM','PERFORMER','COMPLIANCE','LEGAL',
                  'TENANT_ADMIN','ONBOARDING','TRUST_OFFICER','PARTNER_INTEGRATION'));

-- ── 다중 소속(TD9): 계정 하나에 소속 여러 개, 역할은 소속마다 ───────────────────────────────────────
-- user_account.tenant_id는 처음 만든 소속(기본 소속)이다. 소속은 모두 user_membership에 있다.
CREATE TABLE user_membership (
  user_id   mdrl_id NOT NULL REFERENCES user_account,
  tenant_id mdrl_id NOT NULL REFERENCES tenant,
  added_by  mdrl_id NULL REFERENCES user_account,
  added_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX user_membership_tenant ON user_membership (tenant_id);
INSERT INTO user_membership (user_id, tenant_id, added_at) SELECT user_id, tenant_id, created_at FROM user_account;
-- 계정을 만들면 기본 소속이 생긴다.
CREATE FUNCTION rc_home_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO user_membership (user_id, tenant_id, added_at) VALUES (NEW.user_id, NEW.tenant_id, NEW.created_at) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER user_account_home_membership AFTER INSERT ON user_account FOR EACH ROW EXECUTE FUNCTION rc_home_membership();
GRANT SELECT, INSERT, DELETE ON user_membership TO rc_app;

-- 역할은 소속마다 따로 준다. 소속을 적지 않으면 기본 소속의 역할이다.
ALTER TABLE portal_role ADD COLUMN tenant_id mdrl_id NULL REFERENCES tenant;
UPDATE portal_role r SET tenant_id = u.tenant_id FROM user_account u WHERE u.user_id = r.user_id;
CREATE FUNCTION rc_role_home_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN SELECT tenant_id INTO NEW.tenant_id FROM user_account WHERE user_id = NEW.user_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_role_home_tenant BEFORE INSERT ON portal_role FOR EACH ROW EXECUTE FUNCTION rc_role_home_tenant();
ALTER TABLE portal_role ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE portal_role DROP CONSTRAINT portal_role_pkey;
ALTER TABLE portal_role ADD PRIMARY KEY (user_id, tenant_id, role);
ALTER TABLE portal_role ADD FOREIGN KEY (user_id, tenant_id) REFERENCES user_membership;
GRANT DELETE ON portal_role TO rc_app;

-- 세션은 "지금 일하는 소속"을 갖는다(없으면 기본 소속). 감사 로그에는 그 소속이 남는다.
ALTER TABLE user_session ADD COLUMN tenant_id mdrl_id NULL REFERENCES tenant;
ALTER TABLE audit_log ADD COLUMN acting_tenant_id TEXT NULL DEFAULT NULLIF(current_setting('rc.tenant_id', true), '');
