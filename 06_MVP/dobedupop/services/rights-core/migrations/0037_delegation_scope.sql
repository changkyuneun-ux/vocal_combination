-- 테넌트 정책 3단계: 관리 이관(TN2), 위임 대행(TN6, 데이터모델 v2.8 tenant.ops_delegation·audit_log.acting_on_behalf_of), 데이터 범위 정리(TN7).

-- ── 관리 이관(TN2, TD6): 당사자의 관리 주체(party.tenant_id)만 바꿀 수 있다. 나머지 열은 그대로 불변이다 ─────────────
CREATE FUNCTION rc_party_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'party is append-only' USING ERRCODE = 'RC001'; END IF;
  IF (to_jsonb(NEW) - 'tenant_id') IS DISTINCT FROM (to_jsonb(OLD) - 'tenant_id') THEN
    RAISE EXCEPTION 'party: only the manager (tenant_id) may change' USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER party_immutable ON party;
CREATE TRIGGER party_guard BEFORE UPDATE OR DELETE ON party FOR EACH ROW EXECUTE FUNCTION rc_party_guard();

-- ── 위임 대행(TN6, TR5): 권리 테넌트가 명시적으로 맡긴 업무만 플랫폼 온보딩이 그 테넌트 권한으로 대행한다 ──────────────
-- RIGHTS_ENTRY = 권리 데이터(곡·녹음·슬롯·스템·보이스·권리 주장)와 원천 문서 등록 대행. 정책 편집·승인·활성화·발행은 위임할 수 없다.
ALTER TABLE tenant ADD COLUMN ops_delegation TEXT[] NOT NULL DEFAULT '{}' CHECK (ops_delegation <@ ARRAY['RIGHTS_ENTRY']::text[]);
GRANT UPDATE (ops_delegation) ON tenant TO rc_app;
-- 대행 중인 요청은 감사 로그에 대상 테넌트가 남는다(요청 범위 설정 rc.on_behalf_of).
ALTER TABLE audit_log ADD COLUMN acting_on_behalf_of TEXT NULL DEFAULT NULLIF(current_setting('rc.on_behalf_of', true), '');
ALTER TABLE user_session ADD COLUMN on_behalf_of mdrl_id NULL REFERENCES tenant;

-- ── 데이터 범위(TN7): 실연자 앱의 "나를 가리키는 권리 주장"을 공유 규칙으로 명시한다 ───────────────────────────
-- 개인 범위(rc.scope = party)에서 내 당사자가 보이스 주인(OWNED_BY)이거나, 내 스템·내 보이스의 실연 주장(PERFORMED_BY)이면 그 주장과
-- 그 곡·작품의 이름이 보인다. 판정은 SECURITY DEFINER 함수로(정책 식이 다시 RLS를 타지 않게).
CREATE FUNCTION rc_claim_names_me(edge text, source text, target text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT current_setting('rc.scope', true) = 'party' AND NULLIF(current_setting('rc.party_id', true), '') IS NOT NULL AND (
       (edge = 'OWNED_BY' AND target = current_setting('rc.party_id', true))
    OR (edge = 'PERFORMED_BY' AND (
          EXISTS (SELECT 1 FROM stem s WHERE s.stem_id = source AND s.performer_party_id = current_setting('rc.party_id', true))
       OR EXISTS (SELECT 1 FROM right_claim o WHERE o.source_id = target AND o.edge = 'OWNED_BY' AND o.target_id = current_setting('rc.party_id', true) AND o.superseded_at IS NULL))))
$$;
CREATE FUNCTION rc_scope_names_me(s text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT current_setting('rc.scope', true) = 'party' AND EXISTS (
    SELECT 1 FROM right_claim c WHERE c.facts_scope_id = s AND c.superseded_at IS NULL AND rc_claim_names_me(c.edge, c.source_id, c.target_id))
$$;
CREATE FUNCTION rc_work_names_me(w text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT current_setting('rc.scope', true) = 'party' AND EXISTS (SELECT 1 FROM facts_scope f WHERE f.work_id = w AND rc_scope_names_me(f.facts_scope_id))
$$;
CREATE POLICY names_me ON right_claim FOR SELECT USING (rc_claim_names_me(edge, source_id, target_id));
CREATE POLICY names_me ON facts_scope FOR SELECT USING (rc_scope_names_me(facts_scope_id));
CREATE POLICY names_me ON work FOR SELECT USING (rc_work_names_me(work_id));
