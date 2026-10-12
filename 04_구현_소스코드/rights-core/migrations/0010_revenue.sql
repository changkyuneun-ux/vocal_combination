-- 역할·봉인 종류 확장(통합 설계 10.2-10). 제약 이름이 다르면 \d로 확인해 맞춘다.
ALTER TABLE portal_role DROP CONSTRAINT portal_role_role_check;
ALTER TABLE portal_role ADD CONSTRAINT portal_role_role_check
  CHECK (role IN ('RIGHTS_EDITOR','EDITOR','WORK_APPROVER','ACTIVATOR','ISSUER','SPACE_OPS','SPACE_SETTLE','SYSTEM'));
ALTER TABLE sealed_document DROP CONSTRAINT sealed_document_kind_check;
ALTER TABLE sealed_document ADD CONSTRAINT sealed_document_kind_check
  CHECK (kind IN ('facts','allocation','projection','members','events','allocation_result','reversal_result','public_facts','manifest'));

-- 수익 이벤트(v2.8 3.7 revenue_event의 I-2a 부분 집합). 환불도 양수이며 방향은 event_type이 나타낸다.
CREATE TABLE revenue_event (
  event_id         mdrl_id PRIMARY KEY,
  source_system    TEXT NOT NULL,
  source_event_id  TEXT NOT NULL,
  source_revision  INT NOT NULL DEFAULT 1 CHECK (source_revision >= 1),
  event_type       TEXT NOT NULL CHECK (event_type IN ('PURCHASE','RESALE','REFUND')),
  vc_id            mdrl_id NULL,
  related_event_id mdrl_id NULL REFERENCES revenue_event,
  net_amount_krw   BIGINT NOT NULL CHECK (net_amount_krw > 0),
  currency         CHAR(3) NOT NULL CHECK (currency = 'KRW'),
  integrity_status TEXT NOT NULL DEFAULT 'CLEAR' CHECK (integrity_status IN ('CLEAR','FLAGGED')),
  occurred_at      TIMESTAMPTZ NOT NULL CHECK (occurred_at = date_trunc('milliseconds', occurred_at)),
  recorded_at      TIMESTAMPTZ NOT NULL CHECK (recorded_at = date_trunc('milliseconds', recorded_at)),
  UNIQUE (source_system, source_event_id, source_revision),
  CHECK ((event_type = 'REFUND') = (related_event_id IS NOT NULL)),
  CHECK (event_type = 'REFUND' OR vc_id IS NOT NULL)
);
CREATE INDEX revenue_event_related ON revenue_event (related_event_id) WHERE related_event_id IS NOT NULL;
CREATE INDEX revenue_event_period ON revenue_event (occurred_at) WHERE event_type <> 'REFUND';
CREATE TRIGGER revenue_event_immutable BEFORE UPDATE OR DELETE ON revenue_event FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON revenue_event TO rc_app;
