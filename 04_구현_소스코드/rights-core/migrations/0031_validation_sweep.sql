-- 연관성 재검사(원천 문서 설계 S3b). 곡마다 마지막 검사 시각을 남겨, 정기 검사가 오래된 곡과
-- 기한·만료가 지난 곡만 다시 검사한다. 문서 개정·거부·폐기는 그 문서가 닿는 곡을 바로 다시 검사한다.
CREATE TABLE validation_check (
  facts_scope_id  mdrl_id PRIMARY KEY REFERENCES facts_scope,
  checked_at      TIMESTAMPTZ NOT NULL CHECK (checked_at = date_trunc('milliseconds', checked_at)),
  owner_tenant_id mdrl_id NOT NULL REFERENCES tenant
);
ALTER TABLE validation_check ENABLE ROW LEVEL SECURITY;
CREATE POLICY validation_check_read ON validation_check FOR SELECT USING (rc_owns(owner_tenant_id));
CREATE POLICY validation_check_write ON validation_check FOR INSERT WITH CHECK (rc_sees_all());
CREATE POLICY validation_check_update ON validation_check FOR UPDATE USING (rc_sees_all()) WITH CHECK (rc_sees_all());
GRANT SELECT, INSERT ON validation_check TO rc_app;
GRANT UPDATE (checked_at) ON validation_check TO rc_app;
