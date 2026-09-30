import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue, noRefundHook } from "../../src/revenue/service.ts";
import { confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers, refundRecorded } from "../../src/settlement/handlers.ts";
import { invariants, type InvariantReport } from "../../src/settlement/invariants.ts";
import { issueCombo, ledgerFlow, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
await issueCombo(w, "vc_1");

const NOW = "2026-08-01T00:00:00.000Z";
const check = (now = NOW, opts?: { stuckAfterMinutes?: number }) => w.db.tx((tx) => invariants(tx, fixedClock(now, 0), opts));
const clean = (r: InvariantReport, label: string) => {
  assert.deepEqual(r.unreflectedRefunds, [], label);
  assert.equal(r.ledger.entriesUnbalanced, 0, label);
  assert.equal(r.ledger.receivableMatchesSettlement, true, label);
  assert.equal(r.ledger.rightsConserved, true, label);
  assert.deepEqual(r.ledger.unpostedConfirmedRuns, [], label);
  assert.deepEqual(r.stuckRuns, [], label);
};

test("an empty ledger is clean", async () => {
  clean(await check(), "empty");
});

test("every phase of settle → release → reverse after release → pay (one failure) → repay is clean", async () => {
  const seen: string[] = [];
  await ledgerFlow(w, async (phase) => {
    seen.push(phase);
    const r = await check();
    clean(r, phase);
    assert.notEqual(r.ledger.receivable, "0", phase);
    assert.notEqual(r.ledger.rightsPooled, "0", phase);
    assert.equal(r.ledger.receivable, r.ledger.settledReceivable, phase);
    assert.equal(r.ledger.rightsBalance, r.ledger.rightsPooled, phase);
  });
  assert.deepEqual(seen, ["settled", "released", "reversed", "paid", "repaid"]);
  // 흐름에 역분개·해제·실패 지급이 실제로 있었다.
  const kinds = (await w.db.pool.query("SELECT DISTINCT kind FROM journal_entry ORDER BY kind")).rows.map((x) => x.kind);
  assert.deepEqual(kinds, ["HOLD_RELEASE", "PAYOUT", "PAYOUT_FAILED", "PAYOUT_SETTLED", "REVERSAL", "SETTLEMENT"]);
});

const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: fixedClock("2026-09-10T00:00:00.000Z", 1), jobs };

test("a confirmed run not yet posted is listed separately and does not fail the ledger checks", async () => {
  await purchase(w, "ev_s", "vc_1", "20000", "2026-09-01T00:00:00.000Z");
  await createBatch(d, w.users.ops, { batchId: "bat_sep", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z" });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_sep");
  const run = (await w.db.pool.query("SELECT run_id FROM settlement_run WHERE batch_id = 'bat_sep'")).rows[0].run_id as string;
  const r = await check("2026-09-11T00:00:00.000Z");
  assert.deepEqual(r.ledger.unpostedConfirmedRuns, [run]);
  assert.equal(r.ledger.receivableMatchesSettlement, true);
  assert.equal(r.ledger.rightsConserved, true);
  await jobs.drain(jobHandlers(d));   // post-batch
  clean(await check("2026-09-11T00:00:00.000Z"), "posted");
});

test("a refund that is neither included nor reversed shows up until refund-recorded runs", async () => {
  // 확정 run의 이벤트에 환불을 기록하되 refund-recorded를 보내지 않는다(작업 유실을 흉내).
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "rf_lost", sourceSystem: "app", sourceEventId: "rf_lost", eventType: "REFUND", relatedEventId: "ev_s", amountKrw: "5000", currency: "KRW", occurredAt: "2026-09-12T00:00:00.000Z",
  }, noRefundHook));
  const run = (await w.db.pool.query("SELECT run_id FROM settlement_run WHERE batch_id = 'bat_sep'")).rows[0].run_id as string;
  const r = await check("2026-09-13T00:00:00.000Z");
  assert.deepEqual(r.unreflectedRefunds, [{ refundEventId: "rf_lost", originalEventId: "ev_s", runId: run }]);
  assert.equal(r.ledger.receivableMatchesSettlement, true);
  await refundRecorded(d, { refundEventId: "rf_lost" });
  await jobs.drain(jobHandlers(d));   // reverse-event
  clean(await check("2026-09-13T00:00:00.000Z"), "reversed");
});

test("a refund already included in a run's net, or on an event of an unconfirmed run, is not listed", async () => {
  // 포함: 배치 전에 기록된 환불(순액에 포함).
  await purchase(w, "ev_i", "vc_1", "30000", "2026-10-01T00:00:00.000Z");
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "rf_i", sourceSystem: "app", sourceEventId: "rf_i", eventType: "REFUND", relatedEventId: "ev_i", amountKrw: "1000", currency: "KRW", occurredAt: "2026-10-02T00:00:00.000Z",
  }, refundHook(jobs)));
  await jobs.drain(jobHandlers(d));
  await createBatch(d, w.users.ops, { batchId: "bat_oct", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z" });
  await jobs.drain(jobHandlers(d));
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM settlement_run_event_refund WHERE refund_event_id = 'rf_i'")).rows[0].n, 1);
  // 확정 전 run의 이벤트에 대한 환불(작업 없음)은 (a) 대상이 아니다.
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "rf_v", sourceSystem: "app", sourceEventId: "rf_v", eventType: "REFUND", relatedEventId: "ev_i", amountKrw: "1000", currency: "KRW", occurredAt: "2026-10-03T00:00:00.000Z",
  }, noRefundHook));
  const r = await check("2026-09-10T01:00:00.000Z");
  assert.deepEqual(r.unreflectedRefunds, []);
  await confirmBatch(d, w.users.settle, "bat_oct");
  await jobs.drain(jobHandlers(d));
  const after = await check("2026-09-10T01:00:00.000Z");
  assert.deepEqual(after.unreflectedRefunds.map((x) => x.refundEventId), ["rf_v"], "now the run is confirmed, the unprocessed refund shows");
  await refundRecorded(d, { refundEventId: "rf_v" });
  await jobs.drain(jobHandlers(d));
  clean(await check("2026-09-10T01:00:00.000Z"), "all reflected");
});

test("PENDING and CALCULATED runs older than the threshold are stuck", async () => {
  await purchase(w, "ev_n", "vc_1", "30000", "2026-11-01T00:00:00.000Z");
  await createBatch(d, w.users.ops, { batchId: "bat_nov", periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-12-01T00:00:00.000Z" });
  const run = (await w.db.pool.query("SELECT run_id, created_at FROM settlement_run WHERE batch_id = 'bat_nov'")).rows[0];
  const created = (run.created_at as Date).toISOString();
  const plus = (min: number) => new Date(Date.parse(created) + min * 60_000).toISOString();
  assert.deepEqual((await check(plus(59))).stuckRuns, [], "default threshold is 60 minutes");
  assert.deepEqual((await check(plus(61))).stuckRuns, [{ runId: run.run_id, status: "PENDING", since: created }]);
  assert.deepEqual((await check(plus(6), { stuckAfterMinutes: 5 })).stuckRuns, [{ runId: run.run_id, status: "PENDING", since: created }]);
  await jobs.drain({ "settle-run": jobHandlers(d)["settle-run"]! });
  assert.deepEqual((await check(plus(61))).stuckRuns, [{ runId: run.run_id, status: "CALCULATED", since: created }]);
  await jobs.drain(jobHandlers(d));
  assert.deepEqual((await check(plus(61))).stuckRuns, [], "VERIFIED is not stuck");
  await assert.rejects(check(NOW, { stuckAfterMinutes: 0 }), { code: "INVALID_THRESHOLD", status: 422 });
  await assert.rejects(check(NOW, { stuckAfterMinutes: 1.5 }), { code: "INVALID_THRESHOLD", status: 422 });
});

test("entries that bypass the balance trigger are counted and break the matching checks", async () => {
  // 알려진 우회: 같은 트랜잭션에서 rc.bal_last를 새 분개 id로 먼저 두면 지연 트리거가 그 분개를 건너뛴다.
  const bypass = (ref: string, account: string, amount: string) => w.db.tx(async (tx) => {
    const id = (await tx.query("INSERT INTO journal_entry (kind, source_ref, occurred_at, created_by) VALUES ('ADJUSTMENT', $1, '2026-12-01T00:00:00.000Z', 'usr_settle') RETURNING entry_id", [ref])).rows[0].entry_id;
    await tx.query("SELECT set_config('rc.bal_last', $1, true)", [String(id)]);
    await tx.query("INSERT INTO posting (entry_id, account_id, amount_krw) VALUES ($1, $2, $3)", [id, account, amount]);
  });
  await bypass("bad:1", "RECEIVABLE", "7");
  const r1 = await check();
  assert.equal(r1.ledger.entriesUnbalanced, 1);
  assert.equal(r1.ledger.receivableMatchesSettlement, false);
  assert.equal(r1.ledger.rightsConserved, true);
  await bypass("bad:2", "PARTY_PAYABLE:pty_label", "-3");
  const r2 = await check();
  assert.equal(r2.ledger.entriesUnbalanced, 2);
  assert.equal(r2.ledger.rightsConserved, false);
});
