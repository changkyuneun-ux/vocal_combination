-- 오디오 처리 서비스 연동(다음 작업 9): 스템 기술 검수(QC)와 소스 출처 검사 결과. 오디오 처리 서비스는 신호만 만들고,
-- 스템을 READY로 바꾸는 판단은 코어가 한다. 오디오를 올리지 않은 스템(메타데이터만 등록, 시험·시연용)은 이 표에 행이 없다.

CREATE TABLE stem_audio (
  stem_id         mdrl_id PRIMARY KEY REFERENCES stem,
  file_sha256     TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size       BIGINT NOT NULL CHECK (byte_size > 0),
  content_type    TEXT NOT NULL,
  storage_uri     TEXT NOT NULL,
  uploaded_by     mdrl_id NOT NULL REFERENCES user_account,
  uploaded_at     TIMESTAMPTZ NOT NULL CHECK (uploaded_at = date_trunc('milliseconds', uploaded_at)),
  -- PENDING(검사 대기) → READY | QC_FAILED | REVIEW(사람 판단 필요) | BLOCKED. REVIEW는 운영이 READY·BLOCKED로 정한다.
  status          TEXT NOT NULL CHECK (status IN ('PENDING','READY','QC_FAILED','REVIEW','BLOCKED')),
  qc_fail_code    TEXT NULL,
  qc_report       JSONB NULL,
  source_result   TEXT NULL CHECK (source_result IN ('PASS','SELF_MATCH','REVIEW','BLOCK')),
  source_report   JSONB NULL,
  fingerprint     TEXT NULL,
  duration_ms     INT NULL,
  checked_at      TIMESTAMPTZ NULL CHECK (checked_at = date_trunc('milliseconds', checked_at)),
  reviewed_by     mdrl_id NULL REFERENCES user_account,
  reviewed_at     TIMESTAMPTZ NULL CHECK (reviewed_at = date_trunc('milliseconds', reviewed_at)),
  review_reason   TEXT NULL,
  owner_tenant_id mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  CHECK ((status = 'QC_FAILED') = (qc_fail_code IS NOT NULL)),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL) AND (reviewed_by IS NULL) = (review_reason IS NULL))
);
CREATE INDEX stem_audio_status ON stem_audio (status) WHERE status <> 'READY';
CREATE INDEX stem_audio_sha ON stem_audio (file_sha256);
ALTER TABLE stem_audio ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON stem_audio FOR SELECT USING (rc_owns(owner_tenant_id));
CREATE POLICY owner_insert ON stem_audio FOR INSERT
  WITH CHECK (rc_can_write(owner_tenant_id) AND EXISTS (SELECT 1 FROM stem p WHERE p.stem_id = stem_audio.stem_id AND rc_can_write(p.owner_tenant_id)));
CREATE POLICY owner_update ON stem_audio FOR UPDATE USING (rc_owns(owner_tenant_id)) WITH CHECK (rc_can_write(owner_tenant_id));
GRANT SELECT, INSERT ON stem_audio TO rc_app;
GRANT UPDATE (file_sha256, byte_size, content_type, storage_uri, uploaded_by, uploaded_at, status, qc_fail_code, qc_report, source_result, source_report,
              fingerprint, duration_ms, checked_at, reviewed_by, reviewed_at, review_reason) ON stem_audio TO rc_app;

-- 상용 음원 대조용 참조 음원(음향 지문). 플랫폼이 등록·관리한다. 권리자(소유 파티) 또는 녹음이 정해져 있으면
-- 같은 권리자의 스템과 맞을 때는 자기 음원(SELF_MATCH), 다른 권리자의 스템과 맞으면 차단(BLOCK)한다.
CREATE TABLE reference_audio (
  reference_id   mdrl_id PRIMARY KEY,
  title          TEXT NOT NULL,
  owner_party_id mdrl_id NULL REFERENCES party,
  recording_id   mdrl_id NULL,
  file_sha256    TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  fingerprint    TEXT NOT NULL,
  duration_ms    INT NOT NULL,
  created_by     mdrl_id NOT NULL REFERENCES user_account,
  created_at     TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);
ALTER TABLE reference_audio ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON reference_audio USING (rc_sees_all());
GRANT SELECT, INSERT ON reference_audio TO rc_app;
