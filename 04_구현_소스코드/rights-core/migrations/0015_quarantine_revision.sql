-- 발행 봉인 격리(통합 설계 11.2-1): 엔진 진단으로 FAILED가 된 run의 발행 봉인. 해제되지 않은 격리가 있으면 배치가 그 봉인의 이벤트를
-- ENGINE_FAILED로 건너뛴다. 해제(released_by·released_at)는 NULL → 값 한 번만, 둘을 함께 쓴다. 해제 뒤 다시 실패하면 새 행이 생긴다
-- (그래서 봉인당 한 행이 아니라 "해제되지 않은 격리는 봉인당 하나"를 부분 UNIQUE로 강제한다).
CREATE TABLE quarantine (
  quarantine_id BIGSERIAL PRIMARY KEY,
  snapshot_id   mdrl_id NOT NULL REFERENCES issue_seal,
  reason        TEXT NOT NULL CHECK (length(reason) > 0),
  diagnostics   JSONB NOT NULL CHECK (jsonb_typeof(diagnostics) = 'array'),
  created_at    TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  released_by   mdrl_id NULL REFERENCES user_account,
  released_at   TIMESTAMPTZ NULL CHECK (released_at = date_trunc('milliseconds', released_at)),
  CHECK ((released_by IS NULL) = (released_at IS NULL))
);
CREATE UNIQUE INDEX quarantine_active ON quarantine (snapshot_id) WHERE released_at IS NULL;

CREATE FUNCTION rc_quarantine_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_by IS NOT NULL OR OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'quarantine %: already released', OLD.quarantine_id USING ERRCODE = 'RC001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['released_by','released_at']) <> (to_jsonb(OLD) - ARRAY['released_by','released_at']) THEN
    RAISE EXCEPTION 'quarantine %: only released_by and released_at may change', OLD.quarantine_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quarantine_guard BEFORE UPDATE ON quarantine FOR EACH ROW EXECUTE FUNCTION rc_quarantine_guard();
CREATE TRIGGER quarantine_no_delete BEFORE DELETE ON quarantine FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON quarantine TO rc_app;
GRANT UPDATE (released_by, released_at) ON quarantine TO rc_app;
GRANT USAGE ON SEQUENCE quarantine_quarantine_id_seq TO rc_app;

ALTER TABLE settlement_batch_skip DROP CONSTRAINT settlement_batch_skip_reason_check;
-- REVISION_PENDING(11.2-11): 새 revision의 이전 revision이 확정 전 run에 살아 있거나, 확정 run에 있는데 CORRECTION 역분개가 아직 없다.
ALTER TABLE settlement_batch_skip ADD CONSTRAINT settlement_batch_skip_reason_check
  CHECK (reason IN ('NO_ISSUE_SEAL','FACTS_DISPUTE_OPEN','FULLY_REFUNDED','ENGINE_FAILED','REVISION_PENDING'));

-- INSERT 경로 가드(통합 설계 11.2-12, 0011 UPDATE 가드의 짝). 위반은 RC001.
-- 배치는 OPEN으로만 생긴다.
CREATE FUNCTION rc_settlement_batch_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'settlement_batch %: must be inserted as OPEN, not %', NEW.batch_id, NEW.status USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- run은 PENDING·digest·검증·진단이 모두 비어 있는 상태로, OPEN 배치에만 생긴다.
-- 배치 행을 FOR SHARE로 잠가 동시에 확정(confirmBatch는 배치를 FOR UPDATE로 잠근다)되는 배치에 run이 끼어들지 못하게 한다.
CREATE FUNCTION rc_settlement_run_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_status TEXT;
BEGIN
  IF NEW.status <> 'PENDING' OR NEW.events_digest IS NOT NULL OR NEW.result_digest IS NOT NULL
     OR NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL OR NEW.diagnostics IS NOT NULL THEN
    RAISE EXCEPTION 'settlement_run %: must be inserted as PENDING without digests, verification or diagnostics', NEW.run_id USING ERRCODE = 'RC001';
  END IF;
  SELECT status INTO batch_status FROM settlement_batch WHERE batch_id = NEW.batch_id FOR SHARE;
  IF batch_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'settlement_run %: batch % is %, runs are added only to OPEN batches', NEW.run_id, NEW.batch_id, batch_status USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- run 이벤트는 run이 PENDING일 때만 생긴다(run 행을 FOR SHARE로 잠가 동시 전이와 직렬화한다).
CREATE FUNCTION rc_settlement_run_event_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status TEXT;
BEGIN
  SELECT status INTO run_status FROM settlement_run WHERE run_id = NEW.run_id FOR SHARE;
  IF run_status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'settlement_run_event %/%: run is %, events are added only to PENDING runs', NEW.run_id, NEW.event_id, run_status USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- 결과 라인·보류(pool_line·allocation_line·unallocated_holding): line_seq = 1(원 결과)은 run이 PENDING일 때만(settle-run이 CALCULATED로
-- 바꾸기 전에 쓴다), line_seq > 1(역분개)은 run이 CONFIRMED일 때만. CONFIRMED는 끝 상태라 잠그지 않고, PENDING은 FOR SHARE로 잠근다
-- (settle-run은 이미 FOR UPDATE로 잠갔으므로 같은 트랜잭션에서는 추가 비용이 없다).
CREATE FUNCTION rc_settlement_line_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status TEXT;
BEGIN
  IF NEW.line_seq = 1 THEN
    SELECT status INTO run_status FROM settlement_run WHERE run_id = NEW.run_id FOR SHARE;
    IF run_status IS DISTINCT FROM 'PENDING' THEN
      RAISE EXCEPTION '%: run % is %, line_seq = 1 rows are written only while PENDING', TG_TABLE_NAME, NEW.run_id, run_status USING ERRCODE = 'RC001';
    END IF;
  ELSE
    SELECT status INTO run_status FROM settlement_run WHERE run_id = NEW.run_id;
    IF run_status IS DISTINCT FROM 'CONFIRMED' THEN
      RAISE EXCEPTION '%: run % is %, reversal rows (line_seq > 1) are written only for CONFIRMED runs', TG_TABLE_NAME, NEW.run_id, run_status USING ERRCODE = 'RC001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER settlement_batch_insert_guard BEFORE INSERT ON settlement_batch FOR EACH ROW EXECUTE FUNCTION rc_settlement_batch_insert_guard();
CREATE TRIGGER settlement_run_insert_guard BEFORE INSERT ON settlement_run FOR EACH ROW EXECUTE FUNCTION rc_settlement_run_insert_guard();
CREATE TRIGGER settlement_run_event_insert_guard BEFORE INSERT ON settlement_run_event FOR EACH ROW EXECUTE FUNCTION rc_settlement_run_event_insert_guard();
CREATE TRIGGER pool_line_insert_guard BEFORE INSERT ON pool_line FOR EACH ROW EXECUTE FUNCTION rc_settlement_line_insert_guard();
CREATE TRIGGER allocation_line_insert_guard BEFORE INSERT ON allocation_line FOR EACH ROW EXECUTE FUNCTION rc_settlement_line_insert_guard();
CREATE TRIGGER unallocated_holding_insert_guard BEFORE INSERT ON unallocated_holding FOR EACH ROW EXECUTE FUNCTION rc_settlement_line_insert_guard();

-- source_revision 대체(통합 설계 11.2-11): 같은 source 이벤트의 더 높은 revision이 이전 최신 revision을 대체한다. 불변.
-- 이전 이벤트는 한 번만 대체되고(PK), 새 이벤트는 하나만 대체한다(UNIQUE). 대체된 이벤트는 배치 후보에서 빠지고 환불을 받지 않는다.
CREATE TABLE revenue_supersede (
  old_event_id mdrl_id PRIMARY KEY REFERENCES revenue_event,
  new_event_id mdrl_id NOT NULL UNIQUE REFERENCES revenue_event,
  recorded_at  TIMESTAMPTZ NOT NULL CHECK (recorded_at = date_trunc('milliseconds', recorded_at)),
  CHECK (old_event_id <> new_event_id)
);
CREATE TRIGGER revenue_supersede_immutable BEFORE UPDATE OR DELETE ON revenue_supersede FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON revenue_supersede TO rc_app;
