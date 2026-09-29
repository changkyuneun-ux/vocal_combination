-- 분쟁·Outbox 시각은 Clock에서 온 밀리초 절사값만 저장한다(전역 제약).
ALTER TABLE dispute
  ADD CONSTRAINT dispute_opened_at_ms CHECK (opened_at = date_trunc('milliseconds', opened_at)),
  ADD CONSTRAINT dispute_closed_at_ms CHECK (closed_at = date_trunc('milliseconds', closed_at));
ALTER TABLE outbox
  ADD CONSTRAINT outbox_created_at_ms CHECK (created_at = date_trunc('milliseconds', created_at)),
  ADD CONSTRAINT outbox_processed_at_ms CHECK (processed_at = date_trunc('milliseconds', processed_at));
