-- 원천 문서를 곡에 묶는다(2026-10-24 곡 절차 정리, 디자인 가이드 4절).
-- facts_scope_id = 이 문서가 근거·서명본인 곡. NULL = 작품 공통(조직 문서: KYB·플랫폼 이용계약 등).
-- 근거 문서는 그 곡(또는 작품 공통) 문서만 쓸 수 있다 — 다른 곡 문서를 근거로 연결하면 422 EVIDENCE_OTHER_SONG.
ALTER TABLE source_document ADD COLUMN facts_scope_id mdrl_id NULL REFERENCES facts_scope;
CREATE INDEX source_document_scope ON source_document (facts_scope_id);

-- 기존 문서: 표준 계약 서명본은 그 계약의 곡, 직접 올린 문서는 근거로 쓰인 기록의 곡(한 곡뿐일 때). 그 밖(조직 문서)은 작품 공통.
UPDATE source_document d SET facts_scope_id = c.facts_scope_id
  FROM contract_envelope c WHERE d.document_id = 'doc_' || c.contract_id AND d.facts_scope_id IS NULL;
UPDATE source_document d SET facts_scope_id = c.facts_scope_id
  FROM consent_agreement c WHERE d.document_id = 'doc_' || c.consent_id AND d.facts_scope_id IS NULL;
UPDATE source_document d SET facts_scope_id = s.scope FROM (
  SELECT e.document_id, min(x.facts_scope_id) AS scope FROM record_evidence e
    JOIN (SELECT claim_id AS id, version, facts_scope_id, 'CLAIM' AS t FROM right_claim UNION ALL SELECT mandate_id, version, facts_scope_id, 'MANDATE' FROM mandate) x
      ON x.t = e.record_type AND x.id = e.record_id AND x.version = e.record_version
   GROUP BY e.document_id HAVING count(DISTINCT x.facts_scope_id) = 1) s
 WHERE d.document_id = s.document_id AND d.facts_scope_id IS NULL AND d.kind <> 'PLATFORM_CONTRACT';
