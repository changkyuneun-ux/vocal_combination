-- 총괄 역할(총괄 운영과 권한 구조 RS4, 결정 RD1): 참여 구분마다 그 구분에서 줄 수 있는 권한 전부.
-- 총괄은 한 계정이 플랫폼·권리 테넌트·참여 기관에 소속되어 소속마다 이 역할을 갖는다. 권리 결정 권한은 RIGHTS_ALL에만 있다(TR5).
-- 권한을 새로 더하는 마이그레이션은 그 참여 구분의 ALL 역할에도 넣는다(test/platform/super-admin.test.ts가 대조).
INSERT INTO role (role_id, name, org_class, system) VALUES
('PLATFORM_ALL', '플랫폼 총괄', 'PLATFORM', true),
('RIGHTS_ALL', '권리 테넌트 총괄', 'RIGHTS', true),
('PARTICIPANT_ALL', '참여 기관 총괄', 'PARTICIPANT', true);
INSERT INTO role_permission (role_id, perm_id)
SELECT r.role_id, p.perm_id FROM role r JOIN permission p ON r.org_class = ANY (p.org_classes) AND p.assignable
 WHERE r.role_id IN ('PLATFORM_ALL', 'RIGHTS_ALL', 'PARTICIPANT_ALL');
