-- 동의 철회 후 노출 중지(다음 작업 17). 철회된 동의의 자산(보이스·녹음·작품)을 쓴 발행 조합마다 노출 보류를 건다.
-- 보류 중인 조합은 팬 앱에서 마스터를 받을 수 없고 재생도 기록되지 않는다(감상 매출이 생기지 않는다). 발행 봉인·정산 기록은 그대로다.
-- 같은 파티가 같은 자산에 다시 동의하면 그 파티가 건 보류가 풀린다(재동의는 이전 철회를 대체한다, 다음 작업 3).
CREATE TABLE exposure_hold (
  hold_id        BIGSERIAL PRIMARY KEY,
  snapshot_id    mdrl_id NOT NULL REFERENCES rights_snapshot,
  consent_id     mdrl_id NOT NULL REFERENCES consent_agreement,
  party_id       mdrl_id NOT NULL REFERENCES party,
  right_type     TEXT NOT NULL CHECK (right_type IN ('PERFORMER','MASTER','WORK')),
  asset_id       mdrl_id NOT NULL,
  held_at        TIMESTAMPTZ NOT NULL CHECK (held_at = date_trunc('milliseconds', held_at)),
  released_at    TIMESTAMPTZ NULL CHECK (released_at = date_trunc('milliseconds', released_at)),
  released_by    mdrl_id NULL REFERENCES user_account,
  release_reason TEXT NULL,
  UNIQUE (snapshot_id, consent_id),
  CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX exposure_hold_active ON exposure_hold (snapshot_id) WHERE released_at IS NULL;
CREATE INDEX exposure_hold_asset ON exposure_hold (party_id, asset_id) WHERE released_at IS NULL;

-- 읽기: 플랫폼, 그리고 그 발행 조합이 보이는 쪽(팩 소유 테넌트). 쓰기는 outbox(system)와 재동의 처리(system 범위로 쓴다)만.
ALTER TABLE exposure_hold ENABLE ROW LEVEL SECURITY;
CREATE POLICY exposure_read ON exposure_hold FOR SELECT USING (rc_sees_all() OR EXISTS (SELECT 1 FROM rights_snapshot s WHERE s.snapshot_id = exposure_hold.snapshot_id));
CREATE POLICY exposure_write ON exposure_hold FOR INSERT WITH CHECK (rc_sees_all());
CREATE POLICY exposure_release ON exposure_hold FOR UPDATE USING (rc_sees_all()) WITH CHECK (rc_sees_all());
GRANT SELECT, INSERT ON exposure_hold TO rc_app;
GRANT UPDATE (released_at, released_by, release_reason) ON exposure_hold TO rc_app;
GRANT USAGE ON SEQUENCE exposure_hold_hold_id_seq TO rc_app;
