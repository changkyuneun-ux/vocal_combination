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
  assert.equal(b.runs.length, 1);
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

test("a refund counted in the batch net is never reversed, even if its job runs after confirmation", async () => {
  await purchase(w, "ev_e", "vc_1", "10000");
  await refund("rf_e1", "ev_e", "1000");
  await createBatch(d, w.users.ops, { batchId: "bat_race", ...P });
  const h = jobHandlers(d);
  await jobs.drain({ "settle-run": h["settle-run"], "verify-run": h["verify-run"] });
  await confirmBatch(d, w.users.settle, "bat_race");
  const inc = await w.db.pool.query("SELECT refund_event_id FROM settlement_run_event_refund WHERE event_id = 'ev_e'");
  assert.deepEqual(inc.rows.map((r) => r.refund_event_id), ["rf_e1"]);
  await refund("rf_e2", "ev_e", "500");
  await jobs.drain(jobHandlers(d));
  const rev = await w.db.pool.query("SELECT refund_event_id FROM reversal_run WHERE event_id = 'ev_e' ORDER BY sequence");
  assert.deepEqual(rev.rows.map((r) => r.refund_event_id), ["rf_e2"]);
  assert.equal(await net("ev_e"), 10000n - 1000n - 500n);
  await reverseEventJob(d, { refundEventId: "rf_e1" });
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM reversal_run WHERE event_id = 'ev_e'")).rows[0].n, 1);
});

test("a reversal exceeding the settled amount is rejected once: audited, no reversal written, job completes", async () => {
  await purchase(w, "ev_f", "vc_1", "4000");
  await createBatch(d, w.users.ops, { batchId: "bat_rej", ...P });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_rej");
  // 수집 서비스의 누적 상한을 우회한(= 버그를 흉내 낸) 초과 환불 행.
  await w.db.pool.query(
    `INSERT INTO revenue_event (event_id, source_system, source_event_id, event_type, related_event_id, net_amount_krw, currency, occurred_at, recorded_at)
     VALUES ('rf_f1','app','rf_f1','REFUND','ev_f',4001,'KRW','2026-03-10T00:00:00.000Z',$1)`, [w.clock.now()]);
  await reverseEventJob(d, { refundEventId: "rf_f1" });
  await reverseEventJob(d, { refundEventId: "rf_f1" });
  const a = await w.db.pool.query("SELECT entity_id, after_json FROM audit_log WHERE action_name = 'REVERSAL_REJECTED'");
  assert.equal(a.rows.length, 1);
  assert.equal(a.rows[0].entity_id, "rf_f1");
  assert.ok(JSON.stringify(a.rows[0].after_json).includes("REV_EXCEEDS_REMAINING"));
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM reversal_run WHERE event_id = 'ev_f'")).rows[0].n, 0);
});

test("refund ingest waits for an in-flight batch creation (global batching lock)", async () => {
  await purchase(w, "ev_g", "vc_1", "6000");
  const batch = await w.db.pool.connect();
  try {
    await batch.query("BEGIN");
    await batch.query("SELECT pg_advisory_xact_lock(hashtextextended('settlement:batching', 0))");
    let done = false;
    const ingest = refund("rf_g", "ev_g", "1000").then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(done, false, "refund ingest must block while a batch holds the lock");
    await batch.query("COMMIT");
    await ingest;
    assert.equal(done, true);
  } finally {
    batch.release();
  }
  await jobs.drain(jobHandlers(d));
});

test("createBatch racing a refund: the refund is either counted in the net or voids the run", async () => {
  await purchase(w, "ev_h", "vc_1", "7000");
  await Promise.all([
    createBatch(d, w.users.ops, { batchId: "bat_h", ...P }),
    refund("rf_h", "ev_h", "700"),
  ]);
  await jobs.drain(jobHandlers(d));
  const x = (await w.db.pool.query(
    `SELECT r.status, x.net_amount_krw::text AS net,
            EXISTS (SELECT 1 FROM settlement_run_event_refund f WHERE f.run_id = x.run_id AND f.event_id = x.event_id AND f.refund_event_id = 'rf_h') AS counted
       FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id WHERE x.event_id = 'ev_h' AND r.batch_id = 'bat_h'`)).rows[0];
  assert.ok((x.counted && x.net === "6300" && x.status === "VERIFIED") || (!x.counted && x.net === "7000" && x.status === "VOIDED"), JSON.stringify(x));
});
