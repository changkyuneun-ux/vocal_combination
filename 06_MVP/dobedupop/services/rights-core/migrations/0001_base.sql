-- MDRL id 규칙(코어 규격 3절): 영숫자·점·밑줄·하이픈, __proto__ 금지.
CREATE DOMAIN mdrl_id AS TEXT CHECK (VALUE ~ '^[A-Za-z0-9._-]+$' AND VALUE <> '__proto__');

-- 불변 테이블: UPDATE·DELETE 거부.
CREATE FUNCTION rc_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'RC001';
END $$;

-- 이중 시간축 테이블: DELETE 거부, UPDATE는 superseded_at을 NULL에서 값으로 한 번 설정하는 것만 허용.
CREATE FUNCTION rc_allow_supersede_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append-only table %: DELETE rejected', TG_TABLE_NAME USING ERRCODE = 'RC001';
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (to_jsonb(NEW) - 'superseded_at') <> (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'append-only table %: only a single superseded_at set is allowed', TG_TABLE_NAME USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- PoC 감사 로그(v2.8 audit_log의 부분 집합, audit_id는 BIGSERIAL).
CREATE TABLE audit_log (
  audit_id      BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL,
  actor_user_id TEXT NOT NULL,
  action_name   VARCHAR(64) NOT NULL,
  entity_type   VARCHAR(64) NOT NULL,
  entity_id     TEXT NOT NULL,
  after_json    JSONB NULL
);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

-- 트랜잭션 Outbox.
CREATE TABLE outbox (
  outbox_id    BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ NULL
);
CREATE INDEX outbox_pending ON outbox (outbox_id) WHERE processed_at IS NULL;

GRANT SELECT, INSERT ON audit_log, outbox TO rc_app;
GRANT UPDATE (processed_at) ON outbox TO rc_app;
GRANT USAGE ON SEQUENCE audit_log_audit_id_seq, outbox_outbox_id_seq TO rc_app;
