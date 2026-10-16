-- 조합 렌더링(다음 작업 10): 발행된 조합의 마스터 렌더(워터마크 포함)와 렌더 무결성 검증 결과.
-- 원본 스템은 내보내지 않고 렌더 결과만 팬에게 준다. 정산은 렌더 결과를 쓰지 않는다(사용량은 발행 봉인의 스템 배정).

-- 누가 발행했는지(팬 본인 또는 운영). 팬 앱은 자기 조합의 렌더만 받는다.
ALTER TABLE rights_snapshot ADD COLUMN issued_by mdrl_id NULL REFERENCES user_account;

CREATE TABLE combination_render (
  snapshot_id       mdrl_id PRIMARY KEY REFERENCES rights_snapshot,
  -- PENDING → RENDERED | FAILED | SKIPPED(오디오 없이 등록된 메타데이터 스템이 섞여 렌더할 수 없음)
  status            TEXT NOT NULL CHECK (status IN ('PENDING','RENDERED','FAILED','SKIPPED')),
  watermark_id      TEXT NOT NULL,
  -- 렌더 입력의 요약: (슬롯, 시작·끝, 스템 파일 해시)를 정렬해 해시한 값. 입력이 같으면 렌더도 같아야 한다.
  input_sha256      TEXT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  render_sha256     TEXT NULL CHECK (render_sha256 ~ '^[0-9a-f]{64}$'),
  storage_uri       TEXT NULL,
  duration_ms       INT NULL,
  error             TEXT NULL,
  created_at        TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  rendered_at       TIMESTAMPTZ NULL CHECK (rendered_at = date_trunc('milliseconds', rendered_at)),
  verified_at       TIMESTAMPTZ NULL CHECK (verified_at = date_trunc('milliseconds', verified_at)),
  verify_result     TEXT NULL CHECK (verify_result IN ('MATCH','MISMATCH','WATERMARK_MISSING')),
  CHECK ((status = 'RENDERED') = (render_sha256 IS NOT NULL AND storage_uri IS NOT NULL))
);
ALTER TABLE combination_render ENABLE ROW LEVEL SECURITY;
CREATE POLICY snapshot_visible ON combination_render USING (rc_sees_all() OR EXISTS (SELECT 1 FROM rights_snapshot s WHERE s.snapshot_id = combination_render.snapshot_id));
GRANT SELECT, INSERT ON combination_render TO rc_app;
GRANT UPDATE (status, input_sha256, render_sha256, storage_uri, duration_ms, error, rendered_at, verified_at, verify_result) ON combination_render TO rc_app;
