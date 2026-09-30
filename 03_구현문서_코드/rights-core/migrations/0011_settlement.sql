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
  CHECK (status NOT IN ('VERIFIED','CONFIRMED') OR verified_by IS NOT NULL)
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

GRANT SELECT, INSERT ON settlement_batch, settlement_run, settlement_run_event, pool_line, allocation_line, unallocated_holding, settlement_batch_skip TO rc_app;
GRANT UPDATE (status, confirmed_by, confirmed_at, batch_manifest_digest) ON settlement_batch TO rc_app;
GRANT UPDATE (status, events_digest, result_digest, diagnostics, verified_by, verified_at) ON settlement_run TO rc_app;
GRANT UPDATE (active) ON settlement_run_event TO rc_app;
GRANT USAGE ON SEQUENCE allocation_line_line_id_seq, unallocated_holding_holding_id_seq TO rc_app;
