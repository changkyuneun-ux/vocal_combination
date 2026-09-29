-- facts 봉인 울타리(통합 설계 9.3-10): 봉인은 범위 행을 FOR UPDATE로 잠그고 sealed_through를 known_at 이상으로 올린다.
-- 범위에 쓰는 쪽은 같은 행을 FOR SHARE로 잠근 뒤 자기 시각이 sealed_through보다 늦어야 쓴다.
-- 그래서 known_at 이전 시각을 잡고 아직 커밋하지 않은 쓰기는 봉인을 기다리게 하거나(봉인이 그 행을 본다) 거부된다.
ALTER TABLE facts_scope
  ADD COLUMN sealed_through TIMESTAMPTZ NULL CONSTRAINT facts_scope_sealed_through_ms CHECK (sealed_through = date_trunc('milliseconds', sealed_through));
GRANT UPDATE (sealed_through) ON facts_scope TO rc_app;
