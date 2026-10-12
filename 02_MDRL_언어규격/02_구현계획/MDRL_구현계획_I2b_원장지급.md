# I-2b 원장·지급 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rights-core에 복식 원장, 보류 해제, 지급 지시·가짜 PSP, 명세, 발행 사전 검사·격리, 10.5 선행 과제를 붙여 "확정 정산 → 원장 → 지급 → 명세"를 끝까지 처리한다.

**Architecture:** 새 모듈 `ledger`(계정·분개·잔액·명세)와 `payout`(정책·지시·PSP), `settlement` 확장(격리·운영자 조작·revision 대체·점검), `engine-bridge` 확장(사전 검사·FRAUD 해제 제안). 원장 분개는 확정·역분개·해제·지급 트랜잭션 안에서 `postEntry`로 쓰고(합 0을 지연 제약 트리거가 커밋 때 검사), 비동기 처리는 기존 pg-boss 작업에 `post-batch`·`payout-run`·`submit-payout`·`poll-payout`·`apply-psp-result`·`revision-recorded`를 더한다.

**Tech Stack:** 기존 rights-core(Node ≥ 24, TypeScript, Fastify 5, pg 8, pg-boss 12, PostgreSQL 17 Docker).

**상위 스펙(정본):** `02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md` **11절(I-2b 결정 1~14)**, 10절(I-2a), 5.7. 모든 태스크의 요구사항은 11.2의 해당 결정 번호를 따른다.

## Global Constraints

- 작업 디렉터리 `/Users/changkyuneun/Vocal Combination/03_구현문서_코드` (git 루트 `/Users/changkyuneun/Vocal Combination`). 무관한 커밋 안 된 변경이 많다. `git add`는 태스크 파일만, `git stash`·`git reset`·`git checkout -- <path>` 금지. 임시 파일은 남기지 않는다.
- 커밋 메시지: 제목, 빈 줄, 마지막 줄에 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- TypeScript erasable syntax만, 상대 import는 `.ts`, 타입 전용은 `import type`.
- `mdrl` import는 `src/engine-bridge/`에만. `revenue`는 `settlement`를, `ledger`는 `settlement`·`payout`을 import하지 않는다(의존 방향: settlement → ledger, payout → ledger). 아키텍처 테스트에 `ledger` 규칙을 추가한다.
- 서비스는 `Clock`을 받고 현재 시각을 직접 읽지 않는다. 시각은 밀리초 UTC ISO, `TIMESTAMPTZ` 컬럼에는 밀리초 절사 `CHECK`.
- 금액은 `BIGINT`/`bigint`. 부동소수 금지(시나리오 시간 측정 제외). 세율은 정수 bps.
- 새 테이블은 추가 전용(트리거 `rc_reject_mutation` + `rc_app` SELECT·INSERT + 명시한 컬럼 UPDATE). 상태 컬럼이 있는 테이블은 상태 전이 가드 트리거(RC001)를 둔다(0011의 가드 방식).
- 원장: 분개 하나의 전기 합 = 0(지연 제약 트리거, 위반 RC001), `journal_entry.source_ref` UNIQUE(멱등 — 같은 `source_ref`로 다시 쓰면 기존 분개를 돌려주고 아무것도 쓰지 않는다).
- 오류 → HTTP는 기존 규칙. 새 작업 이름은 `JOB_NAMES`에 추가하고, 템플릿 DB 해시에 `JOB_NAMES`를 넣는다(11.2-14).
- 테스트: `docker compose up -d`. `node --test "test/**/*.test.ts"`(= `npm test`) 또는 파일 경로(디렉터리 형태는 실패). `npx tsc -p tsconfig.json`. 기존 테스트(110개)·mdrl(278개)·`npm run scenario -- --settle 30000`이 계속 통과해야 한다(사전 검사 도입으로 I-1 시나리오의 발행 수가 달라지는 것은 Task 6에서 반영).

## File Structure

```
rights-core/
  migrations/0013_ledger.sql            (ledger_account, journal_entry, posting, 합 0 트리거)
  migrations/0014_holds_payout.sql      (hold_release, party_payout_profile, payout_policy, payout_run, payout_instruction, psp_webhook_inbox)
  migrations/0015_quarantine_revision.sql (quarantine, revenue_supersede, skip 사유 확장, INSERT 가드)
  src/ledger/accounts.ts, journal.ts, statements.ts
  src/payout/policy.ts, service.ts, provider.ts, fake-provider.ts, handlers.ts
  src/settlement/posting.ts (확정·역분개 분개), quarantine.ts, operator.ts, invariants.ts, revision.ts
  src/engine-bridge/preflight.ts, fraud-release.ts
  src/platform/jobs.ts, dbadmin.ts, db.ts, migrate-cli.ts   (Modify/Create)
  src/ledger/routes.ts, src/payout/routes.ts, src/settlement/routes.ts, src/http/server.ts, main.ts (Modify/Create)
  src/scenario/ledger.ts, main.ts
  test/ledger/*.test.ts, test/payout/*.test.ts, test/settlement/{quarantine,operator,revision,invariants,guards-insert}.test.ts, test/scenario/ledger.test.ts
02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md (Task 10: 11.4 결과, 10.5 완료 표시)
```

---

### Task 1: 원장 코어와 확정·역분개 반영

**Files:**
- Create: `rights-core/migrations/0013_ledger.sql`, `rights-core/src/ledger/accounts.ts`, `rights-core/src/ledger/journal.ts`, `rights-core/src/settlement/posting.ts`, `rights-core/test/ledger/journal.test.ts`, `rights-core/test/ledger/posting.test.ts`
- Modify: `rights-core/src/platform/jobs.ts`(`post-batch` 추가), `rights-core/src/platform/dbadmin.ts`(템플릿 해시에 `JOB_NAMES`), `rights-core/src/settlement/service.ts`(`confirmBatch`가 `post-batch` 전송), `rights-core/src/settlement/handlers.ts`(`reverseEventJob`이 같은 트랜잭션에서 역분개 분개, `jobHandlers`에 `post-batch`), `rights-core/test/engine-bridge/architecture.test.ts`(ledger 규칙)

**Interfaces (Produces):**
```ts
// ledger/accounts.ts
export type AccountKind = "RECEIVABLE" | "POOL_PLATFORM" | "POOL_OPS" | "POOL_FAN" | "POOL_OTHER" | "PARTY_PAYABLE" | "HOLD" | "WITHHOLDING_TAX" | "PSP_CLEARING" | "CASH";
export type AccountKey = { kind: AccountKind; partyId?: string; reason?: string; bucket?: string };
export function accountId(k: AccountKey): string;   // 결정적 id: "RECEIVABLE", "PARTY_PAYABLE:pty_x", "HOLD:FRAUD_REVIEW", "POOL_OTHER:<bucket>"
export async function ensureAccount(tx: Tx, k: AccountKey): Promise<string>;   // INSERT ... ON CONFLICT DO NOTHING
export function poolAccountFor(bucket: string): AccountKey;                   // 11.2-3
// ledger/journal.ts
export type EntryKind = "SETTLEMENT" | "REVERSAL" | "HOLD_RELEASE" | "PAYOUT" | "PAYOUT_SETTLED" | "PAYOUT_FAILED" | "ADJUSTMENT";
export type PostingInput = { account: AccountKey; amount: bigint; eventId?: string; runId?: string };
export async function postEntry(tx: Tx, clock: Clock, e: { kind: EntryKind; sourceRef: string; createdBy: string; postings: PostingInput[] }):
  Promise<{ entryId: string; created: boolean }>;       // 전기 합 ≠ 0이면 422 LEDGER_UNBALANCED(트리거 이전에 서비스에서도 검사), 금액 0 전기는 빼고 씀
export async function balance(tx: Tx, k: AccountKey, until?: string): Promise<bigint>;   // Σ amount (부호 그대로)
export async function trialBalance(tx: Tx): Promise<{ accountId: string; kind: AccountKind; balance: bigint }[]>;
// settlement/posting.ts
export async function postConfirmedRun(tx: Tx, clock: Clock, runId: string): Promise<void>;          // 11.2-4, source_ref = run:<id>
export async function postReversal(tx: Tx, clock: Clock, reversalId: string): Promise<void>;          // 11.2-4·5, source_ref = rev:<id>
export async function postBatch(d: SettleDeps, data: { batchId: string }): Promise<void>;             // post-batch 처리기: 배치의 CONFIRMED run 전부
```

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/ledger/journal.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { balance, postEntry, trialBalance } from "../../src/ledger/journal.ts";
import { accountId, poolAccountFor } from "../../src/ledger/accounts.ts";

const { db, adminUrl, drop } = await freshDb();
after(drop);
const clock = fixedClock("2026-04-01T00:00:00.000Z", 1);

test("accounts have deterministic ids and tier1 buckets map to pool accounts", () => {
  assert.equal(accountId({ kind: "PARTY_PAYABLE", partyId: "pty_a" }), "PARTY_PAYABLE:pty_a");
  assert.equal(accountId({ kind: "HOLD", reason: "FRAUD_REVIEW" }), "HOLD:FRAUD_REVIEW");
  assert.deepEqual(poolAccountFor("platform"), { kind: "POOL_PLATFORM" });
  assert.deepEqual(poolAccountFor("ops"), { kind: "POOL_OPS" });
  assert.deepEqual(poolAccountFor("fan"), { kind: "POOL_FAN" });
  assert.deepEqual(poolAccountFor("marketing"), { kind: "POOL_OTHER", bucket: "marketing" });
});

test("a balanced entry posts once per source_ref; balances are sums", async () => {
  const e = { kind: "ADJUSTMENT" as const, sourceRef: "adj:1", createdBy: "sys_settler", postings: [
    { account: { kind: "RECEIVABLE" as const }, amount: 1000n },
    { account: { kind: "PARTY_PAYABLE" as const, partyId: "pty_a" }, amount: -700n },
    { account: { kind: "POOL_PLATFORM" as const }, amount: -300n },
    { account: { kind: "POOL_OPS" as const }, amount: 0n },
  ] };
  const first = await db.tx((tx) => postEntry(tx, clock, e));
  assert.equal(first.created, true);
  const again = await db.tx((tx) => postEntry(tx, clock, e));
  assert.deepEqual(again, { entryId: first.entryId, created: false });
  assert.equal(await db.tx((tx) => balance(tx, { kind: "PARTY_PAYABLE", partyId: "pty_a" })), -700n);
  const n = await db.pool.query("SELECT count(*)::int AS n FROM posting WHERE entry_id = $1", [first.entryId]);
  assert.equal(n.rows[0].n, 3, "zero-amount postings are not written");
  const tb = await db.tx((tx) => trialBalance(tx));
  assert.equal(tb.reduce((a, r) => a + r.balance, 0n), 0n);
});

test("unbalanced entries are rejected by the service and by the deferred trigger", async () => {
  await assert.rejects(db.tx((tx) => postEntry(tx, clock, { kind: "ADJUSTMENT", sourceRef: "adj:bad", createdBy: "x", postings: [
    { account: { kind: "RECEIVABLE" }, amount: 5n }, { account: { kind: "CASH" }, amount: -4n },
  ] })), { code: "LEDGER_UNBALANCED", status: 422 });
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: (db.pool as any).options.connectionString });
  await c.connect();
  try {
    await c.query("BEGIN");
    const id = (await c.query("INSERT INTO journal_entry (kind, source_ref, occurred_at, created_by) VALUES ('ADJUSTMENT','adj:raw',now()::timestamptz(3),'x') RETURNING entry_id")).rows[0].entry_id;
    await c.query("INSERT INTO ledger_account (account_id, kind) VALUES ('CASH','CASH') ON CONFLICT DO NOTHING");
    await c.query("INSERT INTO posting (entry_id, account_id, amount_krw) VALUES ($1,'CASH',5)", [id]);
    await assert.rejects(c.query("COMMIT"), /RC001|unbalanced/);
  } finally {
    await c.end();
  }
  void adminUrl;
});

test("journal rows are immutable", async () => {
  await assert.rejects(db.pool.query("UPDATE posting SET amount_krw = 0"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM journal_entry"), /append-only|permission denied/);
});
```

`rights-core/test/ledger/posting.test.ts`(I-2a 픽스처 사용):
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue } from "../../src/revenue/service.ts";
import { confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { balance, trialBalance } from "../../src/ledger/journal.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const P = { periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" };
await issueCombo(w, "vc_1");

test("confirmation posts one balanced SETTLEMENT entry per run via post-batch", async () => {
  await purchase(w, "ev_1", "vc_1", "10000");
  await purchase(w, "ev_2", "vc_1", "1001", "2026-03-02T00:00:00.000Z", "FLAGGED");
  await createBatch(d, w.users.ops, { batchId: "bat_l", ...P });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_l");
  assert.ok(jobs.sent.some((j) => j.name === "post-batch"));
  await jobs.drain(jobHandlers(d));
  const entries = await w.db.pool.query("SELECT kind, source_ref FROM journal_entry ORDER BY entry_id");
  assert.deepEqual(entries.rows.map((r) => r.kind), ["SETTLEMENT"]);
  assert.equal(await w.db.tx((tx) => balance(tx, { kind: "RECEIVABLE" })), 11001n);
  assert.ok((await w.db.tx((tx) => balance(tx, { kind: "HOLD", reason: "FRAUD_REVIEW" }))) < 0n);
  const payables = await w.db.pool.query("SELECT COALESCE(SUM(amount_krw),0)::text AS s FROM posting p JOIN ledger_account a USING (account_id) WHERE a.kind = 'PARTY_PAYABLE'");
  const lines = await w.db.pool.query("SELECT COALESCE(SUM(amount_krw),0)::text AS s FROM allocation_line");
  assert.equal(BigInt(payables.rows[0].s), -BigInt(lines.rows[0].s));
  assert.equal((await w.db.tx((tx) => trialBalance(tx))).reduce((a, r) => a + r.balance, 0n), 0n);
  await jobs.drain(jobHandlers(d));
  const again = await w.db.pool.query("SELECT count(*)::int AS n FROM journal_entry");
  assert.equal(again.rows[0].n, 1, "post-batch is idempotent");
});

test("a reversal posts the opposite entry in the same transaction", async () => {
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "rf_1", sourceSystem: "app", sourceEventId: "rf_1", eventType: "REFUND", relatedEventId: "ev_1", amountKrw: "10000", currency: "KRW", occurredAt: "2026-03-05T00:00:00.000Z",
  }, refundHook(jobs)));
  await jobs.drain(jobHandlers(d));
  const kinds = await w.db.pool.query("SELECT kind FROM journal_entry ORDER BY entry_id");
  assert.deepEqual(kinds.rows.map((r) => r.kind), ["SETTLEMENT", "REVERSAL"]);
  assert.equal(await w.db.tx((tx) => balance(tx, { kind: "RECEIVABLE" })), 1001n);
  assert.equal((await w.db.tx((tx) => trialBalance(tx))).reduce((a, r) => a + r.balance, 0n), 0n);
});
```

- [ ] **Step 2: 실패 확인** — `cd rights-core && node --test test/ledger/journal.test.ts test/ledger/posting.test.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 마이그레이션**

`rights-core/migrations/0013_ledger.sql`:
```sql
-- 복식 원장(통합 설계 11.2-2). 차변 +, 대변 −. 분개 하나의 전기 합 = 0(커밋 시점 검사).
CREATE TABLE ledger_account (
  account_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('RECEIVABLE','POOL_PLATFORM','POOL_OPS','POOL_FAN','POOL_OTHER','PARTY_PAYABLE','HOLD','WITHHOLDING_TAX','PSP_CLEARING','CASH')),
  party_id   mdrl_id NULL REFERENCES party,
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
  event_id   mdrl_id NULL,
  run_id     mdrl_id NULL
);
CREATE INDEX posting_account ON posting (account_id, entry_id);
CREATE INDEX posting_entry ON posting (entry_id);

-- 분개별 합 0: posting INSERT마다 커밋 시점에 그 분개의 합을 검사한다.
CREATE FUNCTION rc_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s BIGINT;
BEGIN
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
```
(행 단위 지연 트리거는 분개가 크면 느리다. 3만 건 시나리오에서 문제가 되면 `FOR EACH STATEMENT` 전이 테이블(`REFERENCING NEW TABLE AS new_rows`)로 바꿔 분개별 합을 한 번에 검사하고 보고한다.)

- [ ] **Step 4: 구현**

`rights-core/src/ledger/accounts.ts`:
```ts
import type { Tx } from "../platform/db.ts";

export type AccountKind = "RECEIVABLE" | "POOL_PLATFORM" | "POOL_OPS" | "POOL_FAN" | "POOL_OTHER" | "PARTY_PAYABLE" | "HOLD" | "WITHHOLDING_TAX" | "PSP_CLEARING" | "CASH";
export type AccountKey = { kind: AccountKind; partyId?: string; reason?: string; bucket?: string };

export function accountId(k: AccountKey): string {
  if (k.kind === "PARTY_PAYABLE") return `PARTY_PAYABLE:${k.partyId}`;
  if (k.kind === "HOLD") return `HOLD:${k.reason}`;
  if (k.kind === "POOL_OTHER") return `POOL_OTHER:${k.bucket}`;
  return k.kind;
}

/** tier1 비권리 버킷 → 풀 계정(통합 설계 11.2-3). 권리 풀 버킷은 호출하지 않는다. */
export function poolAccountFor(bucket: string): AccountKey {
  if (bucket === "platform") return { kind: "POOL_PLATFORM" };
  if (bucket === "ops") return { kind: "POOL_OPS" };
  if (bucket === "fan") return { kind: "POOL_FAN" };
  return { kind: "POOL_OTHER", bucket };
}

export async function ensureAccount(tx: Tx, k: AccountKey): Promise<string> {
  const id = accountId(k);
  await tx.query("INSERT INTO ledger_account (account_id, kind, party_id, reason, bucket) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id) DO NOTHING",
    [id, k.kind, k.partyId ?? null, k.reason ?? null, k.bucket ?? null]);
  return id;
}
```

`rights-core/src/ledger/journal.ts`:
```ts
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { accountId, ensureAccount, type AccountKey, type AccountKind } from "./accounts.ts";

export type EntryKind = "SETTLEMENT" | "REVERSAL" | "HOLD_RELEASE" | "PAYOUT" | "PAYOUT_SETTLED" | "PAYOUT_FAILED" | "ADJUSTMENT";
export type PostingInput = { account: AccountKey; amount: bigint; eventId?: string; runId?: string };

/** 분개(통합 설계 11.2-2): 같은 source_ref면 기존 분개를 돌려준다(멱등). 합 ≠ 0이면 422. */
export async function postEntry(tx: Tx, clock: Clock, e: { kind: EntryKind; sourceRef: string; createdBy: string; postings: PostingInput[] }) {
  const existing = (await tx.query("SELECT entry_id FROM journal_entry WHERE source_ref = $1", [e.sourceRef])).rows[0];
  if (existing !== undefined) return { entryId: String(existing.entry_id), created: false };
  const postings = e.postings.filter((p) => p.amount !== 0n);
  const sum = postings.reduce((a, p) => a + p.amount, 0n);
  if (sum !== 0n) throw new DomainError("LEDGER_UNBALANCED", 422, `entry ${e.sourceRef} sums to ${sum}`);
  const id = (await tx.query("INSERT INTO journal_entry (kind, source_ref, occurred_at, created_by) VALUES ($1,$2,$3,$4) RETURNING entry_id",
    [e.kind, e.sourceRef, clock.now(), e.createdBy])).rows[0].entry_id;
  const seen = new Set<string>();
  for (const p of postings) {
    const aid = accountId(p.account);
    if (!seen.has(aid)) { await ensureAccount(tx, p.account); seen.add(aid); }
  }
  if (postings.length > 0) {
    await tx.query(
      `INSERT INTO posting (entry_id, account_id, amount_krw, event_id, run_id)
       SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::text[])`,
      [id, postings.map((p) => accountId(p.account)), postings.map((p) => p.amount.toString()),
        postings.map((p) => p.eventId ?? null), postings.map((p) => p.runId ?? null)],
    );
  }
  return { entryId: String(id), created: true };
}

export async function balance(tx: Tx, k: AccountKey, until?: string): Promise<bigint> {
  const r = await tx.query(
    `SELECT COALESCE(SUM(p.amount_krw), 0)::text AS s FROM posting p JOIN journal_entry j USING (entry_id)
      WHERE p.account_id = $1 AND ($2::timestamptz IS NULL OR j.occurred_at < $2)`, [accountId(k), until ?? null]);
  return BigInt(r.rows[0].s);
}

export async function trialBalance(tx: Tx): Promise<{ accountId: string; kind: AccountKind; balance: bigint }[]> {
  const r = await tx.query(
    "SELECT a.account_id, a.kind, COALESCE(SUM(p.amount_krw), 0)::text AS s FROM ledger_account a LEFT JOIN posting p USING (account_id) GROUP BY a.account_id, a.kind ORDER BY a.account_id");
  return r.rows.map((x) => ({ accountId: x.account_id, kind: x.kind, balance: BigInt(x.s) }));
}
```

`rights-core/src/settlement/posting.ts`:
```ts
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { poolAccountFor } from "../ledger/accounts.ts";
import { postEntry, type PostingInput } from "../ledger/journal.ts";
import type { SettleDeps } from "./service.ts";

const SYSTEM = "sys_settler";

/** run의 권리 풀 버킷 이름(발행 봉인의 정책). */
async function rightsBucket(tx: Tx, runId: string): Promise<string> {
  const r = (await tx.query(
    `SELECT d.content->'body'->'tier1'->>'rights' AS rights FROM settlement_run r JOIN issue_seal s ON s.snapshot_id = r.snapshot_id
       JOIN sealed_document d ON d.digest = s.policy_digest WHERE r.run_id = $1`, [runId])).rows[0];
  if (r === undefined || r.rights === null) throw notFound("run policy", runId);
  return r.rights;
}

/** 확정 run 하나의 SETTLEMENT 분개(통합 설계 11.2-4). */
export async function postConfirmedRun(tx: Tx, clock: Clock, runId: string): Promise<void> {
  const rights = await rightsBucket(tx, runId);
  const postings: PostingInput[] = [];
  for (const e of (await tx.query("SELECT event_id, net_amount_krw::text AS net FROM settlement_run_event WHERE run_id = $1 ORDER BY event_id", [runId])).rows) {
    postings.push({ account: { kind: "RECEIVABLE" }, amount: BigInt(e.net), eventId: e.event_id, runId });
  }
  for (const p of (await tx.query("SELECT event_id, bucket, amount_krw::text AS a FROM pool_line WHERE run_id = $1 AND line_seq = 1 ORDER BY event_id, bucket", [runId])).rows) {
    if (p.bucket !== rights) postings.push({ account: poolAccountFor(p.bucket), amount: -BigInt(p.a), eventId: p.event_id, runId });
  }
  for (const l of (await tx.query("SELECT event_id, party_id, amount_krw::text AS a FROM allocation_line WHERE run_id = $1 AND line_seq = 1 ORDER BY line_id", [runId])).rows) {
    postings.push({ account: { kind: "PARTY_PAYABLE", partyId: l.party_id }, amount: -BigInt(l.a), eventId: l.event_id, runId });
  }
  for (const h of (await tx.query("SELECT event_id, reason, amount_krw::text AS a FROM unallocated_holding WHERE run_id = $1 AND line_seq = 1 ORDER BY holding_id", [runId])).rows) {
    postings.push({ account: { kind: "HOLD", reason: h.reason }, amount: -BigInt(h.a), eventId: h.event_id, runId });
  }
  await postEntry(tx, clock, { kind: "SETTLEMENT", sourceRef: `run:${runId}`, createdBy: SYSTEM, postings });
}

/**
 * 역분개의 REVERSAL 분개(통합 설계 11.2-4·5). 역분개 행의 금액은 음수이므로 부호를 뒤집어 쓴다.
 * 이미 해제된 보류의 역분개는 Task 2가 이 함수를 확장해 해제 배분 비율로 권리자 미지급금에서 뺀다.
 */
export async function postReversal(tx: Tx, clock: Clock, reversalId: string): Promise<void> {
  const rv = (await tx.query("SELECT original_run_id, event_id, sequence FROM reversal_run WHERE reversal_id = $1", [reversalId])).rows[0];
  if (rv === undefined) throw notFound("reversal", reversalId);
  const runId = rv.original_run_id as string;
  const rights = await rightsBucket(tx, runId);
  const postings: PostingInput[] = [];
  const pool = (await tx.query("SELECT bucket, amount_krw::text AS a FROM pool_line WHERE reversal_id = $1 ORDER BY bucket", [reversalId])).rows;
  const total = pool.reduce((a, p) => a + BigInt(p.a), 0n);   // 음수
  postings.push({ account: { kind: "RECEIVABLE" }, amount: total, eventId: rv.event_id, runId });
  for (const p of pool) if (p.bucket !== rights) postings.push({ account: poolAccountFor(p.bucket), amount: -BigInt(p.a), eventId: rv.event_id, runId });
  for (const l of (await tx.query("SELECT party_id, amount_krw::text AS a FROM allocation_line WHERE reversal_id = $1 ORDER BY line_id", [reversalId])).rows) {
    postings.push({ account: { kind: "PARTY_PAYABLE", partyId: l.party_id }, amount: -BigInt(l.a), eventId: rv.event_id, runId });
  }
  for (const h of (await tx.query("SELECT reason, amount_krw::text AS a FROM unallocated_holding WHERE reversal_id = $1 ORDER BY holding_id", [reversalId])).rows) {
    postings.push({ account: { kind: "HOLD", reason: h.reason }, amount: -BigInt(h.a), eventId: rv.event_id, runId });
  }
  await postEntry(tx, clock, { kind: "REVERSAL", sourceRef: `rev:${reversalId}`, createdBy: SYSTEM, postings });
}

/** post-batch 처리기: 배치의 CONFIRMED run마다 분개(멱등). */
export async function postBatch(d: SettleDeps, data: { batchId: string }): Promise<void> {
  const runs = (await d.db.pool.query("SELECT run_id FROM settlement_run WHERE batch_id = $1 AND status = 'CONFIRMED' ORDER BY run_id", [data.batchId])).rows;
  for (const r of runs) await d.db.tx((tx) => postConfirmedRun(tx, d.clock, r.run_id));
}
```

수정:
- `src/platform/jobs.ts`: `JobName`·`JOB_NAMES`에 `"post-batch"`를 추가한다(이후 태스크가 `payout-run`, `submit-payout`, `poll-payout`, `apply-psp-result`, `revision-recorded`를 같은 방식으로 추가한다).
- `src/platform/dbadmin.ts` `templateName()`: 해시에 `JOB_NAMES.join(",")`를 넣는다.
- `src/settlement/service.ts` `confirmBatch`: 배치를 CONFIRMED로 바꾼 같은 트랜잭션에서 `await d.jobs.send(tx, "post-batch", { batchId })`.
- `src/settlement/handlers.ts` `reverseEventJob`: 역분개 행을 모두 INSERT한 뒤 같은 트랜잭션에서 `await postReversal(tx, d.clock, reversalId)`. `jobHandlers`에 `"post-batch": (data) => postBatch(d, { batchId: data.batchId! })`.
- `test/engine-bridge/architecture.test.ts`: `src/ledger/`의 어떤 파일도 `../settlement`·`../payout`을 import하지 않는다는 규칙을 추가한다.
- `src/http/main.ts`의 핸들러 완전성 검사는 새 이름을 포함하게 된다 — 이 태스크 끝에서 `jobHandlers`가 `post-batch`를 제공하므로 통과해야 한다(이후 태스크의 새 작업은 그 태스크에서 처리기를 등록한다. `main.ts`가 `payout` 처리기까지 합치도록 Task 4에서 바꾼다).

- [ ] **Step 5: 통과 확인** — `node --test test/ledger/journal.test.ts test/ledger/posting.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK` → 통과, fail 0.

- [ ] **Step 6: 커밋** — 태스크 파일만 add, 메시지 `feat(rights-core): 복식 원장과 확정·역분개 분개(post-batch)`.

---

### Task 2: 보류 해제와 해제 후 역분개

**Files:** Create `rights-core/src/settlement/holds.ts`, `rights-core/src/engine-bridge/fraud-release.ts`, `rights-core/test/settlement/holds.test.ts`; Create migration part in `rights-core/migrations/0014_holds_payout.sql`(이 태스크는 `hold_release`만; Task 3이 같은 파일에 지급 테이블을 추가한다 — 두 태스크 모두 병합 전이므로 파일을 이어서 편집한다); Modify `rights-core/src/settlement/posting.ts`(`postReversal`).

**Requirements (11.2-5):**
- `hold_release(release_id BIGSERIAL PK, holding_id BIGINT UNIQUE REFERENCES unallocated_holding, released_by mdrl_id REFERENCES user_account, released_at TIMESTAMPTZ ms CHECK, allocation JSONB NOT NULL, entry_id BIGINT REFERENCES journal_entry)`. 불변 트리거, SELECT·INSERT 권한.
- `releaseHold(d, actor, { holdingId, allocation: Record<partyId, string /* 원 */> })`: `SPACE_SETTLE`만. 대상은 `line_seq = 1`인 원 보류, 그 run이 `CONFIRMED`, 아직 해제 안 됨(UNIQUE 위반 → 409 `HOLD_ALREADY_RELEASED`). 배분 합 = 보류액(아니면 422 `ALLOCATION_MISMATCH`), 금액은 양의 정수, 권리자는 `party`에 있고 `FAN`·`PLATFORM`이 아님. 이미 역분개로 줄어든 금액이 있으면 해제액 = 원 보류액 + 그 보류의 역분개 합(남은 보류액)이고 배분 합은 그 값과 같아야 한다. 분개 `HOLD_RELEASE`(`source_ref = hold:<holding_id>`): `HOLD(reason) +남은 보류액`, `PARTY_PAYABLE(p) −배분`. 감사 기록.
- `suggestFraudRelease(ctx, tx, holdingId)`(engine-bridge): `FRAUD_REVIEW` 보류의 run 입력(발행 봉인, 봉인된 events)에서 그 이벤트만 `integrity: "CLEAR"`로 바꿔 mdrl `evaluate`하고, 그 이벤트의 라인을 권리자별로 합친 제안을 돌려준다(남은 보류액이 원 보류액과 다르면 제안을 남은 금액으로 비례 축소 — 최대 잔여법, 동률 party_id 오름차순). `RIGHTS_DISPUTE`는 제안하지 않는다(404 `NO_SUGGESTION`).
- `postReversal` 확장: 역분개 보류 행의 원 보류(같은 run·event·bucket·reason, `line_seq = 1`)에 `hold_release`가 있으면, 그 보류 역분개 금액을 `HOLD`가 아니라 해제 배분 비율로 권리자 미지급금에 전기한다(최대 잔여법으로 정수 분배, 합 보존).

**Tests (`test/settlement/holds.test.ts`):** FLAGGED 매출로 `FRAUD_REVIEW` 보류를 만든 확정 배치 → (1) `suggestFraudRelease`가 권리자별 합 = 보류액인 제안을 준다, (2) 비`SPACE_SETTLE` 403, 합 불일치 422, 확정 전 run의 보류 409, (3) 해제 후 `HOLD:FRAUD_REVIEW` 잔액 0·권리자 미지급금 증가·시산표 합 0, (4) 이중 해제 409, (5) 해제 뒤 원 매출 전액 환불 → 역분개 분개가 해제된 권리자 미지급금에서 빠지고 `HOLD` 잔액은 0 유지, 시산표 합 0.

- [ ] Step 1 테스트 작성 → Step 2 실패 확인 → Step 3 마이그레이션·구현 → Step 4 통과(`npm test`, tsc) → Step 5 커밋 `feat(rights-core): 보류 해제·FRAUD 해제 제안·해제 후 역분개 전기`.

(최대 잔여법 분배는 `src/ledger/split.ts`에 `splitByWeights(total: bigint, weights: {key: string; weight: bigint}[]): Map<string, bigint>`로 둔다 — floor(total·w/Σw), 남는 단위는 나머지 내림차순·동률 key 오름차순으로 1씩. 음수 total은 절댓값으로 나눈 뒤 부호를 붙인다. 단위 테스트를 함께 둔다.)

---

### Task 3: 지급 정책과 지급 지시

**Files:** Modify `rights-core/migrations/0014_holds_payout.sql`(지급 테이블 추가); Create `rights-core/src/payout/policy.ts`, `rights-core/src/payout/service.ts`, `rights-core/test/payout/payout-run.test.ts`; Modify `src/platform/jobs.ts`(`payout-run`).

**Schema:**
```sql
CREATE TABLE party_payout_profile (
  party_id           mdrl_id PRIMARY KEY REFERENCES party,
  tax_type           TEXT NOT NULL CHECK (tax_type IN ('DOMESTIC_INDIVIDUAL','DOMESTIC_CORP','FOREIGN','EXEMPT')),
  payout_account_ref TEXT NULL,          -- PSP 쪽 계좌 토큰(원문 계좌번호를 저장하지 않는다)
  kyc_verified       BOOLEAN NOT NULL DEFAULT false,
  first_payable_at   TIMESTAMPTZ NOT NULL CHECK (first_payable_at = date_trunc('milliseconds', first_payable_at)),
  updated_at         TIMESTAMPTZ NOT NULL CHECK (updated_at = date_trunc('milliseconds', updated_at))
);
CREATE TABLE payout_policy (
  policy_id          TEXT PRIMARY KEY CHECK (policy_id = 'default'),
  min_payout_krw     BIGINT NOT NULL CHECK (min_payout_krw > 0),
  initial_hold_days  INT NOT NULL CHECK (initial_hold_days >= 0),
  tax_bps            JSONB NOT NULL          -- {"DOMESTIC_INDIVIDUAL":330,"DOMESTIC_CORP":0,"FOREIGN":2200,"EXEMPT":0}
);
INSERT INTO payout_policy VALUES ('default', 10000, 30, '{"DOMESTIC_INDIVIDUAL":330,"DOMESTIC_CORP":0,"FOREIGN":2200,"EXEMPT":0}');
CREATE TABLE payout_run (
  payout_run_id mdrl_id PRIMARY KEY,
  as_of         TIMESTAMPTZ NOT NULL CHECK (as_of = date_trunc('milliseconds', as_of)),
  created_by    mdrl_id NOT NULL REFERENCES user_account,
  created_at    TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);
CREATE TABLE payout_instruction (
  instruction_id   mdrl_id PRIMARY KEY,
  payout_run_id    mdrl_id NOT NULL REFERENCES payout_run,
  party_id         mdrl_id NOT NULL REFERENCES party,
  gross_krw        BIGINT NOT NULL,
  withholding_krw  BIGINT NOT NULL CHECK (withholding_krw >= 0),
  net_krw          BIGINT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PENDING','SUBMITTED','PAID','FAILED','CARRIED','HELD')),
  hold_reason      TEXT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  provider_ref     TEXT NULL,
  entry_id         BIGINT NULL REFERENCES journal_entry,
  settled_entry_id BIGINT NULL REFERENCES journal_entry,
  created_at       TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  UNIQUE (payout_run_id, party_id),
  CHECK (net_krw = gross_krw - withholding_krw),
  CHECK ((status IN ('CARRIED','HELD')) = (entry_id IS NULL))
);
```
상태 전이 가드 트리거(RC001): `PENDING→SUBMITTED|PAID|FAILED`, `SUBMITTED→PAID|FAILED`, `CARRIED`·`HELD`·`PAID`·`FAILED`는 끝 상태, `provider_ref`·`settled_entry_id` write-once, 다른 컬럼 불변. `party_payout_profile`은 `tax_type`·`payout_account_ref`·`kyc_verified`·`updated_at`만 UPDATE 허용(운영 편집). 권한은 해당 컬럼 UPDATE만.

**Requirements (11.2-6):**
- `setPayoutProfile(tx, clock, actor(SPACE_SETTLE), { partyId, taxType, payoutAccountRef?, kycVerified })`: 없으면 INSERT(`first_payable_at` = 지금), 있으면 허용 컬럼만 UPDATE.
- `computeWithholding(gross: bigint, bps: number): bigint` = ⌊gross × bps / 10000 / 10⌋ × 10(음수·0 총액은 0). 단위 테스트: 10,000원 330bps → 330, 12,345원 330bps → 400(407.385 → 400), 99원 2200bps → 20(21.78 → 20), 0 → 0.
- `createPayoutRun(d, actor(SPACE_SETTLE), { payoutRunId, asOf })`: 한 트랜잭션. `PARTY_PAYABLE` 계정이 있는 권리자마다 부채 잔액 gross = −balance(asOf 이전 전기). 프로필 없음·계좌 없음·KYC 미확인 → `HELD`(`hold_reason` `NO_PROFILE|NO_ACCOUNT|KYC_REQUIRED`), `asOf < first_payable_at + initial_hold_days` → `HELD`(`INITIAL_HOLD`), gross < 최소 지급액(0 이하 포함) → `CARRIED`. 그 밖은 `PENDING`과 분개 `PAYOUT`(`source_ref = payout:<instruction_id>`): `PARTY_PAYABLE +gross`, `WITHHOLDING_TAX −withholding`, `PSP_CLEARING −net`, 그리고 `submit-payout` 작업 전송(Task 4가 처리기를 둔다 — 이 태스크에서는 이름만 추가). `instruction_id = po_<payoutRunId>_<partyId>`, `idempotency_key = payout:<instruction_id>`. 감사 기록.
- 같은 `payoutRunId`로 다시 부르면 409(PK).

**Tests:** 확정 배치로 권리자 잔액을 만든 뒤 — 프로필 없음 HELD, KYC 미확인 HELD, 초기 보류 기간 안 HELD, 최소액 미만 CARRIED(잔액 유지), 정상 지급 PENDING·원천징수 절사·분개(미지급금 0, 원천세·PSP 정산 중 증가, 시산표 0), 음수 잔액 권리자(해제 후 역분개로 음수가 된 경우 — Task 2 흐름 재사용 또는 직접 ADJUSTMENT 분개로 구성) CARRIED, 다음 지급 실행에서 CARRIED 잔액이 합쳐져 지급, `submit-payout` 전송 확인.

- [ ] Step 1~5(테스트 → 실패 → 구현 → 통과 → 커밋 `feat(rights-core): 지급 정책·원천징수·지급 지시와 PAYOUT 분개`).

---

### Task 4: PSP 인터페이스·가짜 어댑터·결과 반영

**Files:** Create `rights-core/src/payout/provider.ts`, `rights-core/src/payout/fake-provider.ts`, `rights-core/src/payout/handlers.ts`, `rights-core/test/payout/psp.test.ts`; Modify `0014_holds_payout.sql`(`psp_webhook_inbox`), `src/platform/jobs.ts`(`submit-payout`, `poll-payout`, `apply-psp-result`), `src/http/main.ts`(payout 처리기 합치기).

**Interfaces:**
```ts
// payout/provider.ts
export type ProviderResult = { status: "ACCEPTED" | "PAID" | "FAILED" | "UNKNOWN"; providerRef?: string; reason?: string };
export type PayoutProvider = {
  submit(i: { instructionId: string; partyId: string; accountRef: string; amountKrw: bigint }, idempotencyKey: string): Promise<ProviderResult>;
  status(providerRef: string, idempotencyKey: string): Promise<ProviderResult>;
};
// payout/fake-provider.ts — 결정적: 같은 멱등 키는 같은 결과. amount % 97 === 0 → FAILED, % 89 === 0 → 첫 submit UNKNOWN(status로는 PAID), 그 밖 ACCEPTED 후 status PAID. 호출 횟수·키별 기록을 노출한다(테스트용).
export function fakeProvider(): PayoutProvider & { calls: { op: string; key: string }[]; webhook(key: string): { providerEventId: string; providerRef: string; status: "PAID" | "FAILED" } };
// payout/handlers.ts
export type PayoutDeps = SettleDeps & { provider: PayoutProvider };
export async function submitPayout(d: PayoutDeps, data: { instructionId: string }): Promise<void>;
export async function pollPayout(d: PayoutDeps, data: { instructionId: string }): Promise<void>;
export async function recordWebhook(tx: Tx, clock: Clock, jobs: Jobs, w: { providerEventId: string; providerRef: string; status: "PAID" | "FAILED"; payload: unknown }): Promise<{ created: boolean }>;
export async function applyPspResult(d: PayoutDeps, data: { instructionId: string; status: "PAID" | "FAILED" }): Promise<void>;
export function payoutJobHandlers(d: PayoutDeps): Partial<Record<JobName, JobHandler>>;
```
**Requirements (11.2-7):** `psp_webhook_inbox(provider_event_id TEXT PK, provider_ref TEXT, status TEXT, payload JSONB, received_at, processed_at NULL)`(processed_at만 UPDATE). `submitPayout`: 지시를 잠그고 `PENDING`이 아니면 끝. 트랜잭션 **밖에서** `provider.submit`를 부르지 않도록 순서를 지킨다: (1) 짧은 트랜잭션에서 상태 확인·필요한 값 읽기, (2) 트랜잭션 밖에서 `submit(…, idempotencyKey)`, (3) 새 트랜잭션에서 지시를 다시 잠그고 결과 반영 — `ACCEPTED`→`SUBMITTED`+`provider_ref`+`poll-payout` 지연 전송(pg-boss `startAfter`; 기록용 큐에서는 즉시), `PAID`→`applyPspResult` 로직, `FAILED`→`applyPspResult`, `UNKNOWN`→상태 유지하고 `poll-payout` 지연 전송(새 submit 금지 — 재조회 우선). `pollPayout`: `status(ref|key)`로 조회해 끝 상태면 반영, 아니면 다시 지연 전송(최대 시도는 pg-boss 재시도에 맡기지 않고 데이터에 `attempt`를 싣고 10회 넘으면 감사 `PAYOUT_STUCK`). `applyPspResult`: 지시를 잠그고 이미 끝 상태면 끝(멱등). `PAID` → 분개 `PAYOUT_SETTLED`(`source_ref = settled:<id>`, `PSP_CLEARING +net`, `CASH −net`), `FAILED` → 분개 `PAYOUT_FAILED`(`source_ref = failed:<id>`, `PAYOUT` 분개의 반대: `PSP_CLEARING +net`, `WITHHOLDING_TAX +withholding`, `PARTY_PAYABLE −gross`). webhook은 inbox INSERT(중복이면 `created:false`, 아무것도 안 함) 후 `provider_ref`로 지시를 찾아 `apply-psp-result` 전송.

**Tests:** 가짜 어댑터로 — 정상(ACCEPTED→poll→PAID, 분개 2개, 미지급금 0, CASH 감소), 실패(분개로 미지급금 복원, 원천세 0 복귀), 불명(submit 1회, status 조회로 PAID — submit 재호출 없음), `submitPayout` 재실행(끝 상태면 provider 호출 없음), webhook 중복(두 번째 `created:false`, 분개 추가 없음), webhook과 poll이 같은 결과를 두 번 적용하려 해도 분개 하나, 시산표 합 0.

- [ ] Step 1~5, 커밋 `feat(rights-core): PSP 인터페이스·가짜 어댑터·webhook inbox·지급 결과 분개`.

---

### Task 5: 명세와 점검 API

**Files:** Create `rights-core/src/ledger/statements.ts`, `rights-core/src/settlement/invariants.ts`, `rights-core/test/ledger/statements.test.ts`, `rights-core/test/settlement/invariants.test.ts`.

**Interfaces:**
```ts
export type Statement = { partyId: string; from: string; to: string; opening: string; settled: string; reversed: string; holdReleased: string;
  payoutGross: string; withholding: string; payoutNet: string; payoutFailedRestored: string; closing: string };
export async function partyStatement(tx: Tx, partyId: string, from: string, to: string): Promise<Statement>;
export type InvariantReport = { unreflectedRefunds: { refundEventId: string; originalEventId: string; runId: string }[];
  ledger: { entriesUnbalanced: number; receivableMatchesSettlement: boolean; rightsConserved: boolean }; stuckRuns: { runId: string; status: string; since: string }[] };
export async function invariants(tx: Tx, clock: Clock, opts?: { stuckAfterMinutes?: number }): Promise<InvariantReport>;
```
**Requirements (11.2-8·10):** 명세의 모든 값은 `PARTY_PAYABLE:<party>` 전기를 분개 종류별로 합쳐 계산한다(권리자 관점 부호: 수령 +). opening = 기간 시작 이전 부채 잔액, closing = 기간 끝까지 부채 잔액, `closing = opening + settled + reversed + holdReleased − payoutGross + payoutFailedRestored`를 테스트로 확인. `withholding`·`payoutNet`은 기간 안 그 권리자의 `payout_instruction`에서. 점검: (a) 11.2-10(a) SQL, (b) 분개 합 0 위반 수(0이어야), `RECEIVABLE` 잔액 = Σ확정 run 이벤트 순액 + Σ역분개 풀 합(음수), 권리 풀 보존 = Σ미지급금·보류·원천세·PSP 정산 중·현금 전기 합의 역부호 = Σ확정 라인 + 보류 + 역분개 라인·보류(각각 SQL로 독립 계산), (c) `PENDING`·`CALCULATED` run 중 `created_at`이 기준 시간보다 오래된 것.

**Tests:** 지급까지 도는 흐름(Task 3·4 재사용) 뒤 명세 항등식과 수치, 기간 경계. 점검: 정상 흐름에서 모두 깨끗, 포함도 역분개도 안 된 환불을 인위적으로 만들면(원 run CONFIRMED 뒤 `refund-recorded`를 처리하지 않은 상태) (a)에 나타남, 오래된 PENDING run이 (c)에 나타남.

- [ ] Step 1~5, 커밋 `feat(rights-core): 권리자 명세와 정산·원장 점검`.

---

### Task 6: 발행 사전 검사와 봉인 격리

**Files:** Create `rights-core/src/engine-bridge/preflight.ts`, `rights-core/src/settlement/quarantine.ts`, `rights-core/migrations/0015_quarantine_revision.sql`(이 태스크: `quarantine`, skip 사유 `ENGINE_FAILED` 추가), `rights-core/test/settlement/quarantine.test.ts`, `rights-core/test/issuance/preflight.test.ts`; Modify `src/issuance/service.ts`(`issue`), `src/settlement/handlers.ts`(`settleRun` FAILED 경로), `src/settlement/service.ts`(`createBatch` 건너뜀), `src/scenario/run.ts`·`src/scenario/main.ts`·`test/scenario/*.test.ts`(거부된 발행 반영).

**Requirements (11.2-1):**
- `preflightIssue(ctx, tx, seal: IssueSeal): Promise<Diagnostic[]>`: 발행 봉인의 정책·facts·투영·멤버로 이벤트 `{ id: "preflight", type: policy.body.scope.events[0], amount: "1000000", currency: policy.body.scope.currency, integrity: "CLEAR" }`, `runId: "preflight"`를 `evaluate`해 진단을 돌려준다(봉인은 쓰지 않는다).
- `issue`: `sealIssue` 직후 `preflightIssue`가 진단을 내면 422 `ISSUE_NOT_SETTLEABLE`(진단 포함)을 던진다(트랜잭션 롤백으로 스냅샷·봉인 행이 남지 않는다).
- `quarantine(snapshot_id PK REFERENCES issue_seal, reason TEXT, diagnostics JSONB, created_at, released_by NULL, released_at NULL)` — `released_by`·`released_at`만 write-once UPDATE. `settleRun`의 FAILED 경로에서 같은 트랜잭션에 `INSERT … ON CONFLICT DO NOTHING`.
- `createBatch`: 후보 이벤트의 스냅샷이 해제되지 않은 격리에 있으면 `ENGINE_FAILED`로 건너뛴다(`settlement_batch_skip.reason` CHECK 확장).
- `releaseQuarantine(d, actor(SPACE_SETTLE), snapshotId)`: 해제 기록, 감사. 이후 배치에서 다시 후보.
- 시나리오: 사전 검사로 거부되는 발행은 `rejected`로 세고 다음 조합으로 넘어간다(요청한 `n`건이 발행될 때까지 시도하되 시도 상한 2n). I-1 테스트·시나리오의 `issued` 기대값을 "요청한 n"으로 유지하고 `rejected`를 리포트에 더한다. 정산 시나리오의 PASS 조건에서 `failedRuns === 0`(이제 정산 불가 조합은 발행되지 않는다)을 기대한다.

**Tests:** 멤버 한 명 조합 발행 422(`ISSUE_NOT_SETTLEABLE`, `ALLOC_INFEASIBLE` 진단, 스냅샷 행 0), 두 명 조합 정상. 격리: 정책 범위 밖 `RESALE`로 run을 FAILED시키면 격리 행 생성, 다음 배치에서 같은 스냅샷의 이벤트가 `ENGINE_FAILED`로 건너뜀, 비`SPACE_SETTLE` 해제 403, 해제 후 다음 배치에서 다시 후보(여전히 실패하면 다시 격리).

- [ ] Step 1~5, 커밋 `feat(rights-core): 발행 사전 검사(정산 불가 조합 거부)와 발행 봉인 격리`.

---

### Task 7: 운영자 run 조작·INSERT 가드·배치 일괄 INSERT

**Files:** Create `rights-core/src/settlement/operator.ts`, `rights-core/test/settlement/operator.test.ts`, `rights-core/test/settlement/guards-insert.test.ts`; Modify `0015_quarantine_revision.sql`(INSERT 가드 트리거), `src/settlement/service.ts`(`createBatch` 일괄 INSERT).

**Requirements (11.2-9·12·13):**
- `voidRun(d, actor(SPACE_SETTLE), runId, reason)`: run을 잠그고 `PENDING|CALCULATED|VERIFIED`만 → `VOIDED`(diagnostics `[{code:"OPERATOR_VOID", path:"$", message: reason}]`), 이벤트 해제, 감사. 그 밖 409.
- `requeueRun(d, actor(SPACE_SETTLE), runId)`: `PENDING` → `settle-run` 전송, `CALCULATED` → `verify-run` 전송, 그 밖 409. 감사.
- INSERT 가드(BEFORE INSERT, RC001): 11.2-12 그대로.
- `createBatch`: run·run 이벤트·포함 환불을 각각 `INSERT … SELECT * FROM unnest(...)` 한 문장씩으로 넣는다. 결과와 동작은 기존 테스트로 같아야 한다.

**Tests:** void/requeue의 상태별 허용·거부·권한, void 후 이벤트가 다음 배치에서 다시 후보, requeue한 PENDING run이 처리됨. INSERT 가드: 비`PENDING` run INSERT, `CONFIRMED` 배치에 run 추가, `CALCULATED` run에 이벤트 추가, `PENDING` run에 `line_seq=2` 라인, `CONFIRMED` 아닌 run에 역분개 라인이 모두 RC001. 기존 배치·환불 테스트 통과(일괄 INSERT 회귀 없음).

- [ ] Step 1~5, 커밋 `feat(rights-core): 운영자 run 무효화·재큐잉, INSERT 경로 가드, 배치 일괄 INSERT`.

---

### Task 8: `source_revision` 대체

**Files:** Create `rights-core/src/settlement/revision.ts`, `rights-core/test/settlement/revision.test.ts`; Modify `0015_quarantine_revision.sql`(`revenue_supersede`), `src/revenue/service.ts`, `src/settlement/service.ts`(`createBatch` 후보에서 대체된 이벤트 제외), `src/settlement/handlers.ts`, `src/engine-bridge/reverse.ts`(사유 인자), `src/platform/jobs.ts`(`revision-recorded`), `test/revenue/revenue.test.ts`.

**Requirements (11.2-11):**
- `revenue_supersede(old_event_id PK REFERENCES revenue_event, new_event_id UNIQUE REFERENCES revenue_event, recorded_at)`, 불변.
- `ingestRevenue`: 같은 `(source_system, source_event_id)`의 더 높은 revision이면(낮거나 같은 번호의 새 revision은 422 `REVISION_OUT_OF_ORDER`) 같은 유형·같은 `vc_id`(422 `REVISION_MISMATCH`), 이전 최신 revision에 환불이 없어야 함(422 `REVISION_HAS_REFUNDS`), 대체된 이벤트를 대상으로 한 환불은 422 `EVENT_SUPERSEDED`. 기록 후 `revenue_supersede`와 선택적 훅 `onRevision(tx, newEventId)`(settlement의 `revisionHook(jobs)`가 `revision-recorded` 전송 — `onRefund`와 같은 주입 방식, 필수 인자로 둔다).
- `revisionRecorded(d, { newEventId })`: 전역 배치 잠금 SHARED 먼저. 이전 이벤트가 살아 있는 run에 없으면 끝. 확정 전 run이면 run 무효화·이벤트 해제. 확정이면 `reverse-event`와 같은 절차(원 이벤트 행 잠금, priors)로 남은 정산액 전액을 `CORRECTION` 역분개(역분개 식별 이벤트 = 새 이벤트 id, `reversal_run.refund_event_id` = 새 이벤트 id, `reversal_id = rev_<new>`) + 원장 `REVERSAL` 분개. `engine-bridge/reverse.ts`의 `reverseEvent`에 `reason: "REFUND" | "CORRECTION"` 인자를 더한다.
- `createBatch` 후보: `revenue_supersede.old_event_id`에 있는 이벤트는 제외.
- 10.2-2의 `REVISION_UNSUPPORTED` 동작과 테스트를 이 규칙으로 교체한다.

**Tests:** 배치 전 대체(새 revision만 정산), 확정 전 대체(run VOIDED 후 새 revision 정산), 확정 후 대체(이전 revision 전액 CORRECTION 역분개, 새 revision 다음 배치 정산, 원장 순효과 = 새 금액), 환불 있는 이벤트 대체 422, 대체된 이벤트 환불 422, 순서 역전 422, 유형·vc 불일치 422, 동시 대체 멱등.

- [ ] Step 1~5, 커밋 `feat(rights-core): source_revision 대체(무효화·CORRECTION 역분개)`.

---

### Task 9: 운영 스크립트·풀 설정·HTTP API

**Files:** Create `rights-core/src/platform/migrate-cli.ts`, `rights-core/src/ledger/routes.ts`, `rights-core/src/payout/routes.ts`, `rights-core/test/http/ledger-api.test.ts`, `rights-core/test/platform/migrate-cli.test.ts`; Modify `rights-core/package.json`(`"migrate": "node src/platform/migrate-cli.ts"`), `src/platform/db.ts`(`createDb(url, { max })`), `src/http/server.ts`, `src/http/main.ts`, `src/settlement/routes.ts`.

**Requirements (11.2-14 + 라우트):**
- `migrate-cli`: `RC_ADMIN_URL`(필수)로 연결해 `migrate`, `installJobSchema`(큐 생성·권한), `rc_app` 권한 확인을 순서대로 수행하고 적용한 마이그레이션·큐 목록을 출력한다. 두 번 실행해도 안전(멱등). 테스트: 빈 DB(템플릿 아님)를 관리자 역할로 만들어 CLI 함수(`runMigrations(adminUrl)`)를 두 번 호출 → 두 번째는 적용 0, 이후 `rc_app`으로 `startBossJobs` 가능.
- `createDb(url, opts?: { max?: number })`, main은 `RC_DB_POOL_MAX`(기본 20, 양의 정수 아니면 시작 거부).
- 라우트(역할은 서비스가 검사):

| 메서드·경로 | 서비스 | 역할 |
|---|---|---|
| `POST /holds/:id/release` `{allocation}` | `releaseHold` | SPACE_SETTLE |
| `GET /holds/:id/suggestion` | `suggestFraudRelease` | SPACE_SETTLE |
| `PUT /parties/:id/payout-profile` | `setPayoutProfile` | SPACE_SETTLE |
| `POST /payout-runs` `{payoutRunId, asOf}` | `createPayoutRun` | SPACE_SETTLE |
| `POST /psp/webhook` | `recordWebhook` | (PoC: 신원 없음, 공유 비밀 헤더 `x-psp-secret`를 env `RC_PSP_SECRET`와 비교 — 없으면 401) |
| `GET /parties/:id/statements?from&to` | `partyStatement` | SPACE_SETTLE |
| `GET /ledger/trial-balance` | `trialBalance` | SPACE_SETTLE |
| `GET /settlement/invariants` | `invariants` | SPACE_SETTLE |
| `POST /runs/:id/void` `{reason}`, `POST /runs/:id/requeue` | `voidRun`, `requeueRun` | SPACE_SETTLE |
| `POST /quarantine/:snapshotId/release` | `releaseQuarantine` | SPACE_SETTLE |

- main: `payoutJobHandlers({ ...deps, provider: fakeProvider() })`를 합쳐 모든 `JOB_NAMES`에 처리기가 있는지 검사(없으면 시작 거부). 운영 PSP는 I-2c 이후 — `RC_PSP=fake`만 허용하고 그 밖은 시작 거부.

**Tests:** HTTP로 확정 → 원장 → 보류 해제 → 프로필 → 지급 실행 → webhook(비밀 헤더 없으면 401, 중복 200) → 명세·시산표·점검 조회, 각 라우트의 403.

- [ ] Step 1~5, 커밋 `feat(rights-core): 원장·지급 HTTP API, 운영 마이그레이션 CLI, DB 풀 설정`.

---

### Task 10: 원장·지급 시나리오와 결과 기록

**Files:** Create `rights-core/src/scenario/ledger.ts`, `rights-core/test/scenario/ledger.test.ts`; Modify `src/scenario/main.ts`, 설계 문서 11.4·10.5.

**Requirements:** I-2a 정산 시나리오(사전 검사 도입으로 `failedRuns = 0` 기대) 뒤에 이어서:
1. `post-batch`를 실제 pg-boss로 처리하고 `drainIdle`.
2. 보류(`FRAUD_REVIEW`)의 절반을 `suggestFraudRelease` 제안대로 해제한다.
3. 권리자 프로필: 80% `DOMESTIC_INDIVIDUAL`(계좌·KYC 있음, `first_payable_at`을 과거로), 10% KYC 미확인, 10% `DOMESTIC_CORP`.
4. 지급 실행(`asOf` = 시나리오 시계), 가짜 PSP로 제출·재조회·webhook 일부 중복 전송, `drainIdle`.
5. 점검 API: 미반영 환불 0, 분개 합 위반 0, `RECEIVABLE`·권리 풀 보존 true.
6. 권리자별 명세 항등식(closing = opening + … )을 전원 확인, 명세의 지급 총액 합 = `payout_instruction` 합.
7. 리포트: 분개 수, 권리자 수, 지급 PAID/FAILED/CARRIED/HELD 수, 원천세 합, 처리 시간(원장 반영·해제·지급·결과 반영).
PASS 조건에 원장 불변식·명세 항등식·중복 결과 적용 0을 더한다. 축소 테스트(100 발행·300 매출)로 TDD 하고, `npm run scenario -- --settle 30000` 전체 실행 후 설계 문서 11.4에 실제 값 표를 쓴다(10.4 형식). 10.5 목록에서 이번에 끝낸 항목에 `완료(I-2b)`를 표시한다(9번 어댑터 연결 순서는 남긴다).

- [ ] Step 1~5, 커밋 `feat(rights-core): 원장·지급 시나리오와 I-2b 결과 기록`.
