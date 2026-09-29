-- 재고정 필요 판정(팩 활성화·발행): 범위에서 정책의 facts 고정 이후에 종결된 분쟁을 찾는다.
CREATE INDEX dispute_scope_closed ON dispute (facts_scope_id, closed_at);
