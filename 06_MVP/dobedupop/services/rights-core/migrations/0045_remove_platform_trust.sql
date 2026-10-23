-- 플랫폼 위탁 폐지(결정 WD1~WD4, 2026-10-23): 플랫폼은 권리자·권리를 만들거나 확정하지 않는다. 권리와 그 당사자는 권리 테넌트가 관리한다.
-- 1) 원문 대조 확정·플랫폼 쪽 연결 권한을 없앤다(WD3). 확인 요청의 PLATFORM_VERIFIED 상태 값은 지난 기록을 위해 남긴다(새로 생기지 않는다).
-- 2) 권리 테넌트가 관리하는 당사자의 지급 정보를 등록하는 권한(WD4).
-- 3) 권리 확인서 템플릿의 불러오기 연결(importId)을 선택으로 — 불러오기 없이 보낸 확인서도 같은 템플릿을 쓴다.
-- 4) 기존 데이터: 플랫폼 소속으로 남은 당사자 중 한 권리 테넌트의 곡에만 권리 주장이 있는 당사자는 그 권리 테넌트 관리로 옮긴다(WD1).
DELETE FROM role_permission WHERE perm_id IN ('confirmation.platform_verify', 'link.decide_platform');
DELETE FROM delegable_task_permission WHERE perm_id IN ('confirmation.platform_verify', 'link.decide_platform');
DELETE FROM permission WHERE perm_id IN ('confirmation.platform_verify', 'link.decide_platform');
UPDATE permission SET description = '개인·참여 기관 당사자 등록(플랫폼 관리 당사자 없음)' WHERE perm_id = 'party.register_platform';
INSERT INTO permission (perm_id, area, kind, org_classes, assignable, description) VALUES
('payout.profile_own','⑥','decide','{RIGHTS}',true,'관리하는 당사자의 지급 정보 등록(결정 WD4)');
INSERT INTO role_permission (role_id, perm_id) VALUES ('TENANT_ADMIN','payout.profile_own'), ('RIGHTS_ALL','payout.profile_own');
UPDATE contract_template SET variables = jsonb_path_query_array(variables, '$[*] ? (@.name != "importId")') || '[{"name": "importId", "label": "불러오기", "type": "text", "optional": true}]'::jsonb WHERE template_id IN ('tpl_claim_confirm_label', 'tpl_claim_confirm_author');
UPDATE party p SET tenant_id = m.owner FROM (
  SELECT c.target_id AS party_id, min(s.owner_tenant_id) AS owner FROM right_claim c JOIN facts_scope s ON s.facts_scope_id = c.facts_scope_id JOIN tenant t ON t.tenant_id = s.owner_tenant_id
   WHERE t.org_class = 'RIGHTS' GROUP BY c.target_id HAVING count(DISTINCT s.owner_tenant_id) = 1) m
 WHERE p.party_id = m.party_id AND p.tenant_id = 'tnt_platform' AND p.party_type <> 'PLATFORM';
