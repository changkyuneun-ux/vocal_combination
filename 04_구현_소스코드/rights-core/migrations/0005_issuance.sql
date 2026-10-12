-- 발행 스냅샷(v2.8 3.6의 I-1 부분 집합). grant·stamp·recipe 컬럼은 범위 밖이라 이후 마이그레이션에서 추가한다.
CREATE TABLE rights_snapshot (
  snapshot_id    vcrl_id PRIMARY KEY,
  vc_id          vcrl_id NOT NULL UNIQUE,
  pack_id        vcrl_id NOT NULL REFERENCES vocal_pack,
  policy_id      vcrl_id NOT NULL,
  policy_version INT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  FOREIGN KEY (policy_id, policy_version) REFERENCES policy_version (policy_id, version)
);

CREATE TABLE snapshot_stem_assignment (
  snapshot_id    vcrl_id NOT NULL REFERENCES rights_snapshot,
  slot_id        vcrl_id NOT NULL REFERENCES part_slot,
  stem_id        vcrl_id NOT NULL REFERENCES stem,
  party_id       vcrl_id NULL REFERENCES party,
  start_ms       INT NOT NULL,
  end_ms         INT NOT NULL,
  duration_ms    INT NOT NULL CHECK (duration_ms > 0),
  rights_bearing BOOLEAN NOT NULL,
  PRIMARY KEY (snapshot_id, slot_id)
);

CREATE TABLE snapshot_member_pct (
  snapshot_id vcrl_id NOT NULL REFERENCES rights_snapshot,
  party_id    vcrl_id NOT NULL REFERENCES party,
  pct_bps     INT NOT NULL CHECK (pct_bps BETWEEN 0 AND 10000),
  PRIMARY KEY (snapshot_id, party_id)
);

-- 발행 봉인(통합 설계 3.2 S3): 정산의 유일한 입력.
CREATE TABLE issue_seal (
  snapshot_id       vcrl_id PRIMARY KEY REFERENCES rights_snapshot,
  facts_digest      TEXT NOT NULL REFERENCES sealed_document,
  policy_digest     TEXT NOT NULL REFERENCES sealed_document,
  projection_digest TEXT NOT NULL REFERENCES sealed_document,
  members_digest    TEXT NOT NULL REFERENCES sealed_document,
  as_of             TIMESTAMPTZ NOT NULL CHECK (as_of = date_trunc('milliseconds', as_of)),
  known_at          TIMESTAMPTZ NOT NULL CHECK (known_at = date_trunc('milliseconds', known_at))
);

CREATE TRIGGER rights_snapshot_immutable BEFORE UPDATE OR DELETE ON rights_snapshot FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER snapshot_stem_assignment_immutable BEFORE UPDATE OR DELETE ON snapshot_stem_assignment FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER snapshot_member_pct_immutable BEFORE UPDATE OR DELETE ON snapshot_member_pct FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER issue_seal_immutable BEFORE UPDATE OR DELETE ON issue_seal FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

GRANT SELECT, INSERT ON rights_snapshot, snapshot_stem_assignment, snapshot_member_pct, issue_seal TO rc_app;
