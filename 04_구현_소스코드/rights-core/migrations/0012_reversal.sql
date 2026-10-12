-- 역분개 기록(통합 설계 10.2-9, 5.7 호출자 책임): 원 run·이벤트별 순번 유일, 환불 id 유일(멱등).
CREATE TABLE reversal_run (
  reversal_id     mdrl_id PRIMARY KEY,
  original_run_id mdrl_id NOT NULL REFERENCES settlement_run,
  event_id        mdrl_id NOT NULL REFERENCES revenue_event,
  sequence        INT NOT NULL CHECK (sequence >= 1),
  refund_event_id mdrl_id NOT NULL UNIQUE REFERENCES revenue_event,
  result_digest   TEXT NOT NULL REFERENCES sealed_document,
  created_at      TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  UNIQUE (original_run_id, event_id, sequence),
  CHECK (reversal_id <> original_run_id)
);
CREATE TRIGGER reversal_run_immutable BEFORE UPDATE OR DELETE ON reversal_run FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
ALTER TABLE pool_line ADD CONSTRAINT pool_line_reversal_fk FOREIGN KEY (reversal_id) REFERENCES reversal_run;
ALTER TABLE allocation_line ADD CONSTRAINT allocation_line_reversal_fk FOREIGN KEY (reversal_id) REFERENCES reversal_run;
ALTER TABLE unallocated_holding ADD CONSTRAINT unallocated_holding_reversal_fk FOREIGN KEY (reversal_id) REFERENCES reversal_run;
GRANT SELECT, INSERT ON reversal_run TO rc_app;

-- run 이벤트 순액에 포함된 환불 id(통합 설계 10.2-8): "이미 반영됨"은 합계가 아니라 id로 판단한다.
CREATE TABLE settlement_run_event_refund (
  run_id          mdrl_id NOT NULL,
  event_id        mdrl_id NOT NULL,
  refund_event_id mdrl_id NOT NULL REFERENCES revenue_event,
  PRIMARY KEY (run_id, event_id, refund_event_id),
  FOREIGN KEY (run_id, event_id) REFERENCES settlement_run_event
);
CREATE INDEX settlement_run_event_refund_refund ON settlement_run_event_refund (refund_event_id);
CREATE TRIGGER settlement_run_event_refund_immutable BEFORE UPDATE OR DELETE ON settlement_run_event_refund FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON settlement_run_event_refund TO rc_app;
