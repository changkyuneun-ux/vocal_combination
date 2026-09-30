-- 발행 봉인 격리(통합 설계 11.2-1): 엔진 진단으로 FAILED가 된 run의 발행 봉인. 해제되지 않은 격리가 있으면 배치가 그 봉인의 이벤트를
-- ENGINE_FAILED로 건너뛴다. 해제(released_by·released_at)는 NULL → 값 한 번만, 둘을 함께 쓴다. 해제 뒤 다시 실패하면 새 행이 생긴다
-- (그래서 봉인당 한 행이 아니라 "해제되지 않은 격리는 봉인당 하나"를 부분 UNIQUE로 강제한다).
CREATE TABLE quarantine (
  quarantine_id BIGSERIAL PRIMARY KEY,
  snapshot_id   vcrl_id NOT NULL REFERENCES issue_seal,
  reason        TEXT NOT NULL CHECK (length(reason) > 0),
  diagnostics   JSONB NOT NULL CHECK (jsonb_typeof(diagnostics) = 'array'),
  created_at    TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  released_by   vcrl_id NULL REFERENCES user_account,
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
ALTER TABLE settlement_batch_skip ADD CONSTRAINT settlement_batch_skip_reason_check
  CHECK (reason IN ('NO_ISSUE_SEAL','FACTS_DISPUTE_OPEN','FULLY_REFUNDED','ENGINE_FAILED'));
