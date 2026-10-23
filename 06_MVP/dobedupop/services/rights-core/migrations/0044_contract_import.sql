-- 계약서 불러오기(3부-B, 결정 CT1~CT5): 계약 양식 읽기 틀, 불러오기 세션과 후보 값, 권리 확인서 템플릿 2종.
-- 원본 계약서는 플랫폼 밖으로 보내지 않는다(CT1). 값은 사람이 표시한 조항 인용 문장을 읽기 틀의 값 모양에 맞춰 읽고, 사람이 하나씩 확인한다.
-- 권리 확인서는 원본을 대체하지 않고 확인·정리한다(CT3). 서명하면 권리 주장이 서명본을 근거로 바로 VERIFIED가 된다(CT5).

-- 표준 계약 템플릿: 새 기록 종류 CLAIM_CONFIRM(권리 주장 생성·확정).
ALTER TABLE contract_template DROP CONSTRAINT contract_template_record_kind_check;
ALTER TABLE contract_template ADD CONSTRAINT contract_template_record_kind_check
  CHECK (record_kind IN ('CONSENT_MASTER','CONSENT_WORK','CONSENT_PERFORMER','MANDATE_PERFORMER','CLAIM_CONFIRM','NONE'));

-- 권한: 읽기 틀 승인(플랫폼). 권리 테넌트 등록은 contract.draft를 그대로 쓴다(CT2).
INSERT INTO permission (perm_id, area, kind, org_classes, assignable, description) VALUES
('contract.frame_approve','⑦','admin','{PLATFORM}',true,'계약서 읽기 틀 승인');
INSERT INTO role_permission (role_id, perm_id) VALUES ('LEGAL','contract.frame_approve'), ('PLATFORM_ALL','contract.frame_approve');

-- 계약 양식 읽기 틀: 양식의 몇 쪽 몇 조 = 어느 IR 항목, 값 모양(예: "작가 갑의 지분은 {percent}퍼센트"). 승인 뒤 바꿀 수 없고 새 버전으로 바꾼다.
CREATE TABLE contract_reading_frame (
  frame_id        mdrl_id NOT NULL,
  version         INT NOT NULL CHECK (version >= 1),
  owner_tenant_id mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  title           TEXT NOT NULL CHECK (length(trim(title)) > 0),
  document_kind   TEXT NOT NULL CHECK (document_kind IN ('PUBLISHING','MASTER_CONTRACT')),
  pages           INT NULL CHECK (pages >= 1),
  -- [{key, label, irItem, page, clause, pattern, partyOrder?, roleDetail?}]
  fields          JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) > 0),
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  authored_by     mdrl_id NOT NULL REFERENCES user_account,
  authored_at     TIMESTAMPTZ NOT NULL CHECK (authored_at = date_trunc('milliseconds', authored_at)),
  approved_by     mdrl_id NULL REFERENCES user_account,
  approved_at     TIMESTAMPTZ NULL CHECK (approved_at = date_trunc('milliseconds', approved_at)),
  PRIMARY KEY (frame_id, version),
  CHECK ((status = 'DRAFT') = (approved_by IS NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
-- 상태 전이만: DRAFT → APPROVED(승인 필드 한 번), APPROVED → RETIRED. 내용은 바꾸지 않는다. 지우지 않는다.
CREATE FUNCTION rc_reading_frame_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contract_reading_frame %@%: delete rejected', OLD.frame_id, OLD.version USING ERRCODE = 'RC001';
  END IF;
  IF (NEW.frame_id, NEW.version, NEW.owner_tenant_id, NEW.title, NEW.document_kind, NEW.pages, NEW.fields, NEW.authored_by, NEW.authored_at)
     IS DISTINCT FROM (OLD.frame_id, OLD.version, OLD.owner_tenant_id, OLD.title, OLD.document_kind, OLD.pages, OLD.fields, OLD.authored_by, OLD.authored_at)
     OR NOT ((OLD.status = 'DRAFT' AND NEW.status = 'APPROVED') OR (OLD.status = 'APPROVED' AND NEW.status = 'RETIRED'
             AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at)) THEN
    RAISE EXCEPTION 'contract_reading_frame %@%: % -> % rejected (approved frames are replaced by a new version)', OLD.frame_id, OLD.version, OLD.status, NEW.status USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_reading_frame_guard BEFORE UPDATE OR DELETE ON contract_reading_frame FOR EACH ROW EXECUTE FUNCTION rc_reading_frame_guard();

-- 불러오기 한 번: 문서 하나, 곡 하나. 단계와 만든 권리 확인서만 바뀐다.
CREATE TABLE contract_import (
  import_id        mdrl_id PRIMARY KEY,
  facts_scope_id   mdrl_id NOT NULL REFERENCES facts_scope,
  document_id      mdrl_id NOT NULL,
  document_version INT NOT NULL,
  frame_id         mdrl_id NULL,
  frame_version    INT NULL,
  step             TEXT NOT NULL DEFAULT 'VALUES' CHECK (step IN ('VALUES','GAPS','READY','CONFIRM_SENT','DONE')),
  contract_id      mdrl_id NULL REFERENCES contract_envelope,
  owner_tenant_id  mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  created_by       mdrl_id NOT NULL REFERENCES user_account,
  created_at       TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  FOREIGN KEY (document_id, document_version) REFERENCES source_document,
  FOREIGN KEY (frame_id, frame_version) REFERENCES contract_reading_frame,
  CHECK ((frame_id IS NULL) = (frame_version IS NULL))
);
CREATE INDEX contract_import_scope ON contract_import (facts_scope_id, created_at DESC);
CREATE FUNCTION rc_contract_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contract_import %: delete rejected', OLD.import_id USING ERRCODE = 'RC001';
  END IF;
  IF (NEW.import_id, NEW.facts_scope_id, NEW.document_id, NEW.document_version, NEW.frame_id, NEW.frame_version, NEW.owner_tenant_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.import_id, OLD.facts_scope_id, OLD.document_id, OLD.document_version, OLD.frame_id, OLD.frame_version, OLD.owner_tenant_id, OLD.created_by, OLD.created_at)
     OR OLD.step = 'DONE' OR (OLD.contract_id IS NOT NULL AND NEW.contract_id IS DISTINCT FROM OLD.contract_id) THEN
    RAISE EXCEPTION 'contract_import %: update rejected', OLD.import_id USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_import_guard BEFORE UPDATE OR DELETE ON contract_import FOR EACH ROW EXECUTE FUNCTION rc_contract_import_guard();

-- 후보 값: 행은 추가만(고치거나 확인하면 새 seq). 빠진 것 입력(이용 범위·지역·기간)도 origin MANUAL로 남긴다.
CREATE TABLE import_value (
  import_id    mdrl_id NOT NULL REFERENCES contract_import,
  key          TEXT NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9_.]*$'),
  seq          INT NOT NULL CHECK (seq >= 1),
  value        JSONB NULL,
  page         INT NULL CHECK (page >= 1),
  clause       TEXT NULL,
  quote        TEXT NULL,
  -- 근거 조항(원천 문서 조항 표시, 길 A와 같은 표). 확인서 서명 뒤 만든 주장에 연결한다.
  clause_ref   mdrl_id NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('FRAME','MANUAL')),
  compared     TEXT NULL CHECK (compared IN ('SAME','NEW','DIFFERENT')),
  confirmed_by mdrl_id NULL REFERENCES user_account,
  confirmed_at TIMESTAMPTZ NULL CHECK (confirmed_at = date_trunc('milliseconds', confirmed_at)),
  owner_tenant_id mdrl_id NOT NULL REFERENCES tenant,
  PRIMARY KEY (import_id, key, seq),
  CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL))
);
CREATE TRIGGER import_value_immutable BEFORE UPDATE OR DELETE ON import_value FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

ALTER TABLE contract_reading_frame ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_value ENABLE ROW LEVEL SECURITY;
-- 읽기 틀: 소유 테넌트와 플랫폼(승인)이 본다. 등록은 소유 테넌트, 승인·폐기는 서비스가 권한을 확인한 뒤 시스템 범위에서 한다.
CREATE POLICY frame_read ON contract_reading_frame FOR SELECT USING (rc_owns(owner_tenant_id));
CREATE POLICY frame_insert ON contract_reading_frame FOR INSERT WITH CHECK (rc_can_write(owner_tenant_id));
CREATE POLICY frame_update ON contract_reading_frame FOR UPDATE USING (current_setting('rc.scope', true) = 'system') WITH CHECK (current_setting('rc.scope', true) = 'system');
CREATE POLICY import_read ON contract_import FOR SELECT USING (rc_owns(owner_tenant_id));
CREATE POLICY import_insert ON contract_import FOR INSERT WITH CHECK (rc_can_write(owner_tenant_id));
CREATE POLICY import_update ON contract_import FOR UPDATE USING (rc_can_write(owner_tenant_id)) WITH CHECK (rc_can_write(owner_tenant_id));
CREATE POLICY import_value_read ON import_value FOR SELECT USING (rc_owns(owner_tenant_id));
CREATE POLICY import_value_insert ON import_value FOR INSERT WITH CHECK (rc_can_write(owner_tenant_id));
GRANT SELECT, INSERT ON contract_reading_frame, contract_import, import_value TO rc_app;
GRANT UPDATE (status, approved_by, approved_at) ON contract_reading_frame TO rc_app;
GRANT UPDATE (step, contract_id) ON contract_import TO rc_app;

-- 권리 확인서 2종(CT5): 플랫폼 법무 템플릿 v1(시드). 조항 문구는 시안 Song-ClaimConfirm 미리보기의 제1조~제5조.
INSERT INTO contract_template (template_id, version, kind, record_kind, title, variables, clauses, signer_vars, status, seeded, created_at, approved_at) VALUES
('tpl_claim_confirm_label', 1, 'MASTER_CONTRACT', 'CLAIM_CONFIRM', '권리 확인서 · 레이블용',
 '[{"name": "subject", "label": "대상", "type": "text"}, {"name": "holder", "label": "마스터 보유자", "type": "party"}, {"name": "recording", "label": "녹음", "type": "recording"},
   {"name": "source", "label": "근거", "type": "text"}, {"name": "importId", "label": "불러오기", "type": "text"},
   {"name": "validFrom", "label": "효력 시작", "type": "date"}]'::jsonb,
 '[{"clauseId": "subject", "heading": "대상", "clauseType": "OTHER", "fields": ["subject"], "text": "{{subject}}"},
   {"clauseId": "holder", "heading": "마스터 보유", "clauseType": "RIGHT_HOLDER", "fields": ["holder", "recording"], "text": "{{holder}}가 녹음 {{recording}}의 마스터를 100% 보유함을 확인한다."},
   {"clauseId": "source", "heading": "근거", "clauseType": "OTHER", "fields": ["source"], "text": "{{source}}"},
   {"clauseId": "original", "heading": "원본과의 관계", "clauseType": "OTHER", "fields": [], "text": "이 확인서는 원본 계약을 대체하지 않는다. 원본과 다르면 원본이 우선하고, 다름은 분쟁으로 처리한다."}]'::jsonb,
 ARRAY['holder'], 'APPROVED', true, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z'),
('tpl_claim_confirm_author', 1, 'PUBLISHING', 'CLAIM_CONFIRM', '권리 확인서 · 작가용',
 '[{"name": "subject", "label": "대상", "type": "text"}, {"name": "authors", "label": "작가와 지분", "type": "shares"},
   {"name": "usage", "label": "이용 범위", "type": "text"}, {"name": "period", "label": "기간", "type": "text"},
   {"name": "source", "label": "근거", "type": "text"}, {"name": "importId", "label": "불러오기", "type": "text"},
   {"name": "actions", "label": "이용 행위", "type": "multi", "options": [["PREVIEW", "미리듣기"], ["COMBINE", "조합 생성"], ["PERSONAL_HOLD", "개인 보관"], ["SHARE_LINK", "링크 공유"], ["DOWNLOAD", "내려받기"]]},
   {"name": "territories", "label": "지역", "type": "multi", "options": [["KR", "대한민국"], ["JP", "일본"], ["US", "미국"]]},
   {"name": "media", "label": "매체", "type": "multi", "options": [["FAN_APP", "팬앱"], ["EXTERNAL_SNS", "외부 SNS"]]},
   {"name": "audience", "label": "공개 대상", "type": "multi", "options": [["FAN_COMMUNITY", "팬 커뮤니티"], ["PUBLIC", "전체 공개"]]},
   {"name": "validFrom", "label": "시작일", "type": "date"}, {"name": "validTo", "label": "종료일", "type": "date"}]'::jsonb,
 '[{"clauseId": "subject", "heading": "대상", "clauseType": "OTHER", "fields": ["subject"], "text": "{{subject}}"},
   {"clauseId": "shares", "heading": "작가와 지분", "clauseType": "SHARE", "fields": ["authors"], "text": "아래 작가와 지분을 확인한다. 지분의 합은 100%다.{{authors}}"},
   {"clauseId": "scope", "heading": "이용 범위", "clauseType": "SCOPE", "fields": ["usage", "period", "actions", "territories", "media", "audience", "validFrom", "validTo"], "text": "{{usage}}, {{period}}"},
   {"clauseId": "source", "heading": "근거", "clauseType": "OTHER", "fields": ["source"], "text": "{{source}}"},
   {"clauseId": "original", "heading": "원본과의 관계", "clauseType": "OTHER", "fields": [], "text": "이 확인서는 원본 계약을 대체하지 않는다. 원본과 다르면 원본이 우선하고, 다름은 분쟁으로 처리한다."}]'::jsonb,
 ARRAY['authors'], 'APPROVED', true, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
