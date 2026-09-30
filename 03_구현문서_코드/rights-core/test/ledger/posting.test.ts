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
