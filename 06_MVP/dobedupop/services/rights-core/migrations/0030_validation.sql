-- 정합성 검증(원천 문서 설계 S3a, 결정 D7·D8). 곡 단위로 문서·기록·동의를 함께 검사해 문제를 검증 이슈로 남기고, 고쳐질 때까지 추적한다.
-- 이슈는 다시 검사해 위반이 없으면 시스템이 RESOLVED로 닫는다(사람이 닫지 않는다). BLOCK은 정책·팩 활성화를 막고 위험 수용이 안 된다.
-- WARN은 기한(14일) 안에 고치거나 위험 수용(운영 요청 + 컴플라이언스 승인, 최대 30일, 연장 1번)할 수 있고, 기한이 지나면 BLOCK으로 오른다.

CREATE TABLE validation_issue (
  issue_id          BIGSERIAL PRIMARY KEY,
  rule_code         TEXT NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('BLOCK','WARN','INFO')),
  facts_scope_id    mdrl_id NOT NULL REFERENCES facts_scope,
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('SCOPE','DOCUMENT','RECORD','PARTY','CONSENT','VOICE')),
  subject_id        TEXT NOT NULL,
  related           JSONB NOT NULL DEFAULT '[]'::jsonb,
  message           TEXT NOT NULL,
  fix_hint          TEXT NOT NULL,
  due_at            TIMESTAMPTZ NULL CHECK (due_at = date_trunc('milliseconds', due_at)),
  -- OPEN → RESOLVED(재검사로 위반 없음) | ACCEPTED(WARN 위험 수용, accept_until까지) | DISMISSED(오탐, 컴플라이언스)
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','ACCEPTED','DISMISSED')),
  opened_at         TIMESTAMPTZ NOT NULL CHECK (opened_at = date_trunc('milliseconds', opened_at)),
  checked_at        TIMESTAMPTZ NOT NULL CHECK (checked_at = date_trunc('milliseconds', checked_at)),
  closed_at         TIMESTAMPTZ NULL CHECK (closed_at = date_trunc('milliseconds', closed_at)),
  accept_requested_by mdrl_id NULL REFERENCES user_account,
  accept_reason     TEXT NULL,
  accepted_by       mdrl_id NULL REFERENCES user_account,
  accept_until      TIMESTAMPTZ NULL CHECK (accept_until = date_trunc('milliseconds', accept_until)),
  accept_count      INT NOT NULL DEFAULT 0 CHECK (accept_count BETWEEN 0 AND 2),
  dismissed_by      mdrl_id NULL REFERENCES user_account,
  dismiss_reason    TEXT NULL,
  owner_tenant_id   mdrl_id NOT NULL REFERENCES tenant,
  CHECK ((status IN ('RESOLVED','DISMISSED')) = (closed_at IS NOT NULL)),
  CHECK (accepted_by IS NULL OR accepted_by <> accept_requested_by)
);
-- 같은 규칙·같은 대상의 살아 있는 이슈는 하나다(재검사가 갱신한다).
CREATE UNIQUE INDEX validation_issue_live ON validation_issue (facts_scope_id, rule_code, subject_type, subject_id) WHERE status IN ('OPEN','ACCEPTED');
CREATE INDEX validation_issue_open ON validation_issue (severity, due_at) WHERE status = 'OPEN';

ALTER TABLE validation_issue ENABLE ROW LEVEL SECURITY;
CREATE POLICY validation_read ON validation_issue FOR SELECT USING (rc_owns(owner_tenant_id));
CREATE POLICY validation_write ON validation_issue FOR INSERT WITH CHECK (rc_sees_all());
CREATE POLICY validation_update ON validation_issue FOR UPDATE USING (rc_sees_all()) WITH CHECK (rc_sees_all());
GRANT SELECT, INSERT ON validation_issue TO rc_app;
GRANT UPDATE (severity, related, message, fix_hint, due_at, status, checked_at, closed_at, accept_requested_by, accept_reason, accepted_by, accept_until, accept_count,
              dismissed_by, dismiss_reason) ON validation_issue TO rc_app;
GRANT USAGE ON SEQUENCE validation_issue_issue_id_seq TO rc_app;

-- 적용 범위: 테넌트마다 BLOCK 이슈가 활성화를 막을지(ENFORCE)를 정한다. 권리자 테넌트는 기본 적용.
-- 플랫폼이 대행 등록한 곡(플랫폼 소유)은 기본 경고만 남기고, 운영이 켤 수 있다.
ALTER TABLE tenant ADD COLUMN validation_enforced BOOLEAN NOT NULL DEFAULT true;
UPDATE tenant SET validation_enforced = false WHERE tenant_id = 'tnt_platform';
GRANT UPDATE (validation_enforced) ON tenant TO rc_app;

-- 위험 수용 승인 역할(결정 D8): 요청(운영) ≠ 승인(컴플라이언스).
ALTER TABLE portal_role DROP CONSTRAINT portal_role_role_check;
ALTER TABLE portal_role ADD CONSTRAINT portal_role_role_check
  CHECK (role IN ('RIGHTS_EDITOR','EDITOR','WORK_APPROVER','ACTIVATOR','ISSUER','SPACE_OPS','SPACE_SETTLE','SYSTEM','PERFORMER','COMPLIANCE'));
