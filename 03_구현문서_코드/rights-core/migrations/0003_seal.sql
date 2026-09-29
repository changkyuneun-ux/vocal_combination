-- 봉인 저장소(v2.8 3.11 sealed_document): 내용 주소, 불변. 원문 JCS 바이트는 blob, 64KiB 이하는 JSONB 사본도 둔다.
CREATE TABLE sealed_document (
  digest      TEXT PRIMARY KEY CHECK (digest ~ '^vcrl:sha256:[0-9a-f]{64}$'),
  kind        TEXT NOT NULL CHECK (kind IN ('facts','allocation','projection','members','events','allocation_result','public_facts','manifest')),
  doc_id      TEXT NULL,
  doc_version TEXT NULL,
  format      TEXT NULL,
  byte_size   BIGINT NOT NULL,
  storage_uri TEXT NOT NULL,
  content     JSONB NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sealed_document_doc ON sealed_document (kind, doc_id, doc_version);
CREATE TRIGGER sealed_document_immutable BEFORE UPDATE OR DELETE ON sealed_document FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON sealed_document TO rc_app;
