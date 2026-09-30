import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue } from "../../src/revenue/service.ts";
import { confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { postConfirmedRun } from "../../src/settlement/posting.ts";
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
  await assertLedgerMatchesLines();
  const ev1 = await w.db.pool.query(
    "SELECT COALESCE(SUM(p.amount_krw),0)::text AS s FROM posting p JOIN ledger_account a USING (account_id) WHERE a.kind = 'PARTY_PAYABLE' AND p.event_id = 'ev_1'");
  assert.equal(BigInt(ev1.rows[0].s), 0n, "a full refund nets ev_1 payables to zero");
});

test("a reversal that runs before post-batch writes SETTLEMENT first; post-batch then writes nothing", async () => {
  const Q = { periodStart: "2026-04-01T00:00:00.000Z", periodEnd: "2026-05-01T00:00:00.000Z" };
  await purchase(w, "ev_3", "vc_1", "5000", "2026-04-02T00:00:00.000Z");
  await createBatch(d, w.users.ops, { batchId: "bat_m", ...Q });
  const noPost = () => { const h = jobHandlers(d); delete h["post-batch"]; return h; };
  await jobs.drain(noPost());
  await confirmBatch(d, w.users.settle, "bat_m");
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "rf_3", sourceSystem: "app", sourceEventId: "rf_3", eventType: "REFUND", relatedEventId: "ev_3", amountKrw: "2000", currency: "KRW", occurredAt: "2026-04-03T00:00:00.000Z",
  }, refundHook(jobs)));
  await jobs.drain(noPost());
  const run = (await w.db.pool.query("SELECT run_id FROM settlement_run_event WHERE event_id = 'ev_3'")).rows[0].run_id;
  const ids = await w.db.pool.query("SELECT kind, entry_id::int AS id FROM journal_entry WHERE source_ref IN ($1, 'rev:rev_rf_3') ORDER BY entry_id", [`run:${run}`]);
  assert.deepEqual(ids.rows.map((r) => r.kind), ["SETTLEMENT", "REVERSAL"]);
  const before = (await w.db.pool.query("SELECT count(*)::int AS n FROM journal_entry")).rows[0].n;
  await jobs.drain(jobHandlers(d));
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM journal_entry")).rows[0].n, before, "post-batch finds the run already posted");
  assert.equal(await w.db.tx((tx) => balance(tx, { kind: "RECEIVABLE" })), 1001n + 3000n);
  await assertLedgerMatchesLines();
});

test("postConfirmedRun refuses a run that is not CONFIRMED", async () => {
  await purchase(w, "ev_4", "vc_1", "3000", "2026-05-02T00:00:00.000Z");
  await createBatch(d, w.users.ops, { batchId: "bat_n", periodStart: "2026-05-01T00:00:00.000Z", periodEnd: "2026-06-01T00:00:00.000Z" });
  const run = (await w.db.pool.query("SELECT run_id FROM settlement_run WHERE batch_id = 'bat_n'")).rows[0].run_id;
  await assert.rejects(w.db.tx((tx) => postConfirmedRun(tx, w.clock, run)), { code: "INVALID_STATE", status: 409 });
});

/** 원장 = 라인: ΣPARTY_PAYABLE = −Σallocation_line, ΣHOLD = −Σunallocated_holding, 풀 계정 = −Σ비권리 pool_line(모든 line_seq). */
async function assertLedgerMatchesLines(): Promise<void> {
  const q = async (sql: string) => BigInt((await w.db.pool.query(sql)).rows[0].s);
  const byKind = (k: string) => q(`SELECT COALESCE(SUM(amount_krw),0)::text AS s FROM posting p JOIN ledger_account a USING (account_id) WHERE a.kind = '${k}'`);
  assert.equal(await byKind("PARTY_PAYABLE"), -(await q("SELECT COALESCE(SUM(amount_krw),0)::text AS s FROM allocation_line")));
  assert.equal(await byKind("HOLD"), -(await q("SELECT COALESCE(SUM(amount_krw),0)::text AS s FROM unallocated_holding")));
  const rights = (await w.db.pool.query(
    `SELECT DISTINCT d.content->'body'->'tier1'->>'rights' AS r FROM settlement_run r JOIN issue_seal s ON s.snapshot_id = r.snapshot_id
       JOIN sealed_document d ON d.digest = s.policy_digest`)).rows.map((x) => x.r as string);
  assert.equal(rights.length, 1);
  const pools = await w.db.pool.query(
    `SELECT CASE bucket WHEN 'platform' THEN 'POOL_PLATFORM' WHEN 'ops' THEN 'POOL_OPS' WHEN 'fan' THEN 'POOL_FAN' ELSE 'POOL_OTHER:' || bucket END AS account_id,
            SUM(pl.amount_krw)::text AS s
       FROM pool_line pl JOIN settlement_run r USING (run_id) WHERE r.status = 'CONFIRMED' AND bucket <> $1 GROUP BY 1 ORDER BY 1`, [rights[0]]);
  assert.ok(pools.rows.length > 0);
  for (const p of pools.rows) {
    assert.equal(await w.db.tx((tx) => balance(tx, poolKey(p.account_id))), -BigInt(p.s), p.account_id);
  }
}

function poolKey(id: string) {
  if (id.startsWith("POOL_OTHER:")) return { kind: "POOL_OTHER" as const, bucket: id.slice("POOL_OTHER:".length) };
  return { kind: id as "POOL_PLATFORM" | "POOL_OPS" | "POOL_FAN" };
}
