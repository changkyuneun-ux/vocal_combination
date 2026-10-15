-- ⑧ 권리 파이프라인 관제(다음 작업 8). 발행 게이트 거부는 트랜잭션이 롤백돼 흔적이 남지 않으므로, 거부 사실만 별도 트랜잭션으로 남긴다.
CREATE TABLE issue_rejection (
  rejection_id BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL CHECK (occurred_at = date_trunc('milliseconds', occurred_at)),
  channel      TEXT NOT NULL,
  actor_user_id mdrl_id NOT NULL REFERENCES user_account,
  pack_id      TEXT NULL,
  vc_id        TEXT NULL,
  code         TEXT NOT NULL,
  diagnostics  JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX issue_rejection_time ON issue_rejection (occurred_at DESC);
CREATE TRIGGER issue_rejection_immutable BEFORE UPDATE OR DELETE ON issue_rejection FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
ALTER TABLE issue_rejection ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON issue_rejection USING (rc_sees_all());
GRANT SELECT, INSERT ON issue_rejection TO rc_app;
GRANT USAGE ON SEQUENCE issue_rejection_rejection_id_seq TO rc_app;
