-- 원곡 파트 담당 바로잡기(IR 생성 뒤 새 버전, 2026-10-23 시안 Song-Locked-FixPerf).
-- slot_part.original_party_id는 봉인(IR v1) 뒤 바뀌지 않는다(0043 CATALOG_SEALED). 바로잡기는 이 표에 새 버전으로 쌓는다:
--  - v1(slot_part 행)은 그대로 남는다. 지금 담당 = 이 표의 현재 버전(superseded_at IS NULL), 없으면 slot_part.original_party_id.
--  - 기록 시각은 sealed_through보다 늦어야 한다(봉인 울타리) → 다음 재고정부터 반영된다.
--  - 이미 발행된 조합의 몫은 발행 때 고정된 스템 배정(snapshot_stem_assignment)에서 오므로 그대로다.
--  - 바뀐 멤버들(새 담당·이전 담당)이 실연자 앱에서 확인한다(확인 요청 record_type 'PART'). 모두 확인하면 VERIFIED 새 버전.
CREATE TABLE part_assignment (
  assignment_id     mdrl_id NOT NULL,
  version           INT NOT NULL CHECK (version >= 1),
  facts_scope_id    mdrl_id NOT NULL REFERENCES facts_scope,
  slot_id           mdrl_id NOT NULL,
  part_no           INT NOT NULL,
  party_id          mdrl_id NOT NULL REFERENCES party,
  previous_party_id mdrl_id NOT NULL REFERENCES party,
  status            TEXT NOT NULL CHECK (status IN ('ASSERTED','VERIFIED','DISPUTED')),
  valid_from        TIMESTAMPTZ NOT NULL CHECK (valid_from = date_trunc('milliseconds', valid_from)),
  recorded_at       TIMESTAMPTZ NOT NULL CHECK (recorded_at = date_trunc('milliseconds', recorded_at)),
  superseded_at     TIMESTAMPTZ NULL CHECK (superseded_at = date_trunc('milliseconds', superseded_at)),
  recorded_by       mdrl_id NOT NULL REFERENCES user_account,
  evidence_document_id      mdrl_id NULL,
  evidence_document_version INT NULL,
  reason            TEXT NULL,
  owner_tenant_id   mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  PRIMARY KEY (assignment_id, version),
  FOREIGN KEY (slot_id, part_no) REFERENCES slot_part (slot_id, part_no),
  CHECK (party_id <> previous_party_id),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
);
CREATE UNIQUE INDEX part_assignment_current ON part_assignment (slot_id, part_no) WHERE superseded_at IS NULL;
CREATE INDEX part_assignment_scope ON part_assignment (facts_scope_id, recorded_at);
CREATE INDEX part_assignment_owner ON part_assignment (owner_tenant_id);
ALTER TABLE part_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_rw ON part_assignment USING (rc_owns(owner_tenant_id)) WITH CHECK (rc_can_write(owner_tenant_id));
GRANT SELECT, INSERT ON part_assignment TO rc_app;
GRANT UPDATE (superseded_at) ON part_assignment TO rc_app;

-- 지금 담당(봉인 뒤 바로잡기 반영): 준비·정합성 점검이 쓴다.
CREATE VIEW slot_part_current WITH (security_invoker = true) AS
SELECT p.slot_id, p.part_no, p.kind, p.role, p.start_ms, p.end_ms, p.duration_ms,
       COALESCE(a.party_id, p.original_party_id) AS original_party_id, p.created_at, p.owner_tenant_id
  FROM slot_part p LEFT JOIN part_assignment a ON a.slot_id = p.slot_id AND a.part_no = p.part_no AND a.superseded_at IS NULL AND a.status <> 'DISPUTED';
GRANT SELECT ON slot_part_current TO rc_app;

-- 확인 요청: 파트 담당 바로잡기는 상대가 둘(새 담당·이전 담당)이라 열린 요청은 (기록, 상대)마다 하나다.
ALTER TABLE confirmation_request DROP CONSTRAINT confirmation_request_record_type_check;
ALTER TABLE confirmation_request ADD CONSTRAINT confirmation_request_record_type_check CHECK (record_type IN ('CLAIM','MANDATE','PART'));
DROP INDEX confirmation_open_once;
CREATE UNIQUE INDEX confirmation_open_once ON confirmation_request (record_type, record_id, counterparty_id) WHERE status = 'OPEN';
