-- 최초 작성(원천 문서 설계 S4, 결정 D6·D1): 표준 계약 템플릿, 계약(서명 요청)과 당사자 서명.
-- 템플릿은 조항 + 변수(구조화 값)이고 조항↔변수 대응이 템플릿 버전에 고정된다. 고칠 때는 새 버전(법무 작성 ≠ 법무 승인).
-- 서명된 계약은 서명 당시 템플릿 버전에 고정되고 소급해 바뀌지 않는다. 모든 당사자가 서명하면 서명본이 원천 문서(TEMPLATE_SIGNED)가 되고
-- 마법사 답이 그대로 기록(동의·위임)이 된다. 전자서명은 공급자 인터페이스 뒤에 둔다(지금은 개발용 임의 공급자).

ALTER TABLE portal_role DROP CONSTRAINT portal_role_role_check;
ALTER TABLE portal_role ADD CONSTRAINT portal_role_role_check
  CHECK (role IN ('RIGHTS_EDITOR','EDITOR','WORK_APPROVER','ACTIVATOR','ISSUER','SPACE_OPS','SPACE_SETTLE','SYSTEM','PERFORMER','COMPLIANCE','LEGAL'));

CREATE TABLE contract_template (
  template_id   mdrl_id NOT NULL,
  version       INT NOT NULL CHECK (version >= 1),
  kind          TEXT NOT NULL CHECK (kind IN ('MASTER_CONTRACT','PUBLISHING','PERFORMER_CONSENT','MANDATE','PLATFORM_CONTRACT')),
  -- 서명되면 만들어지는 기록
  record_kind   TEXT NOT NULL CHECK (record_kind IN ('CONSENT_MASTER','CONSENT_WORK','CONSENT_PERFORMER','MANDATE_PERFORMER','NONE')),
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  variables     JSONB NOT NULL,
  clauses       JSONB NOT NULL,
  signer_vars   TEXT[] NOT NULL CHECK (cardinality(signer_vars) > 0),
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  -- 시드(v1)는 법무 초안으로 들어와 작성·승인자가 없다. 이후 버전은 작성자 ≠ 승인자.
  seeded        BOOLEAN NOT NULL DEFAULT false,
  authored_by   mdrl_id NULL REFERENCES user_account,
  approved_by   mdrl_id NULL REFERENCES user_account,
  created_at    TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  approved_at   TIMESTAMPTZ NULL CHECK (approved_at = date_trunc('milliseconds', approved_at)),
  PRIMARY KEY (template_id, version),
  CHECK (seeded OR authored_by IS NOT NULL),
  CHECK (status = 'DRAFT' OR seeded OR approved_by IS NOT NULL),
  CHECK (approved_by IS NULL OR approved_by <> authored_by)
);
ALTER TABLE contract_template ENABLE ROW LEVEL SECURITY;
CREATE POLICY template_read ON contract_template FOR SELECT USING (true);
CREATE POLICY template_insert ON contract_template FOR INSERT WITH CHECK (rc_sees_all());
CREATE POLICY template_update ON contract_template FOR UPDATE USING (rc_sees_all()) WITH CHECK (rc_sees_all());
GRANT SELECT, INSERT ON contract_template TO rc_app;
GRANT UPDATE (status, approved_by, approved_at) ON contract_template TO rc_app;

INSERT INTO contract_template (template_id, version, kind, record_kind, title, variables, clauses, signer_vars, status, seeded, created_at, approved_at) VALUES
('tpl_master_license', 1, 'MASTER_CONTRACT', 'CONSENT_MASTER', '녹음 이용허락 표준계약', '[{"name": "licensor", "label": "허락자(마스터 권리자)", "type": "party"}, {"name": "recording", "label": "녹음", "type": "recording"}, {"name": "actions", "label": "이용 행위", "type": "multi", "options": [["PREVIEW", "미리듣기"], ["COMBINE", "조합 생성"], ["PERSONAL_HOLD", "개인 보관"], ["SHARE_LINK", "링크 공유"], ["DOWNLOAD", "내려받기"]]}, {"name": "territories", "label": "지역", "type": "multi", "options": [["KR", "대한민국"], ["JP", "일본"], ["US", "미국"]]}, {"name": "media", "label": "매체", "type": "multi", "options": [["FAN_APP", "팬앱"], ["EXTERNAL_SNS", "외부 SNS"]]}, {"name": "audience", "label": "공개 대상", "type": "multi", "options": [["FAN_COMMUNITY", "팬 커뮤니티"], ["PUBLIC", "전체 공개"]]}, {"name": "validFrom", "label": "시작일", "type": "date"}, {"name": "validTo", "label": "종료일", "type": "date"}]'::jsonb, '[{"clauseId": "parties", "heading": "당사자", "clauseType": "RIGHT_HOLDER", "fields": ["licensor", "recording"], "text": "{{licensor}}(이하 \"허락자\")는 녹음 {{recording}}의 마스터 권리자로서 플랫폼(이하 \"이용자\")에게 아래 범위의 이용을 허락한다."}, {"clauseId": "scope", "heading": "이용 범위", "clauseType": "SCOPE", "fields": ["actions", "territories", "media", "audience"], "text": "이용 행위는 {{actions}}, 지역은 {{territories}}, 매체는 {{media}}, 공개 대상은 {{audience}}로 한정한다. 이 범위를 넘는 이용은 따로 허락받아야 한다."}, {"clauseId": "period", "heading": "기간", "clauseType": "PERIOD", "fields": ["validFrom", "validTo"], "text": "이 허락은 {{validFrom}}부터 {{validTo}}까지 유효하다. 기간을 정하지 않은 포괄 허락은 하지 않는다."}, {"clauseId": "revenue", "heading": "수익 배분", "clauseType": "OTHER", "fields": [], "text": "이용으로 생긴 수익은 해당 곡의 활성 분배 정책에 따라 정산하고, 정산 내역은 권리자 포털에서 확인할 수 있다."}, {"clauseId": "revoke", "heading": "철회", "clauseType": "OTHER", "fields": [], "text": "허락자는 언제든 이 허락을 철회할 수 있다. 철회하면 새 이용은 멈추고, 이미 발행된 조합은 정책이 정한 대로 처리한다."}]'::jsonb, ARRAY['licensor'], 'APPROVED', true, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z'),
('tpl_work_license', 1, 'PUBLISHING', 'CONSENT_WORK', '작품 이용허락 표준계약', '[{"name": "licensor", "label": "허락자(작품 권리자)", "type": "party"}, {"name": "actions", "label": "이용 행위", "type": "multi", "options": [["PREVIEW", "미리듣기"], ["COMBINE", "조합 생성"], ["PERSONAL_HOLD", "개인 보관"], ["SHARE_LINK", "링크 공유"], ["DOWNLOAD", "내려받기"]]}, {"name": "territories", "label": "지역", "type": "multi", "options": [["KR", "대한민국"], ["JP", "일본"], ["US", "미국"]]}, {"name": "media", "label": "매체", "type": "multi", "options": [["FAN_APP", "팬앱"], ["EXTERNAL_SNS", "외부 SNS"]]}, {"name": "audience", "label": "공개 대상", "type": "multi", "options": [["FAN_COMMUNITY", "팬 커뮤니티"], ["PUBLIC", "전체 공개"]]}, {"name": "validFrom", "label": "시작일", "type": "date"}, {"name": "validTo", "label": "종료일", "type": "date"}]'::jsonb, '[{"clauseId": "parties", "heading": "당사자", "clauseType": "RIGHT_HOLDER", "fields": ["licensor", "work"], "text": "{{licensor}}(이하 \"허락자\")는 작품 {{work}}의 권리자로서 플랫폼(이하 \"이용자\")에게 아래 범위의 이용을 허락한다."}, {"clauseId": "scope", "heading": "이용 범위", "clauseType": "SCOPE", "fields": ["actions", "territories", "media", "audience"], "text": "이용 행위는 {{actions}}, 지역은 {{territories}}, 매체는 {{media}}, 공개 대상은 {{audience}}로 한정한다. 이 범위를 넘는 이용은 따로 허락받아야 한다."}, {"clauseId": "period", "heading": "기간", "clauseType": "PERIOD", "fields": ["validFrom", "validTo"], "text": "이 허락은 {{validFrom}}부터 {{validTo}}까지 유효하다. 기간을 정하지 않은 포괄 허락은 하지 않는다."}, {"clauseId": "revenue", "heading": "수익 배분", "clauseType": "OTHER", "fields": [], "text": "이용으로 생긴 수익은 해당 곡의 활성 분배 정책에 따라 정산하고, 정산 내역은 권리자 포털에서 확인할 수 있다."}, {"clauseId": "revoke", "heading": "철회", "clauseType": "OTHER", "fields": [], "text": "허락자는 언제든 이 허락을 철회할 수 있다. 철회하면 새 이용은 멈추고, 이미 발행된 조합은 정책이 정한 대로 처리한다."}]'::jsonb, ARRAY['licensor'], 'APPROVED', true, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z'),
('tpl_performer_consent', 1, 'PERFORMER_CONSENT', 'CONSENT_PERFORMER', '실연 이용 동의서', '[{"name": "performer", "label": "실연자", "type": "party"}, {"name": "voice", "label": "보이스", "type": "voice"}, {"name": "actions", "label": "이용 행위", "type": "multi", "options": [["PREVIEW", "미리듣기"], ["COMBINE", "조합 생성"], ["PERSONAL_HOLD", "개인 보관"], ["SHARE_LINK", "링크 공유"], ["DOWNLOAD", "내려받기"]]}, {"name": "territories", "label": "지역", "type": "multi", "options": [["KR", "대한민국"], ["JP", "일본"], ["US", "미국"]]}, {"name": "media", "label": "매체", "type": "multi", "options": [["FAN_APP", "팬앱"], ["EXTERNAL_SNS", "외부 SNS"]]}, {"name": "audience", "label": "공개 대상", "type": "multi", "options": [["FAN_COMMUNITY", "팬 커뮤니티"], ["PUBLIC", "전체 공개"]]}, {"name": "validFrom", "label": "시작일", "type": "date"}, {"name": "validTo", "label": "종료일", "type": "date"}]'::jsonb, '[{"clauseId": "parties", "heading": "당사자", "clauseType": "RIGHT_HOLDER", "fields": ["performer", "voice"], "text": "{{performer}}(이하 \"실연자\")는 자기 보이스 {{voice}}를 플랫폼이 아래 범위에서 쓰는 데 동의한다."}, {"clauseId": "scope", "heading": "이용 범위", "clauseType": "SCOPE", "fields": ["actions", "territories", "media", "audience"], "text": "이용 행위는 {{actions}}, 지역은 {{territories}}, 매체는 {{media}}, 공개 대상은 {{audience}}로 한정한다. 이 범위를 넘는 이용은 따로 허락받아야 한다."}, {"clauseId": "period", "heading": "기간", "clauseType": "PERIOD", "fields": ["validFrom", "validTo"], "text": "이 허락은 {{validFrom}}부터 {{validTo}}까지 유효하다. 기간을 정하지 않은 포괄 허락은 하지 않는다."}, {"clauseId": "revenue", "heading": "수익 배분", "clauseType": "OTHER", "fields": [], "text": "이용으로 생긴 수익은 해당 곡의 활성 분배 정책에 따라 정산하고, 정산 내역은 권리자 포털에서 확인할 수 있다."}, {"clauseId": "revoke", "heading": "철회", "clauseType": "OTHER", "fields": [], "text": "실연자는 언제든 이 허락을 철회할 수 있다. 철회하면 새 이용은 멈추고, 이미 발행된 조합은 정책이 정한 대로 처리한다."}]'::jsonb, ARRAY['performer'], 'APPROVED', true, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z'),
('tpl_performer_mandate', 1, 'MANDATE', 'MANDATE_PERFORMER', '실연 수익 수령 위임계약', '[{"name": "performer", "label": "위임하는 실연자", "type": "party"}, {"name": "agency", "label": "수령하는 소속사", "type": "party"}, {"name": "shareBps", "label": "위임 비율", "type": "bps"}, {"name": "validFrom", "label": "시작일", "type": "date"}, {"name": "validTo", "label": "종료일", "type": "date"}]'::jsonb, '[{"clauseId": "parties", "heading": "당사자", "clauseType": "RIGHT_HOLDER", "fields": ["performer", "agency"], "text": "{{performer}}(이하 \"위임인\")는 {{agency}}(이하 \"수임인\")에게 이 곡에서 생기는 자기 실연 수익의 수령을 위임한다."}, {"clauseId": "mandate", "heading": "위임 범위", "clauseType": "MANDATE", "fields": ["shareBps"], "text": "수임인은 위임인 실연 수익의 {{shareBps}}를 위임인을 대신해 받는다. 나머지는 위임인에게 직접 지급한다."}, {"clauseId": "period", "heading": "기간", "clauseType": "PERIOD", "fields": ["validFrom", "validTo"], "text": "이 위임은 {{validFrom}}부터 {{validTo}}까지 유효하다."}, {"clauseId": "report", "heading": "정산 보고", "clauseType": "OTHER", "fields": [], "text": "수임인은 받은 금액과 위임인에게 전달한 금액을 위임인이 실연자 앱에서 확인할 수 있게 한다."}]'::jsonb, ARRAY['performer', 'agency'], 'APPROVED', true, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z'),
('tpl_platform_contract', 1, 'PLATFORM_CONTRACT', 'NONE', '플랫폼 이용계약', '[{"name": "holder", "label": "권리자", "type": "party"}, {"name": "validFrom", "label": "시작일", "type": "date"}, {"name": "validTo", "label": "종료일", "type": "date"}]'::jsonb, '[{"clauseId": "parties", "heading": "당사자", "clauseType": "RIGHT_HOLDER", "fields": ["holder"], "text": "{{holder}}(이하 \"권리자\")는 플랫폼에 곡을 등록하고 팬 조합 서비스로 유통하는 데 이 계약을 따른다."}, {"clauseId": "policy", "heading": "분배 정책", "clauseType": "SPLIT_RATE", "fields": [], "text": "권리자는 곡마다 분배 정책을 정하고, 플랫폼은 활성 정책과 봉인된 권리 사실에 따라서만 정산한다."}, {"clauseId": "period", "heading": "기간", "clauseType": "PERIOD", "fields": ["validFrom", "validTo"], "text": "이 계약은 {{validFrom}}부터 {{validTo}}까지 유효하다."}, {"clauseId": "evidence", "heading": "근거 문서", "clauseType": "OTHER", "fields": [], "text": "권리자는 등록한 권리의 근거 문서를 올리고, 플랫폼은 정합성 점검으로 빠진 근거를 알린다."}]'::jsonb, ARRAY['holder'], 'APPROVED', true, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z');

CREATE TABLE contract_envelope (
  contract_id      mdrl_id PRIMARY KEY,
  template_id      mdrl_id NOT NULL,
  template_version INT NOT NULL,
  facts_scope_id   mdrl_id NOT NULL REFERENCES facts_scope,
  answers          JSONB NOT NULL,
  title            TEXT NOT NULL,
  -- 서명 요청 때 만든 계약서(사람이 읽는 HTML)와 해시. 서명은 이 해시에 대해 받는다.
  rendered_html    TEXT NOT NULL,
  rendered_sha256  TEXT NOT NULL CHECK (rendered_sha256 ~ '^[0-9a-f]{64}$'),
  -- SENT(서명 대기) → SIGNED(모두 서명) → COMPLETED(서명본 원천 문서·기록 반영) | CANCELLED
  status           TEXT NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT','SIGNED','COMPLETED','CANCELLED')),
  provider         TEXT NOT NULL,
  provider_ref     TEXT NOT NULL,
  document_id      mdrl_id NULL,
  document_version INT NULL,
  records          JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_tenant_id  mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant,
  created_by       mdrl_id NOT NULL REFERENCES user_account,
  created_at       TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  completed_by     mdrl_id NULL REFERENCES user_account,
  completed_at     TIMESTAMPTZ NULL CHECK (completed_at = date_trunc('milliseconds', completed_at)),
  FOREIGN KEY (template_id, template_version) REFERENCES contract_template,
  FOREIGN KEY (document_id, document_version) REFERENCES source_document,
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE TABLE contract_signature (
  contract_id  mdrl_id NOT NULL REFERENCES contract_envelope,
  party_id     mdrl_id NOT NULL REFERENCES party,
  signer_var   TEXT NOT NULL,
  signed_at    TIMESTAMPTZ NULL CHECK (signed_at = date_trunc('milliseconds', signed_at)),
  signed_by    mdrl_id NULL REFERENCES user_account,
  -- 서명 방법: 공급자 이름(개발용 DEV_ESIGN 등). 플랫폼 밖 당사자는 공급자 통지로 들어온다(signed_by 없음).
  method       TEXT NULL,
  -- 계약을 만든 테넌트(정책이 서로를 참조하지 않도록 서명 행에도 둔다)
  owner_tenant_id mdrl_id NOT NULL REFERENCES tenant,
  PRIMARY KEY (contract_id, party_id),
  CHECK ((signed_at IS NULL) = (method IS NULL))
);
ALTER TABLE contract_envelope ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signature ENABLE ROW LEVEL SECURITY;
-- 보이는 범위: 만든 테넌트와 서명 당사자(파티의 테넌트·본인). 쓰기는 만든 테넌트, 서명·상태 변경은 서비스가 권한을 확인한 뒤 시스템 범위에서 한다.
CREATE POLICY envelope_read ON contract_envelope FOR SELECT USING (
  rc_owns(owner_tenant_id) OR EXISTS (SELECT 1 FROM contract_signature s WHERE s.contract_id = contract_envelope.contract_id AND rc_party_visible(s.party_id)));
CREATE POLICY envelope_insert ON contract_envelope FOR INSERT WITH CHECK (rc_can_write(owner_tenant_id));
CREATE POLICY envelope_update ON contract_envelope FOR UPDATE USING (current_setting('rc.scope', true) = 'system') WITH CHECK (current_setting('rc.scope', true) = 'system');
CREATE POLICY signature_read ON contract_signature FOR SELECT USING (rc_party_visible(party_id) OR rc_owns(owner_tenant_id));
CREATE POLICY signature_write ON contract_signature FOR INSERT WITH CHECK (current_setting('rc.scope', true) = 'system');
CREATE POLICY signature_update ON contract_signature FOR UPDATE USING (current_setting('rc.scope', true) = 'system') WITH CHECK (current_setting('rc.scope', true) = 'system');
GRANT SELECT, INSERT ON contract_envelope, contract_signature TO rc_app;
GRANT UPDATE (status, document_id, document_version, records, completed_by, completed_at) ON contract_envelope TO rc_app;
GRANT UPDATE (signed_at, signed_by, method) ON contract_signature TO rc_app;

