-- 원천 문서 저장소(원천 문서 설계 S1). 계약서·동의서·위임장·증빙 원문을 버전으로 보관하고, 권리 주장·위임·동의가 근거 문서를 가리킨다.
-- 원문 파일은 문서 저장소(테넌트별 키로 암호화, 덮어쓰기 금지)에 두고 DB에는 해시·메타데이터만 둔다. 원문을 고치면 새 버전이다.
-- 근거를 연결하면 주장·위임의 evidence_digest(봉인되는 facts의 evidence)를 시스템이 근거 문서 해시로 채운다.

CREATE TABLE source_document (
  document_id     mdrl_id NOT NULL,
  version         INT NOT NULL CHECK (version >= 1),
  owner_tenant_id mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  kind            TEXT NOT NULL CHECK (kind IN ('MASTER_CONTRACT','PUBLISHING','PERFORMER_CONSENT','MANDATE','PLATFORM_CONTRACT','EVIDENCE')),
  title           TEXT NOT NULL CHECK (length(trim(title)) > 0),
  parties         TEXT[] NOT NULL DEFAULT '{}',
  effective_from  TIMESTAMPTZ NULL CHECK (effective_from = date_trunc('milliseconds', effective_from)),
  effective_to    TIMESTAMPTZ NULL CHECK (effective_to = date_trunc('milliseconds', effective_to)),
  file_sha256     TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size       BIGINT NOT NULL CHECK (byte_size > 0),
  mime            TEXT NOT NULL,
  storage_uri     TEXT NOT NULL,
  origin          TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (origin IN ('UPLOADED','TEMPLATE_SIGNED','IMPORTED')),
  -- UPLOADED → CONFIRMED(근거 확인, S3) | REJECTED(잘못 올림. 연결된 기록은 이전 digest를 그대로 가리킨다)
  status          TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED','CONFIRMED','REJECTED')),
  status_reason   TEXT NULL,
  -- OWNER: 소유 테넌트와 플랫폼만, PARTIES: 문서 당사자(파티의 테넌트·본인)도 본다
  confidentiality TEXT NOT NULL DEFAULT 'PARTIES' CHECK (confidentiality IN ('OWNER','PARTIES')),
  uploaded_by     mdrl_id NOT NULL REFERENCES user_account,
  uploaded_at     TIMESTAMPTZ NOT NULL CHECK (uploaded_at = date_trunc('milliseconds', uploaded_at)),
  -- 보관 기한(결정 D3): 효력 종료 후 10년. 지나면 원문만 폐기하고 해시·메타데이터·폐기 기록은 남긴다.
  retention_until TIMESTAMPTZ NULL,
  disposed_at     TIMESTAMPTZ NULL CHECK (disposed_at = date_trunc('milliseconds', disposed_at)),
  disposed_by     mdrl_id NULL REFERENCES user_account,
  PRIMARY KEY (document_id, version),
  UNIQUE (owner_tenant_id, file_sha256),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
  CHECK ((status = 'REJECTED') = (status_reason IS NOT NULL)),
  CHECK ((disposed_at IS NULL) = (disposed_by IS NULL))
);
CREATE INDEX source_document_parties ON source_document USING gin (parties);

-- 기록 ↔ 근거 문서(버전). 추가 전용. 주장·위임은 버전별로 연결한다(새 버전이 근거를 바꾸지 않으면 이전 연결을 이어받는다).
CREATE TABLE record_evidence (
  record_type      TEXT NOT NULL CHECK (record_type IN ('CLAIM','MANDATE','CONSENT')),
  record_id        mdrl_id NOT NULL,
  record_version   INT NOT NULL CHECK (record_version >= 0),
  document_id      mdrl_id NOT NULL,
  document_version INT NOT NULL,
  linked_by        mdrl_id NOT NULL REFERENCES user_account,
  linked_at        TIMESTAMPTZ NOT NULL CHECK (linked_at = date_trunc('milliseconds', linked_at)),
  PRIMARY KEY (record_type, record_id, record_version, document_id, document_version),
  FOREIGN KEY (document_id, document_version) REFERENCES source_document
);
CREATE INDEX record_evidence_document ON record_evidence (document_id, document_version);
CREATE TRIGGER record_evidence_immutable BEFORE UPDATE OR DELETE ON record_evidence FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

-- 위임 증빙(결정 D4): 주장과 같이 facts에 봉인된다. 동의는 근거 문서를 직접 가리킨다.
ALTER TABLE mandate ADD COLUMN evidence_digest TEXT NULL CHECK (evidence_digest ~ '^mdrl:sha256:[0-9a-f]{64}$');
ALTER TABLE consent_agreement ADD COLUMN source_document_id mdrl_id NULL;
ALTER TABLE consent_agreement ADD COLUMN source_document_version INT NULL;
ALTER TABLE consent_agreement ADD CONSTRAINT consent_source_document FOREIGN KEY (source_document_id, source_document_version) REFERENCES source_document;

-- 열람 기록 패널에 원천 문서를 더한다(플랫폼이 다른 테넌트의 원문을 열면 남는다).
ALTER TABLE inspection_audit_log DROP CONSTRAINT inspection_audit_log_panel_check;
ALTER TABLE inspection_audit_log ADD CONSTRAINT inspection_audit_log_panel_check CHECK (panel IN ('PARTY','RIGHTS_IMAGE','PACK','SETTLEMENT_TRACE','SOURCE_DOCUMENT'));

ALTER TABLE source_document ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_read ON source_document FOR SELECT USING (
  rc_owns(owner_tenant_id) OR (confidentiality = 'PARTIES' AND EXISTS (SELECT 1 FROM unnest(parties) p WHERE rc_party_visible(p))));
CREATE POLICY document_insert ON source_document FOR INSERT WITH CHECK (rc_can_write(owner_tenant_id));
CREATE POLICY document_update ON source_document FOR UPDATE USING (rc_owns(owner_tenant_id)) WITH CHECK (rc_can_write(owner_tenant_id) OR rc_sees_all());
ALTER TABLE record_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_read ON record_evidence FOR SELECT USING (
  rc_sees_all() OR EXISTS (SELECT 1 FROM source_document d WHERE d.document_id = record_evidence.document_id AND d.version = record_evidence.document_version));
CREATE POLICY evidence_insert ON record_evidence FOR INSERT WITH CHECK (
  rc_sees_all() OR EXISTS (SELECT 1 FROM source_document d WHERE d.document_id = record_evidence.document_id AND d.version = record_evidence.document_version));
GRANT SELECT, INSERT ON source_document, record_evidence TO rc_app;
GRANT UPDATE (status, status_reason, retention_until, disposed_at, disposed_by) ON source_document TO rc_app;
