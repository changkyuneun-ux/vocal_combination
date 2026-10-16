-- 감상 매출(다음 작업 13). 팬 앱이 조합 재생을 보고하고(play_event), 기간의 구독·광고 수익(traffic_pool)을 조합별 유효 재생 비중으로 나눠
-- 조합마다 TRAFFIC 매출 이벤트를 만든다. 그 뒤는 구매 매출과 같은 정산 경로(배치 → run → 원장)를 탄다.

ALTER TABLE revenue_event DROP CONSTRAINT revenue_event_event_type_check;
ALTER TABLE revenue_event ADD CONSTRAINT revenue_event_event_type_check CHECK (event_type IN ('PURCHASE','RESALE','TRAFFIC','REFUND'));

-- 재생 기록. play_id는 앱이 만들어 재전송해도 한 번만 남는다. 재생 시각은 코어 시계로 적는다(단말 시계를 믿지 않는다).
-- counted: 유효 재생(30초 이상). integrity: 같은 사용자·같은 조합의 하루 유효 재생이 한도를 넘으면 FLAGGED(배정에서 뺀다).
CREATE TABLE play_event (
  play_id      mdrl_id PRIMARY KEY,
  vc_id        mdrl_id NOT NULL,
  user_id      mdrl_id NOT NULL REFERENCES user_account,
  source       TEXT NOT NULL,
  duration_ms  INT NOT NULL CHECK (duration_ms >= 0),
  counted      BOOLEAN NOT NULL,
  integrity    TEXT NOT NULL CHECK (integrity IN ('CLEAR','FLAGGED')),
  played_at    TIMESTAMPTZ NOT NULL CHECK (played_at = date_trunc('milliseconds', played_at))
);
CREATE INDEX play_event_period ON play_event (played_at) WHERE counted AND integrity = 'CLEAR';
CREATE INDEX play_event_user_day ON play_event (user_id, vc_id, played_at);
CREATE TRIGGER play_event_immutable BEFORE UPDATE OR DELETE ON play_event FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

-- 기간 수익 풀: 구독 또는 광고 수익의 한 기간치. 배정은 한 번만 한다(ALLOCATED, 유효 재생이 없으면 NO_PLAYS).
CREATE TABLE traffic_pool (
  pool_id      mdrl_id PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('SUBSCRIPTION','AD')),
  period_start TIMESTAMPTZ NOT NULL CHECK (period_start = date_trunc('milliseconds', period_start)),
  period_end   TIMESTAMPTZ NOT NULL CHECK (period_end = date_trunc('milliseconds', period_end)),
  amount_krw   BIGINT NOT NULL CHECK (amount_krw > 0),
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ALLOCATED','NO_PLAYS')),
  -- 배정에서 뺀 재생(사유별 건수): FLAGGED, POLICY_NO_TRAFFIC(조합의 정책이 감상 매출을 받지 않음).
  excluded     JSONB NULL,
  created_by   mdrl_id NOT NULL REFERENCES user_account,
  created_at   TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  allocated_by mdrl_id NULL REFERENCES user_account,
  allocated_at TIMESTAMPTZ NULL CHECK (allocated_at = date_trunc('milliseconds', allocated_at)),
  CHECK (period_end > period_start),
  CHECK ((status = 'OPEN') = (allocated_at IS NULL) AND (allocated_at IS NULL) = (allocated_by IS NULL))
);

-- 풀 배정 결과: 조합별 유효 재생 수와 배정액(최대잉여, 합 = 풀 금액), 만든 TRAFFIC 이벤트.
CREATE TABLE traffic_allocation (
  pool_id    mdrl_id NOT NULL REFERENCES traffic_pool,
  vc_id      mdrl_id NOT NULL,
  plays      INT NOT NULL CHECK (plays > 0),
  amount_krw BIGINT NOT NULL CHECK (amount_krw >= 0),
  event_id   mdrl_id NULL REFERENCES revenue_event,
  PRIMARY KEY (pool_id, vc_id),
  CHECK ((amount_krw > 0) = (event_id IS NOT NULL))
);
CREATE TRIGGER traffic_allocation_immutable BEFORE UPDATE OR DELETE ON traffic_allocation FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

ALTER TABLE play_event ENABLE ROW LEVEL SECURITY;
-- 재생은 팬 요청이 남기고(본인 것만), 읽기는 플랫폼만.
CREATE POLICY play_read ON play_event FOR SELECT USING (rc_sees_all());
CREATE POLICY play_write ON play_event FOR INSERT WITH CHECK (rc_sees_all() OR user_id = rc_user());
ALTER TABLE traffic_pool ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON traffic_pool USING (rc_sees_all());
ALTER TABLE traffic_allocation ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON traffic_allocation USING (rc_sees_all());
GRANT SELECT, INSERT ON play_event, traffic_pool, traffic_allocation TO rc_app;
GRANT UPDATE (status, excluded, allocated_by, allocated_at) ON traffic_pool TO rc_app;
