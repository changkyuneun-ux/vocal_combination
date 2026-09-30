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
