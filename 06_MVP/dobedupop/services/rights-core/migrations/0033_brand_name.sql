-- 서비스 이름 표기 통일(2026-10-16): dobedubpop → dobedupop. 0017이 넣은 플랫폼 운영 테넌트 이름을 바꾼다.
UPDATE tenant SET name = 'dobedupop 플랫폼 운영' WHERE tenant_id = 'tnt_platform' AND name = 'dobedubpop 플랫폼 운영';
