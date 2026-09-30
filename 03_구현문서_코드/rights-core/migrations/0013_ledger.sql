-- 복식 원장(통합 설계 11.2-2). 차변 +, 대변 −. 분개 하나의 전기 합 = 0(커밋 시점 검사).
CREATE TABLE ledger_account (
  account_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('RECEIVABLE','POOL_PLATFORM','POOL_OPS','POOL_FAN','POOL_OTHER','PARTY_PAYABLE','HOLD','WITHHOLDING_TAX','PSP_CLEARING','CASH')),
  party_id   vcrl_id NULL REFERENCES party,
  reason     TEXT NULL,
  bucket     TEXT NULL,
  CHECK ((kind = 'PARTY_PAYABLE') = (party_id IS NOT NULL)),
  CHECK ((kind = 'HOLD') = (reason IS NOT NULL)),
  CHECK ((kind = 'POOL_OTHER') = (bucket IS NOT NULL))
);
CREATE TABLE journal_entry (
  entry_id    BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('SETTLEMENT','REVERSAL','HOLD_RELEASE','PAYOUT','PAYOUT_SETTLED','PAYOUT_FAILED','ADJUSTMENT')),
  source_ref  TEXT NOT NULL UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL CHECK (occurred_at = date_trunc('milliseconds', occurred_at)),
  created_by  TEXT NOT NULL
);
CREATE TABLE posting (
  posting_id BIGSERIAL PRIMARY KEY,
  entry_id   BIGINT NOT NULL REFERENCES journal_entry,
  account_id TEXT NOT NULL REFERENCES ledger_account,
  amount_krw BIGINT NOT NULL CHECK (amount_krw <> 0),
  event_id   vcrl_id NULL,
  run_id     vcrl_id NULL
);
CREATE INDEX posting_account ON posting (account_id, entry_id);
CREATE INDEX posting_entry ON posting (entry_id);

-- 분개별 합 0: 커밋 시점에 그 분개의 합을 검사한다(PostgreSQL 제약 트리거는 FOR EACH ROW만 가능).
-- 행마다 합을 다시 세면 분개 크기에 제곱이므로, 트랜잭션 범위 설정 rc.bal_last에 마지막으로 검사한 분개 id를 두고
-- 같은 분개의 연속된 행은 건너뛴다. 지연 트리거는 INSERT 순서대로 커밋 시점에 실행되고 postEntry는 분개의 전기를
-- 한 문장으로 넣으므로 분개마다 한 번 계산한다(끼어든 순서면 다시 계산할 뿐 검사를 빠뜨리지 않는다).
-- 분개 id마다 설정 이름을 만들면 세션에 자리표시 GUC가 계속 쌓이므로 이름 하나만 쓴다.
CREATE FUNCTION rc_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s BIGINT;
BEGIN
  IF current_setting('rc.bal_last', true) = NEW.entry_id::text THEN RETURN NULL; END IF;
  PERFORM set_config('rc.bal_last', NEW.entry_id::text, true);
  SELECT COALESCE(SUM(amount_krw), 0) INTO s FROM posting WHERE entry_id = NEW.entry_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'journal entry % unbalanced (sum %)', NEW.entry_id, s USING ERRCODE = 'RC001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER posting_balanced AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rc_entry_balanced();

CREATE TRIGGER ledger_account_immutable BEFORE UPDATE OR DELETE ON ledger_account FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON journal_entry FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER posting_immutable BEFORE UPDATE OR DELETE ON posting FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON ledger_account, journal_entry, posting TO rc_app;
GRANT USAGE ON SEQUENCE journal_entry_entry_id_seq, posting_posting_id_seq TO rc_app;
