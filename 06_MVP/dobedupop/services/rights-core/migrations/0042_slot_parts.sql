-- 슬롯(원곡 흐름 구간)과 파트(그 구간의 원곡 트랙). 결정 SL1·SL6·SL7, 진행 SL-S1.
-- 2차 이용(조합)은 슬롯·파트마다 스템을 고르는 배치다. 기존 슬롯은 파트 1로 옮기므로 기존 데이터·금액은 그대로다.
ALTER TABLE part_slot ADD COLUMN section_label TEXT NULL;

CREATE TABLE slot_part (
  slot_id           mdrl_id NOT NULL REFERENCES part_slot,
  part_no           INT NOT NULL CHECK (part_no >= 1),
  kind              TEXT NOT NULL CHECK (kind IN ('VOCAL','GROUP','INSTRUMENT')),
  role              TEXT NULL CHECK (role IN ('LEAD','HARMONY','ADLIB','UNISON','RAP')),
  start_ms          INT NOT NULL,
  end_ms            INT NOT NULL,
  duration_ms       INT GENERATED ALWAYS AS (end_ms - start_ms) STORED,
  original_party_id mdrl_id NULL REFERENCES party,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slot_id, part_no),
  CHECK (end_ms > start_ms),
  CHECK ((kind = 'VOCAL') = (original_party_id IS NOT NULL))
);
-- 파트 시각은 슬롯 안이어야 한다.
CREATE FUNCTION rc_slot_part_within() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s part_slot;
BEGIN
  SELECT * INTO s FROM part_slot WHERE slot_id = NEW.slot_id;
  IF NEW.start_ms < s.start_ms OR NEW.end_ms > s.end_ms THEN
    RAISE EXCEPTION 'PART_OUTSIDE_SLOT: part %/% (% ~ %) is outside slot (% ~ %)', NEW.slot_id, NEW.part_no, NEW.start_ms, NEW.end_ms, s.start_ms, s.end_ms;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER slot_part_within BEFORE INSERT OR UPDATE ON slot_part FOR EACH ROW EXECUTE FUNCTION rc_slot_part_within();

-- 소유 열쇠(0017·0019와 같은 방식): 부모 슬롯에 쓸 수 있어야 붙인다.
ALTER TABLE slot_part ADD COLUMN owner_tenant_id mdrl_id NOT NULL DEFAULT rc_owner_default() REFERENCES tenant;
CREATE INDEX slot_part_owner ON slot_part (owner_tenant_id);
ALTER TABLE slot_part ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON slot_part FOR SELECT USING (rc_owns(owner_tenant_id));
CREATE POLICY owner_insert ON slot_part FOR INSERT
  WITH CHECK (rc_can_write(owner_tenant_id) AND EXISTS (SELECT 1 FROM part_slot p WHERE p.slot_id = slot_part.slot_id AND rc_can_write(p.owner_tenant_id)));
CREATE POLICY owner_update ON slot_part FOR UPDATE USING (rc_owns(owner_tenant_id)) WITH CHECK (rc_can_write(owner_tenant_id));
CREATE POLICY owner_delete ON slot_part FOR DELETE USING (rc_can_write(owner_tenant_id));
GRANT SELECT, INSERT ON slot_part TO rc_app;

-- 기존 슬롯 → 파트 1. 권리 부담 스템의 실연자가 한 명이면 그 사람이 원곡 담당(VOCAL), 아니면 반주(INSTRUMENT).
-- 원곡 담당은 이름 규칙(slt_part_<멤버> ↔ stm_<부른 멤버>_<멤버>)으로 찾고, 맞는 스템이 없으면 반주로 둔다.
INSERT INTO slot_part (slot_id, part_no, kind, role, start_ms, end_ms, original_party_id, created_at, owner_tenant_id)
SELECT s.slot_id, 1,
       CASE WHEN o.party_id IS NULL THEN 'INSTRUMENT' ELSE 'VOCAL' END,
       CASE WHEN o.party_id IS NULL THEN NULL ELSE 'LEAD' END,
       s.start_ms, s.end_ms, o.party_id, now(), s.owner_tenant_id
  FROM part_slot s
  LEFT JOIN LATERAL (
    SELECT st.performer_party_id AS party_id FROM stem st
     WHERE st.slot_id = s.slot_id AND st.rights_bearing AND st.performer_party_id IS NOT NULL
       AND s.slot_id LIKE 'slt\_part\_%'
       AND st.stem_id = 'stm_' || replace(s.slot_id, 'slt_part_', '') || '_' || replace(s.slot_id, 'slt_part_', '')
     LIMIT 1) o ON true;

-- 스템·발행 배정 → 파트 1. 두 표는 수정 금지 트리거가 있어 이전하는 동안만 끈다.
ALTER TABLE stem ADD COLUMN part_no INT NULL DEFAULT 1;
ALTER TABLE stem DISABLE TRIGGER stem_immutable;
UPDATE stem SET part_no = 1;
ALTER TABLE stem ENABLE TRIGGER stem_immutable;
ALTER TABLE stem ADD CONSTRAINT stem_part_fkey FOREIGN KEY (slot_id, part_no) REFERENCES slot_part (slot_id, part_no);
ALTER TABLE stem ALTER COLUMN part_no SET NOT NULL;

ALTER TABLE snapshot_stem_assignment ADD COLUMN part_no INT NULL DEFAULT 1;
ALTER TABLE snapshot_stem_assignment DISABLE TRIGGER snapshot_stem_assignment_immutable;
UPDATE snapshot_stem_assignment SET part_no = 1;
ALTER TABLE snapshot_stem_assignment ENABLE TRIGGER snapshot_stem_assignment_immutable;
ALTER TABLE snapshot_stem_assignment ALTER COLUMN part_no SET NOT NULL;
ALTER TABLE snapshot_stem_assignment DROP CONSTRAINT snapshot_stem_assignment_pkey;
ALTER TABLE snapshot_stem_assignment ADD PRIMARY KEY (snapshot_id, slot_id, part_no);
