import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue } from "../../src/revenue/service.ts";
import { batchView, confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers, reverseEventJob } from "../../src/settlement/handlers.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const P = { periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" };
const refund = (id: string, original: string, amount: string) => w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
  eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "REFUND", relatedEventId: original, amountKrw: amount, currency: "KRW", occurredAt: "2026-03-10T00:00:00.000Z",
}, refundHook(jobs)));
const net = async (eventId: string) => {
  const r = await w.db.pool.query(
    `SELECT COALESCE(SUM(p.amount_krw), 0)::text AS pool FROM pool_line p JOIN settlement_run r ON r.run_id = p.run_id
      WHERE p.event_id = $1 AND r.status = 'CONFIRMED'`, [eventId]);
  return BigInt(r.rows[0].pool);
};

await issueCombo(w, "vc_1");
await issueCombo(w, "vc_2", "b", "a");

test("refund before any batch: the next batch settles the net amount; a full refund is skipped", async () => {
  await purchase(w, "ev_a", "vc_1", "10000");
  await purchase(w, "ev_b", "vc_1", "2000");
  await refund("rf_a", "ev_a", "2500");
  await refund("rf_b", "ev_b", "2000");
  await jobs.drain(jobHandlers(d));
  const b = await createBatch(d, w.users.ops, { batchId: "bat_pre", ...P });
  assert.ok(b.skipped.some((s) => s.eventId === "ev_b" && s.reason === "FULLY_REFUNDED"));
  const e = await w.db.pool.query("SELECT net_amount_krw::text AS net, refunds_included_krw::text AS inc FROM settlement_run_event WHERE event_id = 'ev_a'");
  assert.deepEqual(e.rows[0], { net: "7500", inc: "2500" });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_pre");
  assert.equal(await net("ev_a"), 7500n);
});

test("refund before confirmation voids the run; the next batch re-evaluates the new net", async () => {
  await purchase(w, "ev_c", "vc_2", "8000");
  const b = await createBatch(d, w.users.ops, { batchId: "bat_mid", ...P });
  await jobs.drain(jobHandlers(d));
  await refund("rf_c", "ev_c", "3000");
  await jobs.drain(jobHandlers(d));
  const v = await w.db.tx((tx) => batchView(tx, "bat_mid"));
  assert.deepEqual(v.runs.map((r) => r.status), ["VOIDED"]);
  assert.equal(v.progress, "EMPTY");
  const b2 = await createBatch(d, w.users.ops, { batchId: "bat_mid2", ...P });
  assert.equal(b2.runs.length, 1);
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_mid2");
  assert.equal(await net("ev_c"), 5000n);
  assert.ok(b.runs.length === 1);
});

test("refunds after confirmation are reversed in sequence and net the event to exactly zero", async () => {
  await purchase(w, "ev_d", "vc_1", "10001");
  await createBatch(d, w.users.ops, { batchId: "bat_post", ...P });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_post");
  await refund("rf_d1", "ev_d", "3333");
  await refund("rf_d2", "ev_d", "1");
  await jobs.drain(jobHandlers(d));
  const seq = await w.db.pool.query("SELECT refund_event_id, sequence FROM reversal_run WHERE event_id = 'ev_d' ORDER BY sequence");
  assert.deepEqual(seq.rows.map((r) => [r.refund_event_id, r.sequence]), [["rf_d1", 1], ["rf_d2", 2]]);
  assert.equal(await net("ev_d"), 10001n - 3334n);
  await refund("rf_d3", "ev_d", "6667");
  await jobs.drain(jobHandlers(d));
  assert.equal(await net("ev_d"), 0n);
  const lines = await w.db.pool.query(
    `SELECT party_id, bucket, SUM(amount_krw)::text AS s FROM allocation_line WHERE event_id = 'ev_d' GROUP BY party_id, bucket`);
  assert.ok(lines.rows.every((r) => r.s === "0"), JSON.stringify(lines.rows));
  const rev = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line WHERE event_id = 'ev_d' AND line_kind = 'REVERSAL' AND reversal_of_line_id IS NULL");
  assert.equal(rev.rows[0].n, 0);
});

test("reverse-event is idempotent per refund id", async () => {
  const before = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line");
  await reverseEventJob(d, { refundEventId: "rf_d1" });
  const after2 = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line");
  assert.equal(after2.rows[0].n, before.rows[0].n);
});
