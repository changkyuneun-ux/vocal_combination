-- IR 생성 뒤 스템(2026-10-25, 시안 Song-Stems-Panel ④): 추가는 된다(다음 IR), 기존 스템은 지우지 않고 '쓰지 않음', 오디오 바꾸기는 새 버전.
-- 봉인된 facts에는 스템 행(등록 시각 ≤ knownAt)만 들어가므로 아래 표들은 이미 봉인된 digest를 바꾸지 않는다.

-- 1) 쓰지 않음: 새 발행에서 뺀다(이미 발행된 조합의 배정·렌더는 그대로). 되돌리지 않는다 — 다시 쓰려면 새로 추가한다.
CREATE TABLE stem_retirement (
  stem_id         mdrl_id PRIMARY KEY REFERENCES stem,
  retired_by      mdrl_id NOT NULL REFERENCES user_account,
  retired_at      TIMESTAMPTZ NOT NULL CHECK (retired_at = date_trunc('milliseconds', retired_at)),
  reason          TEXT NULL,
  owner_tenant_id mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant
);
ALTER TABLE stem_retirement ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON stem_retirement FOR SELECT USING (rc_owns(owner_tenant_id));
CREATE POLICY owner_insert ON stem_retirement FOR INSERT
  WITH CHECK (rc_can_write(owner_tenant_id) AND EXISTS (SELECT 1 FROM stem p WHERE p.stem_id = stem_retirement.stem_id AND rc_can_write(p.owner_tenant_id)));
GRANT SELECT, INSERT ON stem_retirement TO rc_app;

-- 2) 오디오 새 버전: IR에 든 스템의 쓰던(READY) 오디오를 바꾸면 새 파일은 여기 대기한다(검사도 여기서).
--    분배 규칙을 다시 고정(컴파일·재고정)하면 그 시각까지 올라와 READY인 새 버전이 쓰는 오디오가 되고, 이전 오디오는 기록으로 남는다.
CREATE TABLE stem_audio_next (
  stem_id         mdrl_id PRIMARY KEY REFERENCES stem,
  file_sha256     TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size       BIGINT NOT NULL CHECK (byte_size > 0),
  content_type    TEXT NOT NULL,
  storage_uri     TEXT NOT NULL,
  uploaded_by     mdrl_id NOT NULL REFERENCES user_account,
  uploaded_at     TIMESTAMPTZ NOT NULL CHECK (uploaded_at = date_trunc('milliseconds', uploaded_at)),
  status          TEXT NOT NULL CHECK (status IN ('PENDING','READY','QC_FAILED','REVIEW','BLOCKED')),
  qc_fail_code    TEXT NULL,
  qc_report       JSONB NULL,
  source_result   TEXT NULL CHECK (source_result IN ('PASS','SELF_MATCH','REVIEW','BLOCK')),
  source_report   JSONB NULL,
  fingerprint     TEXT NULL,
  duration_ms     INT NULL,
  checked_at      TIMESTAMPTZ NULL CHECK (checked_at = date_trunc('milliseconds', checked_at)),
  owner_tenant_id mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  CHECK ((status = 'QC_FAILED') = (qc_fail_code IS NOT NULL))
);
ALTER TABLE stem_audio_next ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_rw ON stem_audio_next USING (rc_owns(owner_tenant_id)) WITH CHECK (rc_can_write(owner_tenant_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON stem_audio_next TO rc_app;

CREATE TABLE stem_audio_history (
  stem_id         mdrl_id NOT NULL REFERENCES stem,
  file_sha256     TEXT NOT NULL,
  storage_uri     TEXT NOT NULL,
  duration_ms     INT NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL,
  replaced_at     TIMESTAMPTZ NOT NULL,
  owner_tenant_id mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  PRIMARY KEY (stem_id, replaced_at)
);
ALTER TABLE stem_audio_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_rw ON stem_audio_history USING (rc_owns(owner_tenant_id)) WITH CHECK (rc_can_write(owner_tenant_id));
GRANT SELECT, INSERT ON stem_audio_history TO rc_app;
