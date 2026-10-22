-- 직무 분리 규칙(총괄 운영과 권한 구조 RS3, 결정 RD6). 현 단계는 운영을 고려한 직무 분리를 적용하지 않는다:
-- 서비스 검사는 이 표가 켜짐일 때만 거부하고, 같은 사람을 막던 DB CHECK는 뺀다. 역할을 나누는 단계에서 켜고 DB 이중 강제를 다시 넣는다.
-- 독립 검증(settlement_run.verified_by <> executed_by)은 시스템 무결성 장치라 이 목록 밖이고 그대로 둔다.
CREATE TABLE sod_rule (
  rule_id     TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  implemented BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO sod_rule (rule_id, description, implemented) VALUES
('policy.edit-approve-activate', '분배 규칙 편집 ≠ 승인 ≠ 활성화(1인 테넌트 표준 템플릿은 TD13 예외)', true),
('settlement.run-confirm', '정산 배치 생성(실행) ≠ 확정', true),
('contract-template.author-approve', '계약 템플릿 작성 ≠ 승인', true),
('policy-template.author-approve', '분배 규칙 템플릿 작성 ≠ 승인', true),
('validation.request-approve', '정합성 위험 수용 요청 ≠ 승인', true),
('link.propose-confirm', '연결 제안한 사람 ≠ 확인한 사람', true),
('payout.account-run', '지급 정보(계좌) 바꾼 사람 ≠ 지급 실행자(보류 사유 ACCOUNT_SOD)', true),
('monitor.observe-audit', '관제 담당 ≠ 감사 담당', false),
('integrity.investigate-judge', '조사자 ≠ 판정자', false);
GRANT SELECT ON sod_rule TO rc_app;

-- 같은 사람을 막던 CHECK 빼기. 이름은 자동으로 붙었으므로 정의로 찾는다.
DO $$
DECLARE c record; n int := 0;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS t, conname FROM pg_constraint
     WHERE contype = 'c' AND (
       (conrelid = 'settlement_batch'::regclass AND pg_get_constraintdef(oid) ~ 'confirmed_by.*<>.*executed_by')
    OR (conrelid = 'contract_template'::regclass AND pg_get_constraintdef(oid) ~ 'approved_by.*<>.*authored_by')
    OR (conrelid = 'policy_template'::regclass AND pg_get_constraintdef(oid) ~ 'approved_by.*<>.*authored_by')
    OR (conrelid = 'validation_issue'::regclass AND pg_get_constraintdef(oid) ~ 'accepted_by.*<>.*accept_requested_by'))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.t, c.conname);
    n := n + 1;
  END LOOP;
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 separation-of-duty checks, found %', n; END IF;
END $$;
-- 분배 규칙 템플릿의 승인 조건에서 "작성자와 다름"만 뺀다(승인자는 여전히 있어야 한다).
ALTER TABLE policy_template ADD CHECK (status <> 'APPROVED' OR seeded OR approved_by IS NOT NULL);
