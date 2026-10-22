-- IR 생성(첫 facts 봉인) 전 카탈로그 수정·삭제(결정 ID1). 봉인된 적이 있는 곡의 행은 지금처럼 바꿀 수 없다.
-- 0042가 기존 코드를 살리려고 둔 part_no 기본값을 지운다(이제 INSERT가 part_no를 넣는다).
ALTER TABLE stem ALTER COLUMN part_no DROP DEFAULT;
ALTER TABLE snapshot_stem_assignment ALTER COLUMN part_no DROP DEFAULT;

-- 행 → 곡의 범위가 봉인된 적이 있는가.
CREATE FUNCTION rc_scope_sealed_for(tbl TEXT, r jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE w TEXT;
BEGIN
  w := CASE tbl
    WHEN 'work' THEN r->>'work_id'
    WHEN 'recording_version' THEN r->>'work_id'
    WHEN 'part_slot' THEN (SELECT work_id FROM recording_version WHERE recording_id = r->>'recording_id')
    WHEN 'slot_part' THEN (SELECT rv.work_id FROM part_slot s JOIN recording_version rv ON rv.recording_id = s.recording_id WHERE s.slot_id = r->>'slot_id')
    WHEN 'stem' THEN (SELECT work_id FROM recording_version WHERE recording_id = r->>'recording_id')
    WHEN 'voice' THEN (SELECT work_id FROM facts_scope WHERE facts_scope_id = r->>'facts_scope_id')
  END;
  RETURN EXISTS (SELECT 1 FROM facts_scope WHERE work_id = w AND sealed_through IS NOT NULL);
END $$;

CREATE FUNCTION rc_mutable_before_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF rc_scope_sealed_for(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'CATALOG_SEALED: % % rejected — the song''s facts are sealed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'RC001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER work_immutable ON work;
DROP TRIGGER recording_immutable ON recording_version;
DROP TRIGGER part_slot_immutable ON part_slot;
DROP TRIGGER stem_immutable ON stem;
DROP TRIGGER voice_immutable ON voice;
CREATE TRIGGER work_mutable_before_seal BEFORE UPDATE OR DELETE ON work FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER recording_mutable_before_seal BEFORE UPDATE OR DELETE ON recording_version FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER part_slot_mutable_before_seal BEFORE UPDATE OR DELETE ON part_slot FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER slot_part_mutable_before_seal BEFORE UPDATE OR DELETE ON slot_part FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER stem_mutable_before_seal BEFORE UPDATE OR DELETE ON stem FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER voice_mutable_before_seal BEFORE UPDATE OR DELETE ON voice FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();

-- 슬롯 구간을 줄이면 파트가 슬롯 밖에 남을 수 있다.
CREATE FUNCTION rc_slot_contains_parts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p slot_part;
BEGIN
  SELECT * INTO p FROM slot_part WHERE slot_id = NEW.slot_id AND (start_ms < NEW.start_ms OR end_ms > NEW.end_ms) ORDER BY part_no LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'PART_OUTSIDE_SLOT: part %/% (% ~ %) is outside slot (% ~ %)', p.slot_id, p.part_no, p.start_ms, p.end_ms, NEW.start_ms, NEW.end_ms;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER part_slot_contains_parts AFTER UPDATE ON part_slot FOR EACH ROW EXECUTE FUNCTION rc_slot_contains_parts();

-- 권리 주장·위임: 봉인 전에는 지울 수 있다(스템·보이스 삭제에 딸려). 봉인 뒤에는 지금처럼 대체만.
CREATE FUNCTION rc_supersede_or_delete_before_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM facts_scope WHERE facts_scope_id = OLD.facts_scope_id AND sealed_through IS NOT NULL) THEN
      RAISE EXCEPTION 'CATALOG_SEALED: % DELETE rejected — the song''s facts are sealed (append-only)', TG_TABLE_NAME USING ERRCODE = 'RC001';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE는 지금과 같다(0001_base.sql rc_allow_supersede_only): superseded_at을 NULL에서 값으로 한 번만.
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (to_jsonb(NEW) - 'superseded_at') <> (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'append-only table %: only a single superseded_at set is allowed', TG_TABLE_NAME USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER right_claim_append_only ON right_claim;
DROP TRIGGER mandate_append_only ON mandate;
CREATE TRIGGER right_claim_append_only BEFORE UPDATE OR DELETE ON right_claim FOR EACH ROW EXECUTE FUNCTION rc_supersede_or_delete_before_seal();
CREATE TRIGGER mandate_append_only BEFORE UPDATE OR DELETE ON mandate FOR EACH ROW EXECUTE FUNCTION rc_supersede_or_delete_before_seal();

-- 주장을 지우면 그 확인 요청도 거둔다(봉인 전이라 어떤 IR에도 없다).
CREATE POLICY confirmation_delete ON confirmation_request FOR DELETE USING (rc_can_write(owner_tenant_id));

GRANT UPDATE, DELETE ON work, recording_version, part_slot, slot_part, stem, voice TO rc_app;
GRANT DELETE ON right_claim, mandate, confirmation_request TO rc_app;
-- 곡을 지우면 봉인된 적 없는 빈 범위도 함께 지운다(서비스가 봉인 여부를 먼저 본다).
GRANT DELETE ON facts_scope TO rc_app;
