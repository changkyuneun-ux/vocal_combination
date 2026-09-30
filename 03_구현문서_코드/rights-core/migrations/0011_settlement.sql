-- 정산 배치(통합 설계 10.2-3·4). 상태는 OPEN/CONFIRMED, 진행 상황은 run 상태에서 계산한다.
CREATE TABLE settlement_batch (
  batch_id              vcrl_id PRIMARY KEY,
  period_start          TIMESTAMPTZ NOT NULL CHECK (period_start = date_trunc('milliseconds', period_start)),
  period_end            TIMESTAMPTZ NOT NULL CHECK (period_end = date_trunc('milliseconds', period_end)),
  status                TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED')),
  executed_by           vcrl_id NOT NULL REFERENCES user_account,
  created_at            TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  confirmed_by          vcrl_id NULL REFERENCES user_account,
  confirmed_at          TIMESTAMPTZ NULL CHECK (confirmed_at = date_trunc('milliseconds', confirmed_at)),
  batch_manifest_digest TEXT NULL REFERENCES sealed_document,
  CHECK (period_end > period_start),
  CHECK (confirmed_by IS NULL OR confirmed_by <> executed_by),
  CHECK ((status = 'CONFIRMED') = (confirmed_by IS NOT NULL AND batch_manifest_digest IS NOT NULL))
);

CREATE TABLE settlement_run (
  run_id            vcrl_id PRIMARY KEY,
  batch_id          vcrl_id NOT NULL REFERENCES settlement_batch,
  snapshot_id       vcrl_id NOT NULL REFERENCES issue_seal,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CALCULATED','VERIFIED','CONFIRMED','FAILED','VOIDED')),
  events_digest     TEXT NULL REFERENCES sealed_document,
  result_digest     TEXT NULL REFERENCES sealed_document,
  diagnostics       JSONB NULL,
  executed_by       vcrl_id NOT NULL DEFAULT 'sys_settler' REFERENCES user_account,
  verified_by       vcrl_id NULL REFERENCES user_account,
  verified_at       TIMESTAMPTZ NULL CHECK (verified_at = date_trunc('milliseconds', verified_at)),
  created_at        TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  UNIQUE (batch_id, snapshot_id),
  CHECK (verified_by IS NULL OR verified_by <> executed_by),
  CHECK (status NOT IN ('CALCULATED','VERIFIED','CONFIRMED') OR (events_digest IS NOT NULL AND result_digest IS NOT NULL)),
  CHECK (status NOT IN ('VERIFIED','CONFIRMED') OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX settlement_run_batch ON settlement_run (batch_id, status);

-- run에 고정된 이벤트 순액(원 금액 − 포함한 환불). active는 run이 FAILED·VOIDED가 되면 false.
CREATE TABLE settlement_run_event (
  run_id               vcrl_id NOT NULL REFERENCES settlement_run,
  event_id             vcrl_id NOT NULL REFERENCES revenue_event,
  net_amount_krw       BIGINT NOT NULL CHECK (net_amount_krw > 0),
  refunds_included_krw BIGINT NOT NULL CHECK (refunds_included_krw >= 0),
  active               BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (run_id, event_id)
);
CREATE UNIQUE INDEX run_event_once ON settlement_run_event (event_id) WHERE active;

-- 결과 라인(원 결과 line_seq = 1, 역분개 = sequence + 1). run_id는 항상 원 run.
CREATE TABLE pool_line (
  run_id      vcrl_id NOT NULL REFERENCES settlement_run,
  event_id    vcrl_id NOT NULL REFERENCES revenue_event,
  bucket      TEXT NOT NULL,
  line_seq    INT NOT NULL CHECK (line_seq >= 1),
  amount_krw  BIGINT NOT NULL,
  reversal_id vcrl_id NULL,
  PRIMARY KEY (run_id, event_id, bucket, line_seq),
  CHECK ((line_seq = 1) = (reversal_id IS NULL))
);
CREATE TABLE allocation_line (
  line_id             BIGSERIAL PRIMARY KEY,
  run_id              vcrl_id NOT NULL REFERENCES settlement_run,
  event_id            vcrl_id NOT NULL REFERENCES revenue_event,
  party_id            vcrl_id NOT NULL REFERENCES party,
  role                TEXT NOT NULL,
  bucket              TEXT NOT NULL,
  line_seq            INT NOT NULL CHECK (line_seq >= 1),
  line_kind           TEXT NOT NULL CHECK (line_kind IN ('SETTLE','REVERSAL')),
  amount_krw          BIGINT NOT NULL,
  reversal_of_line_id BIGINT NULL REFERENCES allocation_line,
  reversal_id         vcrl_id NULL,
  UNIQUE (run_id, event_id, party_id, role, bucket, line_seq),
  CHECK ((line_kind = 'SETTLE') = (line_seq = 1)),
  CHECK ((line_kind = 'REVERSAL') = (reversal_of_line_id IS NOT NULL AND reversal_id IS NOT NULL)),
  CHECK ((line_kind = 'SETTLE' AND amount_krw > 0) OR (line_kind = 'REVERSAL' AND amount_krw < 0))
);
CREATE TABLE unallocated_holding (
  holding_id  BIGSERIAL PRIMARY KEY,
  run_id      vcrl_id NOT NULL REFERENCES settlement_run,
  event_id    vcrl_id NOT NULL REFERENCES revenue_event,
  bucket      TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('RIGHTS_DISPUTE','FRAUD_REVIEW')),
  line_seq    INT NOT NULL CHECK (line_seq >= 1),
  amount_krw  BIGINT NOT NULL,
  reversal_id vcrl_id NULL,
  status      TEXT NOT NULL DEFAULT 'HELD' CHECK (status = 'HELD'),
  UNIQUE (run_id, event_id, bucket, reason, line_seq),
  CHECK ((line_seq = 1) = (reversal_id IS NULL))
);

CREATE TABLE settlement_batch_skip (
  batch_id vcrl_id NOT NULL REFERENCES settlement_batch,
  event_id vcrl_id NOT NULL REFERENCES revenue_event,
  reason   TEXT NOT NULL CHECK (reason IN ('NO_ISSUE_SEAL','FACTS_DISPUTE_OPEN','FULLY_REFUNDED')),
  PRIMARY KEY (batch_id, event_id)
);

CREATE TRIGGER pool_line_immutable BEFORE UPDATE OR DELETE ON pool_line FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER allocation_line_immutable BEFORE UPDATE OR DELETE ON allocation_line FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER unallocated_holding_immutable BEFORE UPDATE OR DELETE ON unallocated_holding FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER settlement_batch_skip_immutable BEFORE UPDATE OR DELETE ON settlement_batch_skip FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

-- 상태 전이 가드. 위반은 RC001(추가 전용 규칙과 같은 409 APPEND_ONLY)로 거부한다.
-- 배치: OPEN → CONFIRMED 한 번. 확정 필드는 NULL → 값 한 번만. 그 밖의 열은 바꾸지 않는다.
CREATE FUNCTION rc_settlement_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR OLD.status = 'CONFIRMED' THEN
    IF NOT (OLD.status = 'OPEN' AND NEW.status = 'CONFIRMED') THEN
      RAISE EXCEPTION 'settlement_batch %: status % -> % rejected', OLD.batch_id, OLD.status, NEW.status USING ERRCODE = 'RC001';
    END IF;
  END IF;
  IF (OLD.confirmed_by IS NOT NULL AND NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by)
     OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
     OR (OLD.batch_manifest_digest IS NOT NULL AND NEW.batch_manifest_digest IS DISTINCT FROM OLD.batch_manifest_digest) THEN
    RAISE EXCEPTION 'settlement_batch %: confirmation fields are write-once', OLD.batch_id USING ERRCODE = 'RC001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','confirmed_by','confirmed_at','batch_manifest_digest'])
     <> (to_jsonb(OLD) - ARRAY['status','confirmed_by','confirmed_at','batch_manifest_digest']) THEN
    RAISE EXCEPTION 'settlement_batch %: only status and confirmation fields may change', OLD.batch_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- run: PENDING → CALCULATED|FAILED|VOIDED, CALCULATED → VERIFIED|VOIDED, VERIFIED → CONFIRMED|VOIDED.
-- CONFIRMED·FAILED·VOIDED는 끝 상태. digest·검증자·검증 시각은 NULL → 값 한 번만.
-- diagnostics는 FAILED·VOIDED로 전이하는 같은 UPDATE에서만 쓸 수 있다.
CREATE FUNCTION rc_settlement_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('CALCULATED','FAILED','VOIDED'))
    OR (OLD.status = 'CALCULATED' AND NEW.status IN ('VERIFIED','VOIDED'))
    OR (OLD.status = 'VERIFIED' AND NEW.status IN ('CONFIRMED','VOIDED'))) THEN
    RAISE EXCEPTION 'settlement_run %: status % -> % rejected', OLD.run_id, OLD.status, NEW.status USING ERRCODE = 'RC001';
  END IF;
  IF (OLD.events_digest IS NOT NULL AND NEW.events_digest IS DISTINCT FROM OLD.events_digest)
     OR (OLD.result_digest IS NOT NULL AND NEW.result_digest IS DISTINCT FROM OLD.result_digest)
     OR (OLD.verified_by IS NOT NULL AND NEW.verified_by IS DISTINCT FROM OLD.verified_by)
     OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    RAISE EXCEPTION 'settlement_run %: digests and verification fields are write-once', OLD.run_id USING ERRCODE = 'RC001';
  END IF;
  IF NEW.diagnostics IS DISTINCT FROM OLD.diagnostics
     AND NOT (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('FAILED','VOIDED')) THEN
    RAISE EXCEPTION 'settlement_run %: diagnostics may only be set with a transition to FAILED or VOIDED', OLD.run_id USING ERRCODE = 'RC001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','events_digest','result_digest','diagnostics','verified_by','verified_at'])
     <> (to_jsonb(OLD) - ARRAY['status','events_digest','result_digest','diagnostics','verified_by','verified_at']) THEN
    RAISE EXCEPTION 'settlement_run %: identity columns are immutable', OLD.run_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- run_event: active는 true → false 한 번만, 그리고 부모 run이 (이 UPDATE 시점에) FAILED·VOIDED일 때만.
-- 순서 주의: run을 무효화하고 이벤트를 풀어 주는 코드는 run을 먼저 VOIDED(또는 FAILED)로 UPDATE한 뒤 이벤트를 푼다.
CREATE FUNCTION rc_settlement_run_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status TEXT;
BEGIN
  IF (to_jsonb(NEW) - 'active') <> (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'settlement_run_event %/%: only active may change', OLD.run_id, OLD.event_id USING ERRCODE = 'RC001';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    IF NOT (OLD.active AND NOT NEW.active) THEN
      RAISE EXCEPTION 'settlement_run_event %/%: active may only go true -> false', OLD.run_id, OLD.event_id USING ERRCODE = 'RC001';
    END IF;
    SELECT status INTO run_status FROM settlement_run WHERE run_id = OLD.run_id;
    IF run_status NOT IN ('FAILED','VOIDED') THEN
      RAISE EXCEPTION 'settlement_run_event %/%: run is %, release requires FAILED or VOIDED', OLD.run_id, OLD.event_id, run_status USING ERRCODE = 'RC001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER settlement_batch_guard BEFORE UPDATE ON settlement_batch FOR EACH ROW EXECUTE FUNCTION rc_settlement_batch_guard();
CREATE TRIGGER settlement_run_guard BEFORE UPDATE ON settlement_run FOR EACH ROW EXECUTE FUNCTION rc_settlement_run_guard();
CREATE TRIGGER settlement_run_event_guard BEFORE UPDATE ON settlement_run_event FOR EACH ROW EXECUTE FUNCTION rc_settlement_run_event_guard();
-- 배치·run·run_event는 지우지 않는다.
CREATE TRIGGER settlement_batch_no_delete BEFORE DELETE ON settlement_batch FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER settlement_run_no_delete BEFORE DELETE ON settlement_run FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER settlement_run_event_no_delete BEFORE DELETE ON settlement_run_event FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

GRANT SELECT, INSERT ON settlement_batch, settlement_run, settlement_run_event, pool_line, allocation_line, unallocated_holding, settlement_batch_skip TO rc_app;
GRANT UPDATE (status, confirmed_by, confirmed_at, batch_manifest_digest) ON settlement_batch TO rc_app;
GRANT UPDATE (status, events_digest, result_digest, diagnostics, verified_by, verified_at) ON settlement_run TO rc_app;
GRANT UPDATE (active) ON settlement_run_event TO rc_app;
GRANT USAGE ON SEQUENCE allocation_line_line_id_seq, unallocated_holding_holding_id_seq TO rc_app;
