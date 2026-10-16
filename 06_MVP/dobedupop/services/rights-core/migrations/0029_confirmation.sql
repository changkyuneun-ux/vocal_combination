-- 근거 연결과 상대 당사자 확인(원천 문서 설계 S3, 결정 D5).
-- 조항: 원천 문서 안의 근거 위치(쪽·인용). 기록은 문서뿐 아니라 그 안의 조항을 근거로 가리킬 수 있다.
-- 확인: 돈의 흐름을 바꾸는 기록(지분·권리자 지정·위임)은 상대 당사자가 확인해야 VERIFIED가 된다. 확인 요청은 기한(14일)을 두고,
-- 상대가 플랫폼 밖이면 기한 뒤 플랫폼이 원문을 대조해 확인할 수 있다. 상대가 거절하면 분쟁이 열린다.

CREATE TABLE document_clause (
  clause_id        mdrl_id PRIMARY KEY,
  document_id      mdrl_id NOT NULL,
  document_version INT NOT NULL,
  page             INT NULL CHECK (page IS NULL OR page >= 1),
  quote            TEXT NOT NULL CHECK (length(trim(quote)) > 0),
  clause_type      TEXT NOT NULL CHECK (clause_type IN ('SHARE','RIGHT_HOLDER','MANDATE','SCOPE','PERIOD','SPLIT_RATE','OTHER')),
  note             TEXT NULL,
  marked_by        mdrl_id NOT NULL REFERENCES user_account,
  marked_at        TIMESTAMPTZ NOT NULL CHECK (marked_at = date_trunc('milliseconds', marked_at)),
  FOREIGN KEY (document_id, document_version) REFERENCES source_document
);
CREATE INDEX document_clause_document ON document_clause (document_id, document_version);
CREATE TRIGGER document_clause_immutable BEFORE UPDATE OR DELETE ON document_clause FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

CREATE TABLE record_clause (
  record_type    TEXT NOT NULL CHECK (record_type IN ('CLAIM','MANDATE','CONSENT')),
  record_id      mdrl_id NOT NULL,
  record_version INT NOT NULL CHECK (record_version >= 0),
  clause_id      mdrl_id NOT NULL REFERENCES document_clause,
  linked_by      mdrl_id NOT NULL REFERENCES user_account,
  linked_at      TIMESTAMPTZ NOT NULL CHECK (linked_at = date_trunc('milliseconds', linked_at)),
  PRIMARY KEY (record_type, record_id, record_version, clause_id)
);
CREATE TRIGGER record_clause_immutable BEFORE UPDATE OR DELETE ON record_clause FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

CREATE TABLE confirmation_request (
  request_id       BIGSERIAL PRIMARY KEY,
  record_type      TEXT NOT NULL CHECK (record_type IN ('CLAIM','MANDATE')),
  record_id        mdrl_id NOT NULL,
  record_version   INT NOT NULL CHECK (record_version >= 1),
  facts_scope_id   mdrl_id NOT NULL REFERENCES facts_scope,
  counterparty_id  mdrl_id NOT NULL REFERENCES party,
  requested_by     mdrl_id NOT NULL REFERENCES user_account,
  requested_at     TIMESTAMPTZ NOT NULL CHECK (requested_at = date_trunc('milliseconds', requested_at)),
  due_at           TIMESTAMPTZ NOT NULL CHECK (due_at = date_trunc('milliseconds', due_at)),
  -- OPEN → CONFIRMED(상대 확인) | DECLINED(상대 거절 → 분쟁) | PLATFORM_VERIFIED(기한 뒤 플랫폼 대조) | SUPERSEDED(기록이 다른 이유로 새 버전이 됨)
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','DECLINED','PLATFORM_VERIFIED','SUPERSEDED')),
  decided_by       mdrl_id NULL REFERENCES user_account,
  decided_at       TIMESTAMPTZ NULL CHECK (decided_at = date_trunc('milliseconds', decided_at)),
  reason           TEXT NULL,
  dispute_id       mdrl_id NULL,
  owner_tenant_id  mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  CHECK ((status = 'OPEN') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX confirmation_open_once ON confirmation_request (record_type, record_id) WHERE status = 'OPEN';
CREATE INDEX confirmation_counterparty ON confirmation_request (counterparty_id) WHERE status = 'OPEN';

-- 읽기: 요청한 쪽(곡 소유 테넌트), 상대 당사자(파티의 테넌트·본인), 플랫폼. 쓰기는 같은 범위에서 하고 권한은 서비스가 정한다.
ALTER TABLE document_clause ENABLE ROW LEVEL SECURITY;
CREATE POLICY clause_rw ON document_clause USING (EXISTS (SELECT 1 FROM source_document d WHERE d.document_id = document_clause.document_id AND d.version = document_clause.document_version))
  WITH CHECK (EXISTS (SELECT 1 FROM source_document d WHERE d.document_id = document_clause.document_id AND d.version = document_clause.document_version));
ALTER TABLE record_clause ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_clause_rw ON record_clause USING (rc_sees_all() OR EXISTS (SELECT 1 FROM document_clause c WHERE c.clause_id = record_clause.clause_id))
  WITH CHECK (rc_sees_all() OR EXISTS (SELECT 1 FROM document_clause c WHERE c.clause_id = record_clause.clause_id));
ALTER TABLE confirmation_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY confirmation_read ON confirmation_request FOR SELECT USING (rc_owns(owner_tenant_id) OR rc_party_visible(counterparty_id));
CREATE POLICY confirmation_insert ON confirmation_request FOR INSERT WITH CHECK (rc_can_write(owner_tenant_id));
CREATE POLICY confirmation_update ON confirmation_request FOR UPDATE USING (rc_owns(owner_tenant_id) OR rc_party_visible(counterparty_id))
  WITH CHECK (rc_owns(owner_tenant_id) OR rc_party_visible(counterparty_id));
GRANT SELECT, INSERT ON document_clause, record_clause, confirmation_request TO rc_app;
GRANT UPDATE (status, decided_by, decided_at, reason, dispute_id) ON confirmation_request TO rc_app;
GRANT USAGE ON SEQUENCE confirmation_request_request_id_seq TO rc_app;

ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN ('USAGE','CONSENT','PAYOUT','OBJECTION','IDENTITY','CONFIRMATION'));
