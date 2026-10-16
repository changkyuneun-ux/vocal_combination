-- superseded_at은 후속 버전과 함께만 설정할 수 있다: 커밋 시점에 같은 id의 recorded_at = superseded_at인 행이 있어야 한다.
CREATE FUNCTION rc_require_successor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  found BOOLEAN;
BEGIN
  IF NEW.superseded_at IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'right_claim' THEN
    SELECT EXISTS (SELECT 1 FROM right_claim WHERE claim_id = NEW.claim_id AND recorded_at = NEW.superseded_at) INTO found;
  ELSE
    SELECT EXISTS (SELECT 1 FROM mandate WHERE mandate_id = NEW.mandate_id AND recorded_at = NEW.superseded_at) INTO found;
  END IF;
  IF NOT found THEN
    RAISE EXCEPTION 'append-only table %: superseded_at % has no successor version', TG_TABLE_NAME, NEW.superseded_at USING ERRCODE = 'RC001';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER right_claim_successor AFTER UPDATE OF superseded_at ON right_claim
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rc_require_successor();
CREATE CONSTRAINT TRIGGER mandate_successor AFTER UPDATE OF superseded_at ON mandate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rc_require_successor();
