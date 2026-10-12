-- 신원(v2.8 user_account·portal_role의 I-1 부분 집합). 역할은 PoC 서명·권한 역할.
CREATE TABLE user_account (
  user_id      mdrl_id PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);
CREATE TABLE portal_role (
  user_id mdrl_id NOT NULL REFERENCES user_account,
  role    TEXT NOT NULL CHECK (role IN ('RIGHTS_EDITOR','EDITOR','WORK_APPROVER','ACTIVATOR','ISSUER')),
  PRIMARY KEY (user_id, role)
);

-- 개발용 서명키(PoC 전용, 운영은 KMS/HSM — 통합 설계 6.4). 개인키를 DB에 두는 것은 이 테이블뿐이다.
CREATE TABLE dev_signing_key (
  user_id     mdrl_id PRIMARY KEY REFERENCES user_account,
  key_version TEXT NOT NULL,
  public_pem  TEXT NOT NULL,
  private_pem TEXT NOT NULL
);

CREATE TABLE attestation (
  digest      TEXT NOT NULL REFERENCES sealed_document,
  signer_id   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('EDITOR','APPROVER','WORK_APPROVER','ACTIVATOR','SPACE_OPS','SPACE_SETTLE','PLATFORM')),
  key_version TEXT NOT NULL,
  alg         TEXT NOT NULL DEFAULT 'Ed25519',
  signature   TEXT NOT NULL,
  signed_at   TIMESTAMPTZ NOT NULL CHECK (signed_at = date_trunc('milliseconds', signed_at)),
  PRIMARY KEY (digest, signer_id, role)
);

-- 팩(v2.8 vocal_pack의 I-1 부분 집합). facts_scope_id는 base_image를 대신하는 PoC 연결 컬럼.
CREATE TABLE vocal_pack (
  pack_id        mdrl_id PRIMARY KEY,
  pack_code      VARCHAR(32) NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED')),
  created_at     TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);
CREATE INDEX vocal_pack_scope ON vocal_pack (facts_scope_id);

-- 선언 청구권자(v2.8 claimant는 grant 단위다. I-1은 grant가 없으므로 팩 단위 대용 테이블).
CREATE TABLE pack_claimant (
  pack_id       mdrl_id NOT NULL REFERENCES vocal_pack,
  party_id      mdrl_id NOT NULL REFERENCES party,
  claimant_role TEXT NOT NULL CHECK (claimant_role IN ('MASTER_OWNER','WORK_AUTHOR','CMO','PERFORMER_FEATURED','PERFORMER_NON_FEATURED','AGENCY','AI_PROVIDER','RECORDING_CONTRIBUTOR')),
  PRIMARY KEY (pack_id, party_id, claimant_role)
);

CREATE TABLE policy_version (
  policy_id         mdrl_id NOT NULL,
  version           INT NOT NULL CHECK (version >= 1),
  source_text       TEXT NOT NULL,
  policy_digest     TEXT NOT NULL REFERENCES sealed_document,
  facts_digest      TEXT NOT NULL REFERENCES sealed_document,
  facts_known_at    TIMESTAMPTZ NOT NULL CHECK (facts_known_at = date_trunc('milliseconds', facts_known_at)),
  status            TEXT NOT NULL CHECK (status IN ('DRAFT','COMPILED','APPROVED','ACTIVE','SUPERSEDED','TERMINATED')),
  rebind_of_version INT NULL,
  pack_id           mdrl_id NOT NULL REFERENCES vocal_pack,
  created_by        mdrl_id NOT NULL REFERENCES user_account,
  created_at        TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  activated_at      TIMESTAMPTZ NULL CHECK (activated_at = date_trunc('milliseconds', activated_at)),
  PRIMARY KEY (policy_id, version)
);
CREATE UNIQUE INDEX policy_one_active ON policy_version (policy_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX policy_one_active_per_pack ON policy_version (pack_id) WHERE status = 'ACTIVE';

CREATE TRIGGER attestation_immutable BEFORE UPDATE OR DELETE ON attestation FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

GRANT SELECT, INSERT ON user_account, portal_role, dev_signing_key, attestation, vocal_pack, pack_claimant, policy_version TO rc_app;
GRANT DELETE ON pack_claimant TO rc_app;
GRANT UPDATE (status) ON vocal_pack TO rc_app;
GRANT UPDATE (status, activated_at) ON policy_version TO rc_app;
