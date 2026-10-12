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

-- 지급(통합 설계 11.2-6). 권리자 지급 프로필: 운영 편집은 세금 유형·계좌 토큰·KYC·수정 시각·계좌 변경 기록만. 첫 지급 가능 시각은 바꾸지 않는다.
-- account_changed_at·account_changed_by: 계좌 토큰이 마지막으로 바뀐 시각과 바꾼 사용자(토큰이 바뀔 때만 갱신 — 냉각 기간·직무 분리 판정).
CREATE TABLE party_payout_profile (
  party_id           vcrl_id PRIMARY KEY REFERENCES party,
  tax_type           TEXT NOT NULL CHECK (tax_type IN ('DOMESTIC_INDIVIDUAL','DOMESTIC_CORP','FOREIGN','EXEMPT')),
  payout_account_ref TEXT NULL,          -- PSP 쪽 계좌 토큰(원문 계좌번호를 저장하지 않는다)
  kyc_verified       BOOLEAN NOT NULL DEFAULT false,
  first_payable_at   TIMESTAMPTZ NOT NULL CHECK (first_payable_at = date_trunc('milliseconds', first_payable_at)),
  updated_at         TIMESTAMPTZ NOT NULL CHECK (updated_at = date_trunc('milliseconds', updated_at)),
  account_changed_at TIMESTAMPTZ NULL CHECK (account_changed_at = date_trunc('milliseconds', account_changed_at)),
  account_changed_by vcrl_id NULL REFERENCES user_account,
  CHECK ((account_changed_at IS NULL) = (account_changed_by IS NULL)),
  CHECK (payout_account_ref IS NULL OR account_changed_at IS NOT NULL)
);
-- 지급 정책(설정 가능 — 운영 전 세무 확인 필요). 앱은 읽기만 하고, 값은 소유자 역할이 바꾼다.
CREATE TABLE payout_policy (
  policy_id          TEXT PRIMARY KEY CHECK (policy_id = 'default'),
  min_payout_krw     BIGINT NOT NULL CHECK (min_payout_krw > 0),
  initial_hold_days  INT NOT NULL CHECK (initial_hold_days >= 0),
  tax_bps            JSONB NOT NULL CHECK (jsonb_typeof(tax_bps) = 'object'),  -- {"DOMESTIC_INDIVIDUAL":330,...}
  account_cooling_hours INT NOT NULL DEFAULT 72 CHECK (account_cooling_hours >= 0)  -- 계좌 토큰 변경 뒤 지급하지 않는 시간(ACCOUNT_COOLING)
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
  hold_reason      TEXT NULL CHECK (hold_reason IN ('NO_PROFILE','NO_ACCOUNT','KYC_REQUIRED','INITIAL_HOLD','ACCOUNT_COOLING','ACCOUNT_SOD')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  provider_ref     TEXT NULL,
  entry_id         BIGINT NULL REFERENCES journal_entry,
  settled_entry_id BIGINT NULL REFERENCES journal_entry,   -- 결과 분개: PAID면 PAYOUT_SETTLED, FAILED면 PAYOUT_FAILED
  submit_attempted_at TIMESTAMPTZ NULL CHECK (submit_attempted_at = date_trunc('milliseconds', submit_attempted_at)), -- PSP 전송 직전에 커밋(이후 로컬 실패 금지)
  submit_unknown_at   TIMESTAMPTZ NULL CHECK (submit_unknown_at = date_trunc('milliseconds', submit_unknown_at)),     -- submit 결과 불명(poll-payout이 재조회 중)
  submitted_account_ref TEXT NULL,   -- 처음 PSP에 보낸 계좌 토큰(submit_attempted_at과 함께 한 번만 기록). 재전송은 프로필이 아니라 이 값을 쓴다.
  decided_account_ref TEXT NULL,     -- 지급 실행이 판정(냉각·직무 분리)한 계좌 토큰. PENDING 지시에만 INSERT 때 한 번 쓴다. 전송 때 현재 토큰과 다르면 보내지 않는다.
  created_at       TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  UNIQUE (payout_run_id, party_id),
  CHECK (net_krw = gross_krw - withholding_krw),
  CHECK ((status IN ('CARRIED','HELD')) = (entry_id IS NULL)),
  CHECK ((status = 'HELD') = (hold_reason IS NOT NULL)),
  CHECK ((submit_attempted_at IS NULL) = (submitted_account_ref IS NULL)),
  CHECK ((entry_id IS NULL) = (decided_account_ref IS NULL))
);
CREATE INDEX payout_instruction_party ON payout_instruction (party_id);

CREATE FUNCTION rc_party_payout_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['tax_type','payout_account_ref','kyc_verified','updated_at','account_changed_at','account_changed_by'])
     <> (to_jsonb(OLD) - ARRAY['tax_type','payout_account_ref','kyc_verified','updated_at','account_changed_at','account_changed_by']) THEN
    RAISE EXCEPTION 'party_payout_profile %: only tax_type, payout_account_ref, kyc_verified, updated_at and account_changed_at/by may change', OLD.party_id USING ERRCODE = 'RC001';
  END IF;
  -- 변경 시각·변경자는 계좌 토큰이 바뀔 때만 바뀐다(토큰이 그대로면 둘 다 그대로 — 냉각 기간을 앞당기거나 변경자를 바꿔 쓸 수 없다).
  IF NEW.payout_account_ref IS NOT DISTINCT FROM OLD.payout_account_ref
     AND (NEW.account_changed_at IS DISTINCT FROM OLD.account_changed_at OR NEW.account_changed_by IS DISTINCT FROM OLD.account_changed_by) THEN
    RAISE EXCEPTION 'party_payout_profile %: account_changed_at/by change only when payout_account_ref changes', OLD.party_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- 지시: PENDING → SUBMITTED|PAID|FAILED, SUBMITTED → PAID|FAILED. CARRIED·HELD는 어떤 변경도 없고, PAID·FAILED는 끝 상태.
-- provider_ref·settled_entry_id·submit_attempted_at·submit_unknown_at은 NULL → 값 한 번만. 그 밖의 열은 바꾸지 않는다.
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
     OR (OLD.settled_entry_id IS NOT NULL AND NEW.settled_entry_id IS DISTINCT FROM OLD.settled_entry_id)
     OR (OLD.submit_attempted_at IS NOT NULL AND NEW.submit_attempted_at IS DISTINCT FROM OLD.submit_attempted_at)
     OR (OLD.submit_unknown_at IS NOT NULL AND NEW.submit_unknown_at IS DISTINCT FROM OLD.submit_unknown_at)
     OR (OLD.submitted_account_ref IS NOT NULL AND NEW.submitted_account_ref IS DISTINCT FROM OLD.submitted_account_ref) THEN
    RAISE EXCEPTION 'payout_instruction %: provider_ref, settled_entry_id, submit_attempted_at, submit_unknown_at and submitted_account_ref are write-once', OLD.instruction_id USING ERRCODE = 'RC001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','provider_ref','settled_entry_id','submit_attempted_at','submit_unknown_at','submitted_account_ref'])
     <> (to_jsonb(OLD) - ARRAY['status','provider_ref','settled_entry_id','submit_attempted_at','submit_unknown_at','submitted_account_ref']) THEN
    RAISE EXCEPTION 'payout_instruction %: only status, provider_ref, settled_entry_id, submit_attempted_at, submit_unknown_at and submitted_account_ref may change', OLD.instruction_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- INSERT 경로 가드(11.2-12와 같은 방식): 지시는 PENDING·CARRIED·HELD로만 생기고, PSP 쪽 필드(참조·결과 분개·전송 표식·불명·전송 계좌)는 비어 있다.
-- decided_account_ref는 PENDING일 때만 INSERT에서 쓴다(UPDATE 가드의 '그 밖의 열은 바꾸지 않는다'로 이후 불변, UPDATE 권한도 없다).
CREATE FUNCTION rc_payout_instruction_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('PENDING','CARRIED','HELD') OR NEW.provider_ref IS NOT NULL OR NEW.settled_entry_id IS NOT NULL
     OR NEW.submit_attempted_at IS NOT NULL OR NEW.submit_unknown_at IS NOT NULL OR NEW.submitted_account_ref IS NOT NULL THEN
    RAISE EXCEPTION 'payout_instruction %: must be inserted as PENDING, CARRIED or HELD with provider_ref, settled_entry_id, submit_attempted_at, submit_unknown_at and submitted_account_ref NULL', NEW.instruction_id USING ERRCODE = 'RC001';
  END IF;
  -- 판정한 계좌 토큰은 PENDING 지시에만(있어야 하고), CARRIED·HELD에는 없다.
  IF (NEW.status = 'PENDING') <> (NEW.decided_account_ref IS NOT NULL) THEN
    RAISE EXCEPTION 'payout_instruction %: decided_account_ref is required for PENDING and forbidden otherwise', NEW.instruction_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER party_payout_profile_guard BEFORE UPDATE ON party_payout_profile FOR EACH ROW EXECUTE FUNCTION rc_party_payout_profile_guard();
CREATE TRIGGER party_payout_profile_no_delete BEFORE DELETE ON party_payout_profile FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER payout_policy_no_delete BEFORE DELETE ON payout_policy FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER payout_run_immutable BEFORE UPDATE OR DELETE ON payout_run FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER payout_instruction_insert_guard BEFORE INSERT ON payout_instruction FOR EACH ROW EXECUTE FUNCTION rc_payout_instruction_insert_guard();
CREATE TRIGGER payout_instruction_guard BEFORE UPDATE ON payout_instruction FOR EACH ROW EXECUTE FUNCTION rc_payout_instruction_guard();
CREATE TRIGGER payout_instruction_no_delete BEFORE DELETE ON payout_instruction FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

GRANT SELECT, INSERT ON party_payout_profile, payout_run, payout_instruction TO rc_app;
GRANT UPDATE (tax_type, payout_account_ref, kyc_verified, updated_at, account_changed_at, account_changed_by) ON party_payout_profile TO rc_app;
GRANT UPDATE (status, provider_ref, settled_entry_id, submit_attempted_at, submit_unknown_at, submitted_account_ref) ON payout_instruction TO rc_app;
COMMENT ON COLUMN payout_instruction.settled_entry_id IS 'result entry: PAYOUT_SETTLED when PAID, PAYOUT_FAILED when FAILED';
GRANT SELECT ON payout_policy TO rc_app;

-- 지급 결과(통합 설계 11.2-7): provider_ref는 한 지시에만 속한다(webhook이 지시를 찾는 열).
CREATE UNIQUE INDEX payout_instruction_provider_ref ON payout_instruction (provider_ref) WHERE provider_ref IS NOT NULL;

-- PSP webhook inbox: 같은 provider_event_id는 한 번만 저장한다. 처리 시각(processed_at) NULL → 값 한 번만 바꿀 수 있다.
CREATE TABLE psp_webhook_inbox (
  provider_event_id TEXT PRIMARY KEY CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  provider_ref      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('PAID','FAILED')),
  payload           JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL CHECK (received_at = date_trunc('milliseconds', received_at)),
  processed_at      TIMESTAMPTZ NULL CHECK (processed_at = date_trunc('milliseconds', processed_at))
);
CREATE INDEX psp_webhook_inbox_unprocessed ON psp_webhook_inbox (provider_ref) WHERE processed_at IS NULL;

CREATE FUNCTION rc_psp_webhook_inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.processed_at IS NOT NULL THEN
    RAISE EXCEPTION 'psp_webhook_inbox %: already processed', OLD.provider_event_id USING ERRCODE = 'RC001';
  END IF;
  IF (to_jsonb(NEW) - 'processed_at') <> (to_jsonb(OLD) - 'processed_at') THEN
    RAISE EXCEPTION 'psp_webhook_inbox %: only processed_at may change', OLD.provider_event_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER psp_webhook_inbox_guard BEFORE UPDATE ON psp_webhook_inbox FOR EACH ROW EXECUTE FUNCTION rc_psp_webhook_inbox_guard();
CREATE TRIGGER psp_webhook_inbox_no_delete BEFORE DELETE ON psp_webhook_inbox FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON psp_webhook_inbox TO rc_app;
GRANT UPDATE (processed_at) ON psp_webhook_inbox TO rc_app;
