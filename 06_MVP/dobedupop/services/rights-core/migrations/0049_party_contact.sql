-- 우리 당사자 등록(2026-10-26, 시안 Ops-Org-Parties): 국가·구분(세금 계산 기본값)과 연락 이메일(계정 없는 당사자의 전자서명 링크).
-- 둘 다 선택 값이다. 기존 당사자는 비어 있다.
ALTER TABLE party ADD COLUMN country_class TEXT NULL CHECK (country_class IN ('FOREIGN_INDIVIDUAL','DOMESTIC_INDIVIDUAL','DOMESTIC_CORP'));
ALTER TABLE party ADD COLUMN contact_email TEXT NULL CHECK (contact_email IS NULL OR contact_email ~ '^[^@\s]+@[^@\s]+$');
