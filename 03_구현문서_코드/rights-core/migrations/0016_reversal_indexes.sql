-- 역분개 행 조회 인덱스(통합 설계 11.4): REVERSAL 분개(postReversal)와 점검이 역분개 id로 풀 라인·배분 라인·보류를 읽는다.
-- 인덱스가 없으면 역분개마다 세 테이블을 순차 스캔해 3만 건 시나리오의 확정 후 역분개 처리가 약 3배 느려졌다(9.1초).
CREATE INDEX pool_line_reversal ON pool_line (reversal_id) WHERE reversal_id IS NOT NULL;
CREATE INDEX allocation_line_reversal ON allocation_line (reversal_id) WHERE reversal_id IS NOT NULL;
CREATE INDEX unallocated_holding_reversal ON unallocated_holding (reversal_id) WHERE reversal_id IS NOT NULL;
