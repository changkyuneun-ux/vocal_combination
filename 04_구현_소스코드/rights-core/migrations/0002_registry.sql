-- v2.8 3.1·3.2·3.3의 I-1 부분 집합. 컬럼 이름·타입은 v2.8과 같고, 범위 밖 컬럼은 이후 마이그레이션에서 추가한다.
-- 예외: work.iswc는 표시 형식(T-123.456.789-0)을 담기 위해 TEXT.

CREATE TABLE party (
  party_id     mdrl_id PRIMARY KEY,
  party_type   TEXT NOT NULL CHECK (party_type IN ('LABEL','AGENCY','PUBLISHER','CMO','AUTHOR','ARTIST','MEMBER','SESSION','AI_PROVIDER','FAN','PLATFORM')),
  display_name TEXT NOT NULL,
  isni         CHAR(16) NULL,
  ipi_no       VARCHAR(11) NULL,
  created_at   TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE work (
  work_id    mdrl_id PRIMARY KEY,
  title      TEXT NOT NULL,
  iswc       TEXT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE facts_scope (
  facts_scope_id mdrl_id PRIMARY KEY,
  work_id        mdrl_id NOT NULL UNIQUE REFERENCES work,
  last_version   INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE recording_version (
  recording_id          mdrl_id PRIMARY KEY,
  work_id               mdrl_id NOT NULL REFERENCES work,
  master_owner_party_id mdrl_id NOT NULL REFERENCES party,
  isrc                  CHAR(12) NULL UNIQUE,
  version_title         TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE part_slot (
  slot_id      mdrl_id PRIMARY KEY,
  recording_id mdrl_id NOT NULL REFERENCES recording_version,
  start_ms     INT NOT NULL CHECK (start_ms >= 0),
  end_ms       INT NOT NULL,
  duration_ms  INT GENERATED ALWAYS AS (end_ms - start_ms) STORED,
  sort_order   INT NOT NULL,
  CHECK (end_ms > start_ms),
  UNIQUE (recording_id, sort_order),
  UNIQUE (slot_id, recording_id)
);

CREATE TABLE stem (
  stem_id            mdrl_id PRIMARY KEY,
  slot_id            mdrl_id NOT NULL,
  recording_id       mdrl_id NOT NULL,
  performer_party_id mdrl_id NULL REFERENCES party,
  rights_bearing     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  FOREIGN KEY (slot_id, recording_id) REFERENCES part_slot (slot_id, recording_id)
);

CREATE TABLE voice (
  voice_id       mdrl_id PRIMARY KEY,
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  kind           TEXT NOT NULL CHECK (kind IN ('HUMAN','AI')),
  created_at     TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE right_claim (
  claim_id        mdrl_id NOT NULL,
  version         INT NOT NULL CHECK (version >= 1),
  facts_scope_id  mdrl_id NOT NULL REFERENCES facts_scope,
  source_id       mdrl_id NOT NULL,
  edge            TEXT NOT NULL CHECK (edge IN ('PERFORMED_BY','OWNED_BY','CONTROLLED_BY','WRITTEN_BY','CONTRIBUTED_BY')),
  target_id       mdrl_id NOT NULL,
  share_bps       INT NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  performer_role  TEXT NULL CHECK (performer_role IN ('FEATURED','NON_FEATURED')),
  role_detail     TEXT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ASSERTED','VERIFIED','DISPUTED','SUPERSEDED')),
  valid_from      TIMESTAMPTZ NOT NULL CHECK (valid_from = date_trunc('milliseconds', valid_from)),
  valid_to        TIMESTAMPTZ NULL CHECK (valid_to = date_trunc('milliseconds', valid_to)),
  recorded_at     TIMESTAMPTZ NOT NULL CHECK (recorded_at = date_trunc('milliseconds', recorded_at)),
  superseded_at   TIMESTAMPTZ NULL CHECK (superseded_at = date_trunc('milliseconds', superseded_at)),
  evidence_digest TEXT NULL CHECK (evidence_digest ~ '^mdrl:sha256:[0-9a-f]{64}$'),
  visibility      TEXT NULL CHECK (visibility IN ('PUBLIC','PARTIES','PRIVATE')),
  source_ref      TEXT NULL,
  PRIMARY KEY (claim_id, version),
  UNIQUE (claim_id, recorded_at),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (superseded_at IS NULL OR superseded_at > recorded_at),
  CHECK (performer_role IS NULL OR edge = 'PERFORMED_BY')
);
CREATE UNIQUE INDEX right_claim_current ON right_claim (claim_id) WHERE superseded_at IS NULL;
CREATE INDEX right_claim_scope ON right_claim (facts_scope_id, recorded_at);

CREATE TABLE mandate (
  mandate_id     mdrl_id NOT NULL,
  version        INT NOT NULL CHECK (version >= 1),
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  from_party_id  mdrl_id NOT NULL REFERENCES party,
  to_party_id    mdrl_id NOT NULL REFERENCES party,
  right_kind     TEXT NOT NULL CHECK (right_kind IN ('MASTER','WORK','PERFORMER')),
  share_bps      INT NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  status         TEXT NOT NULL CHECK (status IN ('ASSERTED','VERIFIED','DISPUTED','SUPERSEDED')),
  valid_from     TIMESTAMPTZ NOT NULL CHECK (valid_from = date_trunc('milliseconds', valid_from)),
  valid_to       TIMESTAMPTZ NULL CHECK (valid_to = date_trunc('milliseconds', valid_to)),
  recorded_at    TIMESTAMPTZ NOT NULL CHECK (recorded_at = date_trunc('milliseconds', recorded_at)),
  superseded_at  TIMESTAMPTZ NULL CHECK (superseded_at = date_trunc('milliseconds', superseded_at)),
  visibility     TEXT NULL CHECK (visibility IN ('PUBLIC','PARTIES','PRIVATE')),
  source_ref     TEXT NULL,
  PRIMARY KEY (mandate_id, version),
  UNIQUE (mandate_id, recorded_at),
  CHECK (from_party_id <> to_party_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (superseded_at IS NULL OR superseded_at > recorded_at)
);
CREATE UNIQUE INDEX mandate_current ON mandate (mandate_id) WHERE superseded_at IS NULL;
CREATE INDEX mandate_scope ON mandate (facts_scope_id, recorded_at);

-- 분쟁(v2.8 3.8 dispute의 I-1 부분 집합). 서비스는 Task 6.
CREATE TABLE dispute (
  dispute_id     mdrl_id PRIMARY KEY,
  target_type    TEXT NOT NULL CHECK (target_type IN ('RIGHT_CLAIM','MANDATE')),
  target_id      mdrl_id NOT NULL,
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  dispute_reason TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  opened_at      TIMESTAMPTZ NOT NULL,
  closed_at      TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX dispute_one_open ON dispute (target_type, target_id) WHERE status = 'OPEN';
CREATE INDEX dispute_open_scope ON dispute (facts_scope_id) WHERE status = 'OPEN';

-- 엔티티는 I-1에서 불변(IR에 들어가는 값이 바뀌면 digest가 설명 없이 바뀌므로).
CREATE TRIGGER party_immutable BEFORE UPDATE OR DELETE ON party FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER work_immutable BEFORE UPDATE OR DELETE ON work FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER recording_immutable BEFORE UPDATE OR DELETE ON recording_version FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER part_slot_immutable BEFORE UPDATE OR DELETE ON part_slot FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER stem_immutable BEFORE UPDATE OR DELETE ON stem FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER voice_immutable BEFORE UPDATE OR DELETE ON voice FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER right_claim_append_only BEFORE UPDATE OR DELETE ON right_claim FOR EACH ROW EXECUTE FUNCTION rc_allow_supersede_only();
CREATE TRIGGER mandate_append_only BEFORE UPDATE OR DELETE ON mandate FOR EACH ROW EXECUTE FUNCTION rc_allow_supersede_only();

GRANT SELECT, INSERT ON party, work, facts_scope, recording_version, part_slot, stem, voice, right_claim, mandate, dispute TO rc_app;
GRANT UPDATE (last_version) ON facts_scope TO rc_app;
GRANT UPDATE (superseded_at) ON right_claim, mandate TO rc_app;
GRANT UPDATE (status, closed_at) ON dispute TO rc_app;
