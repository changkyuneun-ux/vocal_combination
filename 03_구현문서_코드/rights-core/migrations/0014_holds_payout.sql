-- 보류 해제(통합 설계 11.2-5): 원 보류(line_seq = 1) 하나는 한 번만 해제된다. allocation = {party_id: "원"}.
CREATE TABLE hold_release (
  release_id  BIGSERIAL PRIMARY KEY,
  holding_id  BIGINT NOT NULL UNIQUE REFERENCES unallocated_holding,
  released_by vcrl_id NOT NULL REFERENCES user_account,
  released_at TIMESTAMPTZ NOT NULL CHECK (released_at = date_trunc('milliseconds', released_at)),
  allocation  JSONB NOT NULL CHECK (jsonb_typeof(allocation) = 'object'),
  entry_id    BIGINT NOT NULL REFERENCES journal_entry
);
CREATE TRIGGER hold_release_immutable BEFORE UPDATE OR DELETE ON hold_release FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON hold_release TO rc_app;
GRANT USAGE ON SEQUENCE hold_release_release_id_seq TO rc_app;

-- 해제된 보류의 역분개 진행(통합 설계 11.2-5): 역분개마다 권리자별로 되돌린 금액(양수). 다음 역분개의 가중치 = 배분 − 누적.
CREATE TABLE hold_release_reversal (
  release_id  BIGINT NOT NULL REFERENCES hold_release,
  reversal_id vcrl_id NOT NULL REFERENCES reversal_run,
  party_id    vcrl_id NOT NULL REFERENCES party,
  amount_krw  BIGINT NOT NULL CHECK (amount_krw > 0),
  PRIMARY KEY (release_id, reversal_id, party_id)
);
CREATE TRIGGER hold_release_reversal_immutable BEFORE UPDATE OR DELETE ON hold_release_reversal FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON hold_release_reversal TO rc_app;

-- 지급(통합 설계 11.2-6). 권리자 지급 프로필: 운영 편집은 세금 유형·계좌 토큰·KYC·수정 시각만. 첫 지급 가능 시각은 바꾸지 않는다.
CREATE TABLE party_payout_profile (
  party_id           vcrl_id PRIMARY KEY REFERENCES party,
  tax_type           TEXT NOT NULL CHECK (tax_type IN ('DOMESTIC_INDIVIDUAL','DOMESTIC_CORP','FOREIGN','EXEMPT')),
  payout_account_ref TEXT NULL,          -- PSP 쪽 계좌 토큰(원문 계좌번호를 저장하지 않는다)
  kyc_verified       BOOLEAN NOT NULL DEFAULT false,
  first_payable_at   TIMESTAMPTZ NOT NULL CHECK (first_payable_at = date_trunc('milliseconds', first_payable_at)),
  updated_at         TIMESTAMPTZ NOT NULL CHECK (updated_at = date_trunc('milliseconds', updated_at))
);
-- 지급 정책(설정 가능 — 운영 전 세무 확인 필요). 앱은 읽기만 하고, 값은 소유자 역할이 바꾼다.
CREATE TABLE payout_policy (
  policy_id          TEXT PRIMARY KEY CHECK (policy_id = 'default'),
  min_payout_krw     BIGINT NOT NULL CHECK (min_payout_krw > 0),
  initial_hold_days  INT NOT NULL CHECK (initial_hold_days >= 0),
  tax_bps            JSONB NOT NULL CHECK (jsonb_typeof(tax_bps) = 'object')  -- {"DOMESTIC_INDIVIDUAL":330,...}
);
INSERT INTO payout_policy VALUES ('default', 10000, 30, '{"DOMESTIC_INDIVIDUAL":330,"DOMESTIC_CORP":0,"FOREIGN":2200,"EXEMPT":0}');
CREATE TABLE payout_run (
  payout_run_id vcrl_id PRIMARY KEY,
  as_of         TIMESTAMPTZ NOT NULL CHECK (as_of = date_trunc('milliseconds', as_of)),
  created_by    vcrl_id NOT NULL REFERENCES user_account,
  created_at    TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);
CREATE TABLE payout_instruction (
  instruction_id   vcrl_id PRIMARY KEY,
  payout_run_id    vcrl_id NOT NULL REFERENCES payout_run,
  party_id         vcrl_id NOT NULL REFERENCES party,
  gross_krw        BIGINT NOT NULL,
  withholding_krw  BIGINT NOT NULL CHECK (withholding_krw >= 0),
  net_krw          BIGINT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PENDING','SUBMITTED','PAID','FAILED','CARRIED','HELD')),
  hold_reason      TEXT NULL CHECK (hold_reason IN ('NO_PROFILE','NO_ACCOUNT','KYC_REQUIRED','INITIAL_HOLD')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  provider_ref     TEXT NULL,
  entry_id         BIGINT NULL REFERENCES journal_entry,
  settled_entry_id BIGINT NULL REFERENCES journal_entry,
  created_at       TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  UNIQUE (payout_run_id, party_id),
  CHECK (net_krw = gross_krw - withholding_krw),
  CHECK ((status IN ('CARRIED','HELD')) = (entry_id IS NULL)),
  CHECK ((status = 'HELD') = (hold_reason IS NOT NULL))
);
CREATE INDEX payout_instruction_party ON payout_instruction (party_id);

CREATE FUNCTION rc_party_payout_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['tax_type','payout_account_ref','kyc_verified','updated_at'])
     <> (to_jsonb(OLD) - ARRAY['tax_type','payout_account_ref','kyc_verified','updated_at']) THEN
    RAISE EXCEPTION 'party_payout_profile %: only tax_type, payout_account_ref, kyc_verified and updated_at may change', OLD.party_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- 지시: PENDING → SUBMITTED|PAID|FAILED, SUBMITTED → PAID|FAILED. CARRIED·HELD는 어떤 변경도 없고, PAID·FAILED는 끝 상태.
-- provider_ref·settled_entry_id는 NULL → 값 한 번만. 그 밖의 열은 바꾸지 않는다.
CREATE FUNCTION rc_payout_instruction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CARRIED','HELD') THEN
    RAISE EXCEPTION 'payout_instruction %: % is final', OLD.instruction_id, OLD.status USING ERRCODE = 'RC001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('SUBMITTED','PAID','FAILED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('PAID','FAILED'))) THEN
    RAISE EXCEPTION 'payout_instruction %: status % -> % rejected', OLD.instruction_id, OLD.status, NEW.status USING ERRCODE = 'RC001';
  END IF;
  IF (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
     OR (OLD.settled_entry_id IS NOT NULL AND NEW.settled_entry_id IS DISTINCT FROM OLD.settled_entry_id) THEN
    RAISE EXCEPTION 'payout_instruction %: provider_ref and settled_entry_id are write-once', OLD.instruction_id USING ERRCODE = 'RC001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','provider_ref','settled_entry_id'])
     <> (to_jsonb(OLD) - ARRAY['status','provider_ref','settled_entry_id']) THEN
    RAISE EXCEPTION 'payout_instruction %: only status, provider_ref and settled_entry_id may change', OLD.instruction_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER party_payout_profile_guard BEFORE UPDATE ON party_payout_profile FOR EACH ROW EXECUTE FUNCTION rc_party_payout_profile_guard();
CREATE TRIGGER party_payout_profile_no_delete BEFORE DELETE ON party_payout_profile FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER payout_policy_no_delete BEFORE DELETE ON payout_policy FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER payout_run_immutable BEFORE UPDATE OR DELETE ON payout_run FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER payout_instruction_guard BEFORE UPDATE ON payout_instruction FOR EACH ROW EXECUTE FUNCTION rc_payout_instruction_guard();
CREATE TRIGGER payout_instruction_no_delete BEFORE DELETE ON payout_instruction FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

GRANT SELECT, INSERT ON party_payout_profile, payout_run, payout_instruction TO rc_app;
GRANT UPDATE (tax_type, payout_account_ref, kyc_verified, updated_at) ON party_payout_profile TO rc_app;
GRANT UPDATE (status, provider_ref, settled_entry_id) ON payout_instruction TO rc_app;
GRANT SELECT ON payout_policy TO rc_app;
