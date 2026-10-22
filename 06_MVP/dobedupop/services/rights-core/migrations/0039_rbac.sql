-- 기능–권한–역할(총괄 운영과 권한 구조 20261022, 결정 RD4·진행 RS1).
-- 권한 목록은 src/platform/permissions.ts가 원본이고 이 표는 그 사본이다(test/platform/rbac.test.ts가 대조).
-- 역할과 역할–권한은 DB가 원본이다. 배정은 portal_role(계정·소속·역할)을 그대로 쓴다.
CREATE TABLE permission (
  perm_id     TEXT PRIMARY KEY CHECK (perm_id ~ '^[a-z]+\.[a-z_]+$'),
  area        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('decide','view','intervene','admin','system')),
  org_classes TEXT[] NOT NULL CHECK (cardinality(org_classes) > 0 AND org_classes <@ ARRAY['RIGHTS','PARTICIPANT','INDIVIDUAL','PLATFORM']),
  assignable  BOOLEAN NOT NULL DEFAULT true,
  description TEXT NOT NULL
);
-- legacy = 이 마이그레이션 전부터 있던 역할(참여 구분 없음, 부여 범위는 앱의 assignableRoles가 정한다). 새 역할은 참여 구분이 있어야 한다.
CREATE TABLE role (
  role_id   TEXT PRIMARY KEY CHECK (role_id ~ '^[A-Z][A-Z_]*$'),
  name      TEXT NOT NULL,
  org_class TEXT NULL CHECK (org_class IN ('RIGHTS','PARTICIPANT','INDIVIDUAL','PLATFORM')),
  system    BOOLEAN NOT NULL DEFAULT false,
  legacy    BOOLEAN NOT NULL DEFAULT false,
  CHECK (legacy OR org_class IS NOT NULL)
);
CREATE TABLE role_permission (
  role_id TEXT NOT NULL REFERENCES role ON DELETE CASCADE,
  perm_id TEXT NOT NULL REFERENCES permission,
  PRIMARY KEY (role_id, perm_id)
);
-- 위임 대행 업무(TN6) → 권한. 지금은 RIGHTS_ENTRY 하나.
CREATE TABLE delegable_task_permission (
  task    TEXT NOT NULL,
  perm_id TEXT NOT NULL REFERENCES permission,
  PRIMARY KEY (task, perm_id)
);

-- 역할에 넣는 권한은 그 역할의 참여 구분에서 쓸 수 있어야 하고(TR5: 권리 결정 권한은 PLATFORM 역할에 못 넣는다), 사람에게 줄 수 있어야 한다.
CREATE FUNCTION rc_role_permission_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r role; p permission;
BEGIN
  SELECT * INTO r FROM role WHERE role_id = NEW.role_id;
  SELECT * INTO p FROM permission WHERE perm_id = NEW.perm_id;
  IF r.legacy THEN RETURN NEW; END IF;
  IF NOT (r.org_class = ANY (p.org_classes)) THEN
    RAISE EXCEPTION 'ROLE_CLASS_MISMATCH: % (%) cannot hold % (%)', r.role_id, r.org_class, p.perm_id, p.org_classes;
  END IF;
  IF NOT p.assignable THEN RAISE EXCEPTION 'PERMISSION_NOT_ASSIGNABLE: %', p.perm_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_permission_check BEFORE INSERT OR UPDATE ON role_permission FOR EACH ROW EXECUTE FUNCTION rc_role_permission_check();

INSERT INTO role (role_id, name, legacy, system) VALUES
('RIGHTS_EDITOR','권리 편집',true,false), ('EDITOR','정책 편집',true,false), ('WORK_APPROVER','정책 승인',true,false), ('ACTIVATOR','활성화',true,false),
('ISSUER','발행(팬 대행)',true,true), ('SPACE_OPS','운영',true,false), ('SPACE_SETTLE','정산',true,false), ('SYSTEM','시스템 신원',true,true),
('PERFORMER','실연자',true,false), ('COMPLIANCE','컴플라이언스',true,false), ('LEGAL','법무',true,false), ('TENANT_ADMIN','조직 관리자',true,false),
('ONBOARDING','온보딩',true,false), ('TRUST_OFFICER','신탁 담당',true,false), ('PARTNER_INTEGRATION','연동 담당',true,false);

INSERT INTO permission (perm_id, area, kind, org_classes, assignable, description) VALUES
('ledger.view','⑥','view','{PLATFORM}',true,'원장·시산표·권리자 명세 조회'),
('settlement.view','⑥','view','{PLATFORM}',true,'정산 배치·run·격리·보류 조회'),
('settlement.batch_create','⑥','intervene','{PLATFORM}',true,'정산 배치 만들기'),
('settlement.operate','⑥','intervene','{PLATFORM}',true,'run 무효·재처리, 보류·격리 해제, 불변식 점검'),
('settlement.confirm','⑥','intervene','{PLATFORM}',true,'정산 배치 확정'),
('payout.view','⑥','view','{PLATFORM}',true,'지급 run·지시·지급 정보 조회'),
('payout.run','⑥','intervene','{PLATFORM}',true,'지급 실행·재지시'),
('payout.profile_set','⑥','intervene','{PLATFORM}',true,'지급 정보(계좌 토큰·세금·KYC) 등록'),
('revenue.view','⑥','view','{PLATFORM}',true,'매출 이벤트 조회'),
('revenue.ingest','⑥','system','{PLATFORM}',false,'매출 수집(시스템 신원)'),
('traffic.view','⑥','view','{PLATFORM}',true,'감상 수익 풀 조회'),
('traffic.manage','⑥','intervene','{PLATFORM}',true,'감상 수익 풀 등록·배정'),
('hub.view','⑥','view','{PLATFORM}',true,'연동 허브 파일·거부 큐 조회'),
('hub.operate','⑥','intervene','{PLATFORM}',true,'연동 허브 재처리·상품 대응'),
('audio.review','⑤','intervene','{PLATFORM}',true,'스템 오디오 검토·참조 음원 등록·렌더 검증'),
('validation.request_accept','⑤','intervene','{PLATFORM}',true,'정합성 이슈 위험 수용 요청'),
('validation.accept','⑤','intervene','{PLATFORM}',true,'정합성 이슈 위험 수용 승인·기각'),
('validation.operate','⑤','intervene','{PLATFORM}',true,'정합성 차단 적용 설정·정기 검사'),
('confirmation.platform_verify','⑤','intervene','{PLATFORM}',true,'확인 요청 원문 대조 확인'),
('document.dispose','⑤','intervene','{PLATFORM}',true,'원천 문서 폐기'),
('audit.view','⑦','view','{PLATFORM,RIGHTS,PARTICIPANT}',true,'감사 로그 조회'),
('inspection.unmask','⑦','admin','{PLATFORM}',true,'계좌 토큰 마스킹 해제(사유)'),
('breakglass.open','⑦','admin','{PLATFORM}',true,'break-glass 열기'),
('tenant.onboard','⑦','admin','{PLATFORM}',true,'조직 등록·정보·확인 항목·활성화, 당사자 이관, 독립 아티스트 온보딩'),
('tenant.suspend','⑦','admin','{PLATFORM}',true,'조직 정지·해지·재개'),
('staff.manage','⑦','admin','{PLATFORM}',true,'운영 인력 계정·잠금'),
('account.onboard','⑦','admin','{PLATFORM}',true,'개인 계정과 조직의 첫 관리자 발급'),
('account.manage','⑦','admin','{RIGHTS,PARTICIPANT}',true,'자기 조직 담당자 계정·역할·잠금'),
('delegation.act','⑦','admin','{PLATFORM}',true,'위임받은 테넌트 업무 대행'),
('delegation.set','⑦','admin','{RIGHTS}',true,'플랫폼에 맡길 업무 정하기'),
('org.view_while_inactive','⑦','view','{RIGHTS,PARTICIPANT}',true,'신청·정지 상태 조직에 열람으로 로그인'),
('legal.template','⑦','admin','{PLATFORM}',true,'계약·분배 규칙 표준 템플릿 작성·승인'),
('party.register_platform','①','admin','{PLATFORM}',true,'플랫폼 위탁 당사자 등록'),
('rights.edit','①','decide','{RIGHTS}',true,'곡·녹음·스템·권리 주장·위임·원천 문서 등록'),
('consent.record','①','decide','{RIGHTS}',true,'계약서 기반 이용허락 동의 기록·철회'),
('contract.draft','①','decide','{RIGHTS}',true,'표준 계약 작성'),
('contract.sign_org','①','decide','{RIGHTS}',true,'자기 테넌트 당사자로 계약 서명'),
('link.decide','①','decide','{RIGHTS}',true,'권리 테넌트 쪽 연결·상품 대응 제안·확인'),
('link.decide_platform','①','intervene','{PLATFORM}',true,'플랫폼 쪽 연결 제안·확인(위탁 당사자)'),
('link.decide_trust','①','decide','{PARTICIPANT}',true,'신탁단체 쪽 연결 제안·확인'),
('link.decide_partner','①','decide','{PARTICIPANT}',true,'유통 파트너 쪽 연결 제안·확인'),
('asset.propose','①','intervene','{PARTICIPANT}',true,'유통 파트너의 상품 대응 제안'),
('pack.edit','②','decide','{RIGHTS}',true,'팩 만들기·청구권자 선언'),
('pack.activate','②','decide','{RIGHTS}',true,'팩 활성화'),
('policy.edit','②','decide','{RIGHTS}',true,'분배 규칙 작성·컴파일'),
('policy.approve','②','decide','{RIGHTS}',true,'분배 규칙 승인'),
('policy.activate','②','decide','{RIGHTS}',true,'분배 규칙 활성화·재고정'),
('issuance.issue','③','system','{INDIVIDUAL}',false,'조합 발행(팬 대행)'),
('performer.self','④','decide','{INDIVIDUAL}',true,'본인 동의·서명·철회, 실연자 채널');

INSERT INTO role_permission (role_id, perm_id) VALUES
('SPACE_SETTLE','ledger.view'), ('SPACE_OPS','settlement.view'), ('SPACE_SETTLE','settlement.view'), ('SPACE_OPS','settlement.batch_create'),
('SPACE_SETTLE','settlement.operate'), ('SPACE_SETTLE','settlement.confirm'), ('SPACE_SETTLE','payout.view'), ('SPACE_SETTLE','payout.run'),
('SPACE_SETTLE','payout.profile_set'), ('SPACE_OPS','revenue.view'), ('SPACE_SETTLE','revenue.view'), ('SYSTEM','revenue.view'), ('SYSTEM','revenue.ingest'),
('SPACE_OPS','traffic.view'), ('SPACE_SETTLE','traffic.view'), ('SPACE_SETTLE','traffic.manage'), ('SPACE_OPS','hub.view'), ('SPACE_SETTLE','hub.view'),
('SPACE_OPS','hub.operate'), ('SPACE_OPS','audio.review'), ('SPACE_OPS','validation.request_accept'), ('COMPLIANCE','validation.accept'),
('SPACE_OPS','validation.operate'), ('SPACE_OPS','confirmation.platform_verify'), ('SPACE_OPS','document.dispose'),
('SPACE_OPS','audit.view'), ('SPACE_SETTLE','audit.view'), ('RIGHTS_EDITOR','audit.view'), ('ONBOARDING','audit.view'), ('COMPLIANCE','audit.view'), ('TENANT_ADMIN','audit.view'),
('SPACE_SETTLE','inspection.unmask'), ('SPACE_OPS','breakglass.open'), ('SPACE_OPS','tenant.onboard'), ('ONBOARDING','tenant.onboard'),
('SPACE_OPS','tenant.suspend'), ('COMPLIANCE','tenant.suspend'), ('SPACE_OPS','staff.manage'), ('SPACE_OPS','account.onboard'), ('ONBOARDING','account.onboard'),
('TENANT_ADMIN','account.manage'), ('ONBOARDING','delegation.act'), ('TENANT_ADMIN','delegation.set'), ('TENANT_ADMIN','org.view_while_inactive'),
('LEGAL','legal.template'), ('ONBOARDING','party.register_platform'), ('RIGHTS_EDITOR','party.register_platform'),
('RIGHTS_EDITOR','rights.edit'), ('RIGHTS_EDITOR','consent.record'), ('RIGHTS_EDITOR','contract.draft'), ('RIGHTS_EDITOR','contract.sign_org'),
('RIGHTS_EDITOR','link.decide'), ('TENANT_ADMIN','link.decide'), ('ONBOARDING','link.decide_platform'), ('SPACE_OPS','link.decide_platform'),
('TRUST_OFFICER','link.decide_trust'), ('TENANT_ADMIN','link.decide_trust'), ('PARTNER_INTEGRATION','link.decide_partner'), ('TENANT_ADMIN','link.decide_partner'),
('PARTNER_INTEGRATION','asset.propose'), ('TENANT_ADMIN','asset.propose'), ('RIGHTS_EDITOR','pack.edit'), ('ACTIVATOR','pack.activate'),
('EDITOR','policy.edit'), ('WORK_APPROVER','policy.approve'), ('ACTIVATOR','policy.activate'), ('ISSUER','issuance.issue'), ('PERFORMER','performer.self');

INSERT INTO delegable_task_permission (task, perm_id) VALUES ('RIGHTS_ENTRY', 'rights.edit');

-- 배정: 역할 이름 CHECK 대신 role 표를 가리킨다. 참여 구분이 있는 역할은 같은 참여 구분의 소속에만 준다.
ALTER TABLE portal_role DROP CONSTRAINT portal_role_role_check;
ALTER TABLE portal_role ADD CONSTRAINT portal_role_role_fkey FOREIGN KEY (role) REFERENCES role (role_id);
CREATE FUNCTION rc_portal_role_class() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rc TEXT; tc TEXT;
BEGIN
  SELECT org_class INTO rc FROM role WHERE role_id = NEW.role;
  IF rc IS NULL THEN RETURN NEW; END IF;
  SELECT org_class INTO tc FROM tenant WHERE tenant_id = NEW.tenant_id;
  IF rc <> tc THEN RAISE EXCEPTION 'ROLE_CLASS_MISMATCH: % (%) cannot be given in % (%)', NEW.role, rc, NEW.tenant_id, tc; END IF;
  RETURN NEW;
END $$;
-- portal_role_home_tenant(BEFORE INSERT)가 tenant_id를 채운 뒤에 돌도록 이름 순서(z)를 둔다.
CREATE TRIGGER portal_role_z_class BEFORE INSERT OR UPDATE ON portal_role FOR EACH ROW EXECUTE FUNCTION rc_portal_role_class();

GRANT SELECT ON permission, role, role_permission, delegable_task_permission TO rc_app;
