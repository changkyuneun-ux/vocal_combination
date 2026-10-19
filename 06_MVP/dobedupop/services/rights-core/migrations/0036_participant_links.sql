-- 테넌트 정책 2단계: 참여 기관의 연결 열쇠(4절, 결정 TD10·TD11·TD12, 진행 TN8~TN10).
-- 참여 기관(신탁단체·유통 파트너)은 권리를 만들지 않고, 양쪽이 확인한 연결로만 권리·정산에 닿는다.

CREATE TABLE participant_link (
  link_id               mdrl_id PRIMARY KEY,
  -- TRUST: 작가 ↔ 신탁단체(신탁 범위의 작품 몫을 신탁단체가 받는다). DISTRIBUTION: 권리 테넌트 ↔ 유통 파트너(유통 계약).
  link_type             TEXT NOT NULL CHECK (link_type IN ('TRUST','DISTRIBUTION')),
  participant_tenant_id mdrl_id NOT NULL REFERENCES tenant,
  author_party_id       mdrl_id NULL REFERENCES party,   -- TRUST: 신탁한 작가
  payee_party_id        mdrl_id NULL REFERENCES party,   -- TRUST: 신탁단체의 수령 당사자
  rights_tenant_id      mdrl_id NULL REFERENCES tenant,  -- DISTRIBUTION: 유통 계약의 권리 테넌트. TRUST: 연결을 제안한 권리 테넌트(있으면)
  member_ref            TEXT NULL,                       -- 신탁 회원번호·IPI
  usage_media           TEXT[] NULL,                     -- 신탁 범위(이용 매체, 예: FAN_APP). 비우면 전부
  valid_from            TIMESTAMPTZ NOT NULL CHECK (valid_from = date_trunc('milliseconds', valid_from)),
  valid_to              TIMESTAMPTZ NULL CHECK (valid_to = date_trunc('milliseconds', valid_to)),
  evidence_document_id  mdrl_id NULL,                    -- 신탁 계약·유통 계약 원천 문서
  status                TEXT NOT NULL CHECK (status IN ('PROPOSED','ACTIVE','DECLINED','ENDED')),
  proposed_side         TEXT NOT NULL CHECK (proposed_side IN ('RIGHTS','PARTICIPANT')),
  proposed_by           mdrl_id NOT NULL REFERENCES user_account,
  proposed_at           TIMESTAMPTZ NOT NULL,
  decided_by            mdrl_id NULL REFERENCES user_account,
  decided_at            TIMESTAMPTZ NULL,
  decline_reason        TEXT NULL,
  ended_by              mdrl_id NULL REFERENCES user_account,
  ended_at              TIMESTAMPTZ NULL,
  end_reason            TEXT NULL,
  CHECK ((link_type = 'TRUST') = (author_party_id IS NOT NULL AND payee_party_id IS NOT NULL)),
  CHECK (link_type <> 'DISTRIBUTION' OR rights_tenant_id IS NOT NULL),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- 한 작가는 한 신탁단체에만, 한 권리 테넌트–유통 파트너 쌍은 하나만 열려 있다.
CREATE UNIQUE INDEX participant_link_trust_open ON participant_link (author_party_id) WHERE link_type = 'TRUST' AND status IN ('PROPOSED','ACTIVE');
CREATE UNIQUE INDEX participant_link_dist_open ON participant_link (participant_tenant_id, rights_tenant_id) WHERE link_type = 'DISTRIBUTION' AND status IN ('PROPOSED','ACTIVE');
CREATE INDEX participant_link_participant ON participant_link (participant_tenant_id);

-- 연결 기록은 양쪽과 플랫폼이 본다: 참여 기관, 유통 계약·제안의 권리 테넌트, 신탁한 작가의 관리 주체.
ALTER TABLE participant_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY link_sides ON participant_link USING (
  rc_sees_all() OR participant_tenant_id = rc_tenant() OR rights_tenant_id = rc_tenant() OR (author_party_id IS NOT NULL AND rc_party_visible(author_party_id))
);
GRANT SELECT, INSERT ON participant_link TO rc_app;
GRANT UPDATE (status, decided_by, decided_at, decline_reason, ended_by, ended_at, end_reason) ON participant_link TO rc_app;

-- ── 연결 열쇠로 보이는 권리 데이터(필요한 항목만) ────────────────────────────────────────────────
-- 신탁단체: 신탁 연결이 활성인 작가의 작품 몫 주장(WRITTEN_BY)과 그 곡·작품 정보만. 녹음·실연·레이블 몫·계약서는 보이지 않는다.
-- 정책 식이 다시 RLS를 타지 않도록 판정은 SECURITY DEFINER 함수(테이블 소유자 권한)로 한다.
CREATE FUNCTION rc_trusted_author(p text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM participant_link l WHERE l.link_type = 'TRUST' AND l.status = 'ACTIVE' AND l.author_party_id = p
                   AND l.participant_tenant_id = NULLIF(current_setting('rc.tenant_id', true), ''))
$$;
CREATE FUNCTION rc_trust_scope(s text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM right_claim c JOIN participant_link l ON l.author_party_id = c.target_id
                  WHERE c.facts_scope_id = s AND c.edge = 'WRITTEN_BY' AND c.superseded_at IS NULL
                    AND l.link_type = 'TRUST' AND l.status = 'ACTIVE' AND l.participant_tenant_id = NULLIF(current_setting('rc.tenant_id', true), ''))
$$;
CREATE FUNCTION rc_trust_work(w text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM facts_scope s WHERE s.work_id = w AND rc_trust_scope(s.facts_scope_id))
$$;
CREATE POLICY trust_read ON right_claim FOR SELECT USING (edge = 'WRITTEN_BY' AND rc_trusted_author(target_id));
CREATE POLICY trust_read ON facts_scope FOR SELECT USING (rc_trust_scope(facts_scope_id));
CREATE POLICY trust_read ON work FOR SELECT USING (rc_trust_work(work_id));

-- ── 유통 파트너의 상품 대응: 파트너가 제안하고 권리 테넌트가 확인한다(TD10) ─────────────────────────────
-- 기존 행과 운영이 직접 등록한 대응(운영 대행)은 CONFIRMED다. 리포트 적용은 CONFIRMED만 쓴다.
ALTER TABLE partner_asset ADD COLUMN status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('PROPOSED','CONFIRMED','DECLINED'));
ALTER TABLE partner_asset ADD COLUMN link_id mdrl_id NULL REFERENCES participant_link;
ALTER TABLE partner_asset ADD COLUMN decided_by mdrl_id NULL REFERENCES user_account, ADD COLUMN decided_at TIMESTAMPTZ NULL;
-- 파트너는 자기 테넌트로 제안(PROPOSED)만 넣는다. 확인은 권리 테넌트 요청을 서비스가 시스템 범위로 반영한다.
CREATE POLICY partner_propose ON partner_asset FOR INSERT WITH CHECK (tenant_id = rc_tenant() AND status = 'PROPOSED');
GRANT UPDATE (status, decided_by, decided_at) ON partner_asset TO rc_app;

-- 신탁 연결로 자동 기록한 작품 몫 위임(TD11)은 source_ref = 'link:<link_id>'로 표시한다(별도 열 없음).
