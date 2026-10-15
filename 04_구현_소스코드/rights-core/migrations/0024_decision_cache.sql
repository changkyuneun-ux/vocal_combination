-- 팬 앱 조합 판정 캐시(다음 작업 12). 팬 트래픽은 읽기 위주이고 조합 후보가 많으므로, 같은 배치의 판정(발행 가능 여부와 사유)을 저장해 둔다.
-- 키 = (팩, 활성 정책 digest, 배치, 멤버 비율, 이용 범위). 정책이 바뀌면 키가 달라져 옛 항목은 쓰이지 않는다.
-- 무효화: 보이스 동의가 바뀌면 그 보이스를 쓴 항목만, 스템 오디오가 바뀌면 그 스템을 쓴 항목만, 녹음·작품 동의·분쟁·팩 상태가 바뀌면 그 곡의 항목 전부.
-- 무효화마다 곡의 세대(epoch)를 올린다. 계산을 시작할 때 읽은 세대가 저장할 때와 다르면(그 사이 무효화) 저장하지 않는다.
-- 저장은 세대 행을 FOR SHARE로 잠그고 하므로, 저장과 겹친 무효화는 저장이 커밋된 뒤에 지운다.

CREATE TABLE decision_epoch (
  facts_scope_id mdrl_id PRIMARY KEY REFERENCES facts_scope,
  epoch          BIGINT NOT NULL CHECK (epoch >= 1)
);

CREATE TABLE decision_cache (
  cache_key      TEXT PRIMARY KEY CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  pack_id        mdrl_id NOT NULL,
  policy_digest  TEXT NOT NULL,
  voices         TEXT[] NOT NULL,
  stems          TEXT[] NOT NULL,
  result         JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  -- 동의 유효기간처럼 시각에 따라 바뀌는 판정이 있으므로 짧게만 쓴다. 캐시는 안내용이고 실제 발행은 언제나 게이트를 다시 돈다.
  expires_at     TIMESTAMPTZ NOT NULL CHECK (expires_at = date_trunc('milliseconds', expires_at) AND expires_at > created_at),
  hits           INT NOT NULL DEFAULT 0,
  last_hit_at    TIMESTAMPTZ NULL CHECK (last_hit_at = date_trunc('milliseconds', last_hit_at))
);
CREATE INDEX decision_cache_scope ON decision_cache (facts_scope_id);
CREATE INDEX decision_cache_voices ON decision_cache USING gin (voices);
CREATE INDEX decision_cache_stems ON decision_cache USING gin (stems);

ALTER TABLE decision_epoch ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON decision_epoch USING (rc_sees_all());
ALTER TABLE decision_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON decision_cache USING (rc_sees_all());
GRANT SELECT, INSERT ON decision_epoch, decision_cache TO rc_app;
GRANT UPDATE (epoch) ON decision_epoch TO rc_app;
GRANT UPDATE (hits, last_hit_at) ON decision_cache TO rc_app;
GRANT DELETE ON decision_cache TO rc_app;
