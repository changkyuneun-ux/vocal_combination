-- 연동 허브(다음 작업 14). 외부 파일(유통사 CSV, DDEX DSR)은 integration-hub 패키지가 정규화 레코드로 번역하고,
-- 코어는 원본(해시·바이트)과 줄별 결과(적용·중복·거부)를 남긴 뒤 정규화 레코드만 매출 이벤트로 넣는다. 거부 줄이 거부 큐다.

-- 파트너가 쓰는 자산 id(조합에 부여한 ISRC·유통사 상품 코드)와 조합의 대응. 플랫폼이 외부 유통을 열 때 등록한다.
CREATE TABLE partner_asset (
  tenant_id   mdrl_id NOT NULL REFERENCES tenant,
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  vc_id       mdrl_id NOT NULL,
  created_by  mdrl_id NOT NULL REFERENCES user_account,
  created_at  TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  PRIMARY KEY (tenant_id, external_id)
);

CREATE TABLE inbound_file (
  file_id      mdrl_id PRIMARY KEY,
  tenant_id    mdrl_id NOT NULL REFERENCES tenant,
  format       TEXT NOT NULL CHECK (format IN ('DISTRIBUTOR_CSV','DDEX_DSR')),
  file_name    TEXT NOT NULL,
  file_sha256  TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size    INT NOT NULL CHECK (byte_size > 0),
  raw_bytes    BYTEA NOT NULL,
  -- APPLIED: 줄별로 적용(일부 줄은 거부될 수 있다). REJECTED: 파일 단위 오류로 아무 줄도 적용하지 않음.
  status       TEXT NOT NULL CHECK (status IN ('APPLIED','REJECTED')),
  file_errors  JSONB NOT NULL DEFAULT '[]'::jsonb,
  received_by  mdrl_id NOT NULL REFERENCES user_account,
  received_at  TIMESTAMPTZ NOT NULL CHECK (received_at = date_trunc('milliseconds', received_at)),
  UNIQUE (tenant_id, file_sha256)
);
CREATE TRIGGER inbound_file_immutable BEFORE UPDATE OR DELETE ON inbound_file FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

CREATE TABLE inbound_record (
  file_id        mdrl_id NOT NULL REFERENCES inbound_file,
  line_no        INT NOT NULL CHECK (line_no >= 1),
  raw            TEXT NOT NULL,
  record         JSONB NULL,
  -- ACCEPTED: 새 매출 이벤트, DUPLICATE: 이미 받은 거래(같은 내용), REJECTED: 거부(사유 코드). 재처리로 REJECTED → ACCEPTED·DUPLICATE가 될 수 있다.
  status         TEXT NOT NULL CHECK (status IN ('ACCEPTED','DUPLICATE','REJECTED')),
  reject_code    TEXT NULL,
  reject_message TEXT NULL,
  event_id       mdrl_id NULL REFERENCES revenue_event,
  attempts       INT NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  updated_at     TIMESTAMPTZ NOT NULL CHECK (updated_at = date_trunc('milliseconds', updated_at)),
  PRIMARY KEY (file_id, line_no),
  CHECK ((status = 'REJECTED') = (reject_code IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (event_id IS NULL))
);
CREATE INDEX inbound_record_rejected ON inbound_record (reject_code) WHERE status = 'REJECTED';

-- 파트너는 자기 테넌트의 파일·줄·자산 대응만 본다. 파일 기록은 파트너 요청이, 자산 대응은 플랫폼이 쓴다.
ALTER TABLE partner_asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_read ON partner_asset FOR SELECT USING (rc_sees_all() OR tenant_id = rc_tenant());
CREATE POLICY platform_write ON partner_asset FOR INSERT WITH CHECK (rc_sees_all());
ALTER TABLE inbound_file ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_file ON inbound_file USING (rc_sees_all() OR tenant_id = rc_tenant()) WITH CHECK (rc_sees_all() OR tenant_id = rc_tenant());
ALTER TABLE inbound_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_record ON inbound_record USING (rc_sees_all() OR EXISTS (SELECT 1 FROM inbound_file f WHERE f.file_id = inbound_record.file_id))
  WITH CHECK (rc_sees_all() OR EXISTS (SELECT 1 FROM inbound_file f WHERE f.file_id = inbound_record.file_id));
GRANT SELECT, INSERT ON partner_asset, inbound_file, inbound_record TO rc_app;
GRANT UPDATE (status, reject_code, reject_message, event_id, attempts, updated_at) ON inbound_record TO rc_app;
