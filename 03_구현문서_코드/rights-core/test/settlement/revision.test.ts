import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue, noRefundHook } from "../../src/revenue/service.ts";
import { batchView, confirmBatch, createBatch, refundHook, revisionHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { revisionRecorded } from "../../src/settlement/revision.ts";
import { releaseHold } from "../../src/settlement/holds.ts";
import { invariants, invariantsInTx, type InvariantReport } from "../../src/settlement/invariants.ts";
import { suggestFraudRelease } from "../../src/engine-bridge/fraud-release.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const P = { periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" };

/** source 이벤트 `src`의 revision `rev`를 `eventId`로 수집한다(설정된 훅으로). */
const revise = (eventId: string, src: string, rev: number, amountKrw: string, integrity: "CLEAR" | "FLAGGED" = "CLEAR", vcId = "vc_1") =>
  w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId, sourceSystem: "app", sourceEventId: src, sourceRevision: rev, eventType: "PURCHASE", vcId,
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
  assert.deepEqual(r.unreflectedRevisions, [], label);
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

/** run 하나의 상태. */
const runStatus = async (runId: string) => (await w.db.pool.query("SELECT status FROM settlement_run WHERE run_id = $1", [runId])).rows[0].status as string;
const only = (names: (keyof ReturnType<typeof jobHandlers>)[]) => {
  const h = jobHandlers(d);
  return Object.fromEntries(names.map((k) => [k, h[k]]));
};

await issueCombo(w, "vc_1");
await issueCombo(w, "vc_2", "b", "a");

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
  await assert.rejects(confirmBatch(d, w.users.settle, "bat_b1"), { code: "BATCH_EMPTY", status: 409 });
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
  await revise("ev_p1", "pay_p", 1, "2500");
  await settle();
  await revise("ev_p2", "pay_p", 2, "2000");
  await jobs.drain(jobHandlers(d));
  await settle();
  await clean("pool check setup");
  const c = await w.db.pool.connect();
  try {
    await c.query("BEGIN");
    const x = (await c.query("SELECT original_run_id, bucket FROM reversal_run v JOIN pool_line p USING (reversal_id) WHERE v.reversal_id = 'rev_ev_p2' LIMIT 1")).rows[0];
    await c.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw, reversal_id) VALUES ($1,'ev_p1',$2,99,-1,'rev_ev_p2')", [x.original_run_id, x.bucket]);
    const r = await invariantsInTx(c, fixedClock("2026-08-01T00:00:00.000Z", 0));
    assert.deepEqual(r.ledger.poolMismatches, [{ kind: "REVERSAL", id: "rev_ev_p2", expected: "-2500", actual: "-2501" }]);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});

test("a revision voids its PENDING or CALCULATED run; the queued settle-run/verify-run then do nothing", async () => {
  await revise("ev_q1", "pay_q", 1, "1500");
  const bq = await createBatch(d, w.users.ops, { batchId: "bat_q", ...P });
  assert.equal(await runStatus(bq.runs[0]!), "PENDING");
  await revise("ev_q2", "pay_q", 2, "1400");
  await jobs.drain(only(["revision-recorded"]));
  assert.equal(await runStatus(bq.runs[0]!), "VOIDED");
  await jobs.drain(jobHandlers(d));
  assert.equal(await runStatus(bq.runs[0]!), "VOIDED");
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM pool_line WHERE run_id = $1", [bq.runs[0]])).rows[0].n, 0);

  await revise("ev_k1", "pay_k", 1, "1600");
  const bk = await createBatch(d, w.users.ops, { batchId: "bat_k", ...P });
  assert.deepEqual(bk.skipped, [], "ev_q2 is settled here too once its old run is void");
  const kRun = bk.runs[0]!;
  await jobs.drain(only(["settle-run"]));
  assert.equal(await runStatus(kRun), "CALCULATED");
  await revise("ev_k2", "pay_k", 2, "1700");
  await jobs.drain(only(["revision-recorded"]));
  assert.equal(await runStatus(kRun), "VOIDED");
  await jobs.drain(jobHandlers(d));
  assert.equal(await runStatus(kRun), "VOIDED");
  const diag = (await w.db.pool.query("SELECT diagnostics FROM settlement_run WHERE run_id = $1", [kRun])).rows[0].diagnostics;
  assert.equal(diag[0].code, "SUPERSEDED_BEFORE_CONFIRMATION");
  const audits = (await w.db.pool.query("SELECT after_json->>'from' AS f FROM audit_log WHERE action_name = 'RUN_VOIDED_BY_REVISION' AND entity_id = ANY($1) ORDER BY entity_id", [[bq.runs[0], kRun]])).rows;
  assert.deepEqual(audits.map((a) => a.f).sort(), ["CALCULATED", "PENDING"]);
  const b = await settle();
  const events = (await w.db.pool.query("SELECT event_id FROM settlement_run_event WHERE run_id = ANY($1) ORDER BY event_id", [b.runs])).rows.map((r) => r.event_id);
  assert.deepEqual(events, ["ev_k2", "ev_q2"]);
  await clean("voided pending/calculated");
});

test("a revision void of one run leaves the other runs of the batch confirmable", async () => {
  await revise("ev_m1", "pay_m", 1, "1800");
  await purchase(w, "ev_m_other", "vc_2", "2200", "2026-03-05T00:00:00.000Z");
  const b = await createBatch(d, w.users.ops, { batchId: "bat_m", ...P });
  assert.equal(b.runs.length, 2);
  await jobs.drain(jobHandlers(d));
  await revise("ev_m2", "pay_m", 2, "1900");
  await jobs.drain(jobHandlers(d));
  const v = await w.db.tx((tx) => batchView(tx, "bat_m"));
  const byEvent = new Map((await w.db.pool.query("SELECT run_id, event_id FROM settlement_run_event WHERE run_id = ANY($1)", [b.runs])).rows.map((r) => [r.event_id, r.run_id]));
  assert.deepEqual(Object.fromEntries(v.runs.map((r) => [r.runId, r.status])), { [byEvent.get("ev_m1")]: "VOIDED", [byEvent.get("ev_m_other")]: "VERIFIED" });
  assert.equal(v.progress, "READY");
  await confirmBatch(d, w.users.settle, "bat_m");
  await jobs.drain(jobHandlers(d));
  assert.equal(await runStatus(byEvent.get("ev_m_other")), "CONFIRMED");
  assert.equal(await runStatus(byEvent.get("ev_m1")), "VOIDED");
  await settle();
  assert.equal(await receivable("ev_m1", "ev_m2", "ev_m_other"), 1900n + 2200n);
  await clean("partial void");
});

test("a correction never holds the run lock while waiting for the event row (lock order of releaseHold)", async () => {
  await revise("ev_l1", "pay_l", 1, "50000", "FLAGGED");
  await settle();
  const x = (await w.db.pool.query("SELECT run_id FROM settlement_run_event WHERE event_id = 'ev_l1' AND active")).rows[0].run_id as string;
  await revise("ev_l2", "pay_l", 2, "40000");
  // releaseHold의 순서를 흉내 낸다: 이벤트 행 FOR UPDATE → (분개 보장) run FOR SHARE.
  const a = await w.db.pool.connect();
  try {
    await a.query("BEGIN");
    await a.query("SELECT 1 FROM settlement_run_event WHERE run_id = $1 AND event_id = 'ev_l1' FOR UPDATE", [x]);
    const pending = revisionRecorded(d, { newEventId: "ev_l2" });
    await new Promise((r) => setTimeout(r, 300));
    await a.query("SET LOCAL lock_timeout = '3s'");
    await a.query("SELECT status FROM settlement_run WHERE run_id = $1 FOR SHARE", [x]);
    await a.query("COMMIT");
    await pending;
  } finally {
    a.release();
  }
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM reversal_run WHERE refund_event_id = 'ev_l2'")).rows[0].n, 1);
  await jobs.drain(jobHandlers(d));

  // 실제 경합: 어느 쪽이 먼저든 교착 없이 끝나고 점검이 깨끗하다(해제가 늦으면 보류가 이미 되돌려져 HOLD_EMPTY).
  await revise("ev_l3", "pay_l3", 1, "60000", "FLAGGED");
  await settle();
  const hold = (await w.db.pool.query("SELECT holding_id::text AS id FROM unallocated_holding WHERE event_id = 'ev_l3' AND line_seq = 1")).rows[0].id as string;
  const s = await w.db.tx((tx) => suggestFraudRelease(w.ctx, tx, hold));
  await revise("ev_l4", "pay_l3", 2, "55000");
  const [rel, rev] = await Promise.allSettled([
    releaseHold(d, w.users.settle, { holdingId: hold, allocation: s.allocation }), revisionRecorded(d, { newEventId: "ev_l4" }),
  ]);
  assert.equal(rev.status, "fulfilled", rev.status === "rejected" ? String(rev.reason) : "");
  if (rel.status === "rejected") assert.equal(rel.reason.code, "HOLD_EMPTY");
  await jobs.drain(jobHandlers(d));
  await settle();
  assert.equal(await receivable("ev_l1", "ev_l2", "ev_l3", "ev_l4"), 40000n + 55000n);
  await clean("release vs correction");
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

test("a correction exceeding the settled amount is rejected once: audited, no reversal, reported as unreflected", async () => {
  await revise("ev_x1", "pay_x", 1, "3000");
  await settle();
  const x = (await w.db.pool.query("SELECT run_id FROM settlement_run_event WHERE event_id = 'ev_x1' AND active")).rows[0].run_id as string;
  // 버그를 흉내 낸다: 관리자 연결에서 트리거를 끄고 run 이벤트 순액을 봉인 결과보다 1 크게 바꾼다(끝에 되돌린다).
  const admin = new pg.Client({ connectionString: w.adminUrl });
  await admin.connect();
  const tamper = (delta: number) => admin.query(
    `BEGIN; SET LOCAL session_replication_role = replica;
     UPDATE settlement_run_event SET net_amount_krw = net_amount_krw + ${delta} WHERE event_id = 'ev_x1'; COMMIT;`);
  try {
    await tamper(1);
    await revise("ev_x2", "pay_x", 2, "2000");
    await revisionRecorded(d, { newEventId: "ev_x2" });
    await jobs.drain(jobHandlers(d));
    const a = await w.db.pool.query("SELECT after_json FROM audit_log WHERE action_name = 'CORRECTION_REJECTED' AND entity_id = 'ev_x2'");
    assert.equal(a.rows.length, 1);
    assert.equal(a.rows[0].after_json.code, "CORRECTION_EXCEEDS_SETTLED");
    assert.ok(JSON.stringify(a.rows[0].after_json).includes("REV_EXCEEDS_REMAINING"));
    assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM reversal_run WHERE refund_event_id = 'ev_x2'")).rows[0].n, 0);
    const r = await invariants(w.db, fixedClock("2026-08-01T00:00:00.000Z", 0));
    assert.deepEqual(r.unreflectedRevisions, [{ newEventId: "ev_x2", oldEventId: "ev_x1", runId: x, remaining: "3001", rejected: true }]);
    const b = await createBatch(d, w.users.ops, { batchId: "bat_x", ...P });
    assert.deepEqual(b.skipped, [{ eventId: "ev_x2", reason: "REVISION_PENDING" }]);
  } finally {
    await tamper(-1);
    await admin.end();
  }
});
