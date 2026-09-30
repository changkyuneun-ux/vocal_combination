import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue, noRefundHook } from "../../src/revenue/service.ts";
import { batchView, confirmBatch, createBatch, refundHook, revisionHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { revisionRecorded } from "../../src/settlement/revision.ts";
import { releaseHold } from "../../src/settlement/holds.ts";
import { invariants, invariantsInTx, type InvariantReport } from "../../src/settlement/invariants.ts";
import { suggestFraudRelease } from "../../src/engine-bridge/fraud-release.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const P = { periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" };

/** source 이벤트 `src`의 revision `rev`를 `eventId`로 수집한다(설정된 훅으로). */
const revise = (eventId: string, src: string, rev: number, amountKrw: string, integrity: "CLEAR" | "FLAGGED" = "CLEAR") =>
  w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId, sourceSystem: "app", sourceEventId: src, sourceRevision: rev, eventType: "PURCHASE", vcId: "vc_1",
    amountKrw, currency: "KRW", occurredAt: "2026-03-05T00:00:00.000Z", integrity,
  }, refundHook(jobs), revisionHook(jobs)));
/** 확정 run의 풀 라인 합(원 결과 + 역분개). */
const settled = async (eventId: string) => BigInt((await w.db.pool.query(
  `SELECT COALESCE(SUM(p.amount_krw), 0)::text AS s FROM pool_line p JOIN settlement_run r ON r.run_id = p.run_id
    WHERE p.event_id = $1 AND r.status = 'CONFIRMED'`, [eventId])).rows[0].s);
/** 원장 RECEIVABLE 순효과(이벤트 목록). */
const receivable = async (...eventIds: string[]) => BigInt((await w.db.pool.query(
  `SELECT COALESCE(SUM(p.amount_krw), 0)::text AS s FROM posting p JOIN ledger_account a USING (account_id)
    WHERE a.kind = 'RECEIVABLE' AND p.event_id = ANY($1)`, [eventIds])).rows[0].s);
const clean = async (label: string) => {
  const r: InvariantReport = await invariants(w.db, fixedClock("2026-08-01T00:00:00.000Z", 0), { stuckAfterMinutes: 60 * 24 * 365 });
  assert.deepEqual(r.unreflectedRefunds, [], label);
  assert.equal(r.ledger.entriesUnbalanced, 0, label);
  assert.equal(r.ledger.receivableMatchesSettlement, true, `${label}: ${r.ledger.receivable} vs ${r.ledger.settledReceivable}`);
  assert.equal(r.ledger.rightsConserved, true, `${label}: ${r.ledger.rightsBalance} vs ${r.ledger.rightsPooled}`);
  assert.deepEqual(r.ledger.unpostedConfirmedRuns, [], label);
  assert.deepEqual(r.ledger.unpostedReversals, [], label);
  assert.deepEqual(r.ledger.poolMismatches, [], label);
};
let n = 0;
/** 배치 생성 → settle·verify → 확정 → post-batch. */
const settle = async () => {
  const batchId = `bat_${++n}`;
  const b = await createBatch(d, w.users.ops, { batchId, ...P });
  await jobs.drain(jobHandlers(d));
  if (b.runs.length > 0) await confirmBatch(d, w.users.settle, batchId);
  await jobs.drain(jobHandlers(d));
  return b;
};

await issueCombo(w, "vc_1");

test("supersede before any batch: only the new revision is settled", async () => {
  await revise("ev_a1", "pay_a", 1, "10000");
  await revise("ev_a2", "pay_a", 2, "7000");
  assert.deepEqual(jobs.sent.filter((j) => j.name === "revision-recorded").map((j) => j.data), [{ newEventId: "ev_a2" }]);
  await jobs.drain(jobHandlers(d));
  const b = await settle();
  const events = (await w.db.pool.query("SELECT event_id, net_amount_krw::text AS net FROM settlement_run_event WHERE run_id = ANY($1)", [b.runs])).rows;
  assert.deepEqual(events, [{ event_id: "ev_a2", net: "7000" }]);
  assert.deepEqual(b.skipped, [], "a superseded event is not a candidate at all (not even a skip)");
  assert.equal(await settled("ev_a2"), 7000n);
  assert.equal(await receivable("ev_a1", "ev_a2"), 7000n);
  await clean("pre-batch");
});

test("supersede before confirmation voids the run; the new revision waits, then settles in the next batch", async () => {
  await revise("ev_b1", "pay_b", 1, "8000");
  const b1 = await createBatch(d, w.users.ops, { batchId: "bat_b1", ...P });
  await jobs.drain(jobHandlers(d));
  assert.deepEqual((await w.db.tx((tx) => batchView(tx, "bat_b1"))).runs.map((r) => r.status), ["VERIFIED"]);
  // 작업이 돌기 전: 이전 revision이 확정 전 run에 살아 있으므로 새 revision은 건너뛴다.
  await revise("ev_b2", "pay_b", 2, "6000");
  const early = await createBatch(d, w.users.ops, { batchId: "bat_b_early", ...P });
  assert.deepEqual(early.runs, []);
  assert.deepEqual(early.skipped, [{ eventId: "ev_b2", reason: "REVISION_PENDING" }]);
  await jobs.drain(jobHandlers(d));
  const v = await w.db.tx((tx) => batchView(tx, "bat_b1"));
  assert.deepEqual(v.runs.map((r) => r.status), ["VOIDED"]);
  const diag = (await w.db.pool.query("SELECT diagnostics FROM settlement_run WHERE run_id = $1", [b1.runs[0]])).rows[0].diagnostics;
  assert.equal(diag[0].code, "SUPERSEDED_BEFORE_CONFIRMATION");
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM settlement_run_event WHERE event_id = 'ev_b1' AND active")).rows[0].n, 0);
  const b = await settle();
  const events = (await w.db.pool.query("SELECT event_id FROM settlement_run_event WHERE run_id = ANY($1)", [b.runs])).rows.map((r) => r.event_id);
  assert.deepEqual(events, ["ev_b2"]);
  assert.equal(await settled("ev_b1"), 0n);
  assert.equal(await settled("ev_b2"), 6000n);
  assert.equal(await receivable("ev_b1", "ev_b2"), 6000n);
  await clean("pre-confirmation");
});

test("supersede after confirmation reverses the old revision in full (CORRECTION); the ledger nets to the new amount", async () => {
  await revise("ev_c1", "pay_c", 1, "10001");
  await settle();
  await clean("settled c1");
  await revise("ev_c2", "pay_c", 2, "5000");
  // 역분개가 쓰이기 전에는 새 revision을 정산하지 않는다(이중 계상 방지).
  const early = await createBatch(d, w.users.ops, { batchId: "bat_c_early", ...P });
  assert.deepEqual(early.skipped, [{ eventId: "ev_c2", reason: "REVISION_PENDING" }]);
  await jobs.drain(jobHandlers(d));
  const rv = (await w.db.pool.query("SELECT reversal_id, event_id, refund_event_id, sequence, result_digest FROM reversal_run WHERE event_id = 'ev_c1'")).rows;
  assert.equal(rv.length, 1);
  assert.deepEqual({ ...rv[0], result_digest: undefined }, { reversal_id: "rev_ev_c2", event_id: "ev_c1", refund_event_id: "ev_c2", sequence: 1, result_digest: undefined });
  const sealed = (await w.db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [rv[0].result_digest])).rows[0].content;
  assert.match(JSON.stringify(sealed), /"reason":"CORRECTION"/);
  assert.match(JSON.stringify(sealed), /"amount":"10001"/);
  assert.equal(await settled("ev_c1"), 0n);
  const lines = await w.db.pool.query("SELECT party_id, bucket, SUM(amount_krw)::text AS s FROM allocation_line WHERE event_id = 'ev_c1' GROUP BY party_id, bucket");
  assert.ok(lines.rows.length > 0 && lines.rows.every((r) => r.s === "0"), JSON.stringify(lines.rows));
  const entry = (await w.db.pool.query("SELECT kind FROM journal_entry WHERE source_ref = 'rev:rev_ev_c2'")).rows;
  assert.deepEqual(entry, [{ kind: "REVERSAL" }]);
  assert.equal(await receivable("ev_c1"), 0n);
  await clean("corrected c1");
  const b = await settle();
  assert.deepEqual((await w.db.pool.query("SELECT event_id FROM settlement_run_event WHERE run_id = ANY($1)", [b.runs])).rows.map((r) => r.event_id), ["ev_c2"]);
  assert.equal(await settled("ev_c2"), 5000n);
  assert.equal(await receivable("ev_c1", "ev_c2"), 5000n);
  await clean("settled c2");
  // 새 revision에 대한 환불은 평소대로 역분개된다(이전 revision은 EVENT_SUPERSEDED).
  const refund = (id: string, rel: string) => w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "REFUND", relatedEventId: rel, amountKrw: "1000", currency: "KRW", occurredAt: "2026-03-20T00:00:00.000Z",
  }, refundHook(jobs), revisionHook(jobs)));
  await assert.rejects(refund("rf_c1", "ev_c1"), { code: "EVENT_SUPERSEDED", status: 422 });
  await refund("rf_c2", "ev_c2");
  await jobs.drain(jobHandlers(d));
  assert.equal(await receivable("ev_c1", "ev_c2"), 4000n);
  await clean("refunded c2");
});

test("a correction after a hold release follows the post-release weighting and stays clean", async () => {
  await revise("ev_h1", "pay_h", 1, "100000", "FLAGGED");
  await settle();
  const hold = (await w.db.pool.query("SELECT holding_id::text AS id, amount_krw::text AS a FROM unallocated_holding WHERE event_id = 'ev_h1' AND line_seq = 1")).rows[0];
  const s = await w.db.tx((tx) => suggestFraudRelease(w.ctx, tx, hold.id));
  await releaseHold(d, w.users.settle, { holdingId: hold.id, allocation: s.allocation });
  await clean("released h1");
  await revise("ev_h2", "pay_h", 2, "90000");
  await jobs.drain(jobHandlers(d));
  const back = await w.db.pool.query("SELECT SUM(amount_krw)::text AS s FROM hold_release_reversal WHERE reversal_id = 'rev_ev_h2'");
  assert.equal(back.rows[0].s, hold.a, "the whole released hold is taken back from the parties");
  assert.equal(await receivable("ev_h1"), 0n);
  await clean("corrected h1");
  await settle();
  assert.equal(await receivable("ev_h1", "ev_h2"), 90000n);
  await clean("settled h2");
});

test("a newer revision that arrives before the previous correction is written waits for it", async () => {
  await revise("ev_e1", "pay_e", 1, "3000");
  await settle();
  await revise("ev_e2", "pay_e", 2, "2000");
  await revise("ev_e3", "pay_e", 3, "1000");
  const early = await createBatch(d, w.users.ops, { batchId: "bat_e_early", ...P });
  assert.deepEqual(early.skipped, [{ eventId: "ev_e3", reason: "REVISION_PENDING" }], "ev_e2 is superseded; ev_e3 waits for the correction of ev_e1");
  await jobs.drain(jobHandlers(d));
  assert.deepEqual((await w.db.pool.query("SELECT reversal_id FROM reversal_run WHERE event_id IN ('ev_e1','ev_e2')")).rows, [{ reversal_id: "rev_ev_e2" }]);
  await settle();
  assert.equal(await receivable("ev_e1", "ev_e2", "ev_e3"), 1000n);
  await clean("chain");
});

test("concurrent supersede deliveries and handler runs reverse exactly once", async () => {
  await revise("ev_d1", "pay_d", 1, "4000");
  await settle();
  const before = jobs.sent.length;
  const rs = await Promise.all([1, 2].map(() => revise("ev_d2", "pay_d", 2, "3000")));
  assert.deepEqual(rs.map((r) => r.created).sort(), [false, true]);
  assert.equal(jobs.sent.slice(before).filter((j) => j.name === "revision-recorded").length, 1);
  await Promise.all([1, 2, 3].map(() => revisionRecorded(d, { newEventId: "ev_d2" })));
  await jobs.drain(jobHandlers(d));
  await revisionRecorded(d, { newEventId: "ev_d2" });
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM reversal_run WHERE refund_event_id = 'ev_d2'")).rows[0].n, 1);
  assert.equal(await settled("ev_d1"), 0n);
  await settle();
  assert.equal(await receivable("ev_d1", "ev_d2"), 3000n);
  await clean("concurrent");
});

test("the pool check expects a CORRECTION to take back exactly the remaining settled amount", async () => {
  const c = await w.db.pool.connect();
  try {
    await c.query("BEGIN");
    const x = (await c.query("SELECT original_run_id, bucket FROM reversal_run v JOIN pool_line p USING (reversal_id) WHERE v.reversal_id = 'rev_ev_c2' LIMIT 1")).rows[0];
    await c.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw, reversal_id) VALUES ($1,'ev_c1',$2,99,-1,'rev_ev_c2')", [x.original_run_id, x.bucket]);
    const r = await invariantsInTx(c, fixedClock("2026-08-01T00:00:00.000Z", 0));
    assert.deepEqual(r.ledger.poolMismatches, [{ kind: "REVERSAL", id: "rev_ev_c2", expected: "-10001", actual: "-10002" }]);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});

test("a first revision or an unknown id does nothing", async () => {
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "ev_z1", sourceSystem: "app", sourceEventId: "pay_z", eventType: "PURCHASE", vcId: "vc_1", amountKrw: "10", currency: "KRW", occurredAt: "2026-03-05T00:00:00.000Z",
  }, noRefundHook, revisionHook(jobs)));
  const before = (await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n;
  await revisionRecorded(d, { newEventId: "ev_z1" });
  await revisionRecorded(d, { newEventId: "ev_nope" });
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n, before);
});
