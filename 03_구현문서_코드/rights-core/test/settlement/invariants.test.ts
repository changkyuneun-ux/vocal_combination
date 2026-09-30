import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue, noRefundHook, noRevisionHook } from "../../src/revenue/service.ts";
import { confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers, refundRecorded } from "../../src/settlement/handlers.ts";
import { invariants, invariantsInTx, type InvariantReport } from "../../src/settlement/invariants.ts";
import { postEntry } from "../../src/ledger/journal.ts";
import type { Tx } from "../../src/platform/db.ts";
import { issueCombo, ledgerFlow, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
await issueCombo(w, "vc_1");

const NOW = "2026-08-01T00:00:00.000Z";
const check = (now = NOW, opts?: { stuckAfterMinutes?: number }) => invariants(w.db, fixedClock(now, 0), opts);
/** 인위적 상태는 롤백할 트랜잭션 안에서 만들고 그 트랜잭션에서 점검한다(다른 테스트를 오염시키지 않도록). */
const rolledBack = async <T>(fn: (tx: Tx, check: () => Promise<InvariantReport>) => Promise<T>): Promise<T> => {
  const c = await w.db.pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c, () => invariantsInTx(c, fixedClock(NOW, 0)));
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
};
const clean = (r: InvariantReport, label: string) => {
  assert.deepEqual(r.unreflectedRefunds, [], label);
  assert.deepEqual(r.unreflectedRevisions, [], label);
  assert.equal(r.ledger.entriesUnbalanced, 0, label);
  assert.equal(r.ledger.receivableMatchesSettlement, true, label);
  assert.equal(r.ledger.rightsConserved, true, label);
  assert.deepEqual(r.ledger.unpostedConfirmedRuns, [], label);
  assert.deepEqual(r.ledger.unpostedReversals, [], label);
  assert.deepEqual(r.ledger.poolMismatches, [], label);
  assert.deepEqual(r.stuckRuns, [], label);
  assert.deepEqual(r.payouts.stuck, [], label);
  assert.deepEqual(r.payouts.resultConflicts, [], label);
  assert.equal(r.payouts.clearingMatchesOpen, true, `${label}: ${r.payouts.amounts.clearing} vs ${r.payouts.amounts.openNet}`);
  assert.equal(r.payouts.cashMatchesPaid, true, `${label}: ${r.payouts.amounts.cash} vs ${r.payouts.amounts.paidNet}`);
  assert.equal(r.payouts.withholdingMatches, true, `${label}: ${r.payouts.amounts.withholding} vs ${r.payouts.amounts.withheld}`);
  assert.equal(r.payouts.unprocessedWebhooks, 0, label);
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
  // 지급 대사가 실제 금액으로 성립했다(실패 1건은 원천세에서 빠지고, 나머지는 현금으로 나갔다).
  const p = (await check()).payouts;
  assert.notEqual(p.amounts.cash, "0");
  assert.notEqual(p.amounts.withholding, "0");
  assert.equal(p.amounts.clearing, "0");
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
  }, noRefundHook, noRevisionHook));
  const run = (await w.db.pool.query("SELECT run_id FROM settlement_run WHERE batch_id = 'bat_sep'")).rows[0].run_id as string;
  const r = await check("2026-09-13T00:00:00.000Z");
  assert.deepEqual(r.unreflectedRefunds, [{ refundEventId: "rf_lost", originalEventId: "ev_s", runId: run, rejected: false }]);
  assert.equal(r.ledger.receivableMatchesSettlement, true);
  // 역분개가 거부된 환불(REVERSAL_REJECTED 감사)이면 rejected로 구분된다.
  await rolledBack(async (tx, chk) => {
    await tx.query("INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id) VALUES (now(), 'sys_settler', 'REVERSAL_REJECTED', 'revenue_event', 'rf_lost')");
    assert.deepEqual((await chk()).unreflectedRefunds.map((x) => [x.refundEventId, x.rejected]), [["rf_lost", true]]);
  });
  await refundRecorded(d, { refundEventId: "rf_lost" });
  await jobs.drain(jobHandlers(d));   // reverse-event
  clean(await check("2026-09-13T00:00:00.000Z"), "reversed");
});

test("a refund already included in a run's net, or on an event of an unconfirmed run, is not listed", async () => {
  // 포함: 배치 전에 기록된 환불(순액에 포함).
  await purchase(w, "ev_i", "vc_1", "30000", "2026-10-01T00:00:00.000Z");
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "rf_i", sourceSystem: "app", sourceEventId: "rf_i", eventType: "REFUND", relatedEventId: "ev_i", amountKrw: "1000", currency: "KRW", occurredAt: "2026-10-02T00:00:00.000Z",
  }, refundHook(jobs), noRevisionHook));
  await jobs.drain(jobHandlers(d));
  await createBatch(d, w.users.ops, { batchId: "bat_oct", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z" });
  await jobs.drain(jobHandlers(d));
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM settlement_run_event_refund WHERE refund_event_id = 'rf_i'")).rows[0].n, 1);
  // 확정 전 run의 이벤트에 대한 환불(작업 없음)은 (a) 대상이 아니다.
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "rf_v", sourceSystem: "app", sourceEventId: "rf_v", eventType: "REFUND", relatedEventId: "ev_i", amountKrw: "1000", currency: "KRW", occurredAt: "2026-10-03T00:00:00.000Z",
  }, noRefundHook, noRevisionHook));
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
  const bypass = async (tx: Tx, ref: string, account: string, amount: string) => {
    const id = (await tx.query("INSERT INTO journal_entry (kind, source_ref, occurred_at, created_by) VALUES ('ADJUSTMENT', $1, '2026-12-01T00:00:00.000Z', 'usr_settle') RETURNING entry_id", [ref])).rows[0].entry_id;
    await tx.query("SELECT set_config('rc.bal_last', $1, true)", [String(id)]);
    await tx.query("INSERT INTO posting (entry_id, account_id, amount_krw) VALUES ($1, $2, $3)", [id, account, amount]);
  };
  await rolledBack(async (tx, chk) => {
    await bypass(tx, "bad:1", "RECEIVABLE", "7");
    const r1 = await chk();
    assert.equal(r1.ledger.entriesUnbalanced, 1);
    assert.equal(r1.ledger.receivableMatchesSettlement, false);
    assert.equal(r1.ledger.rightsConserved, true);
    await bypass(tx, "bad:2", "PARTY_PAYABLE:pty_label", "-3");
    const r2 = await chk();
    assert.equal(r2.ledger.entriesUnbalanced, 2);
    assert.equal(r2.ledger.rightsConserved, false);
  });
});

test("balanced but wrong adjustments break the matching checks without an unbalanced entry", async () => {
  const adj = (tx: Tx, ref: string, postings: Parameters<typeof postEntry>[2]["postings"]) =>
    postEntry(tx, fixedClock(NOW, 0), { kind: "ADJUSTMENT", sourceRef: ref, createdBy: "usr_settle", postings });
  await rolledBack(async (tx, chk) => {
    await adj(tx, "adj:rights", [{ account: { kind: "POOL_PLATFORM" }, amount: 500n }, { account: { kind: "PARTY_PAYABLE", partyId: "pty_label" }, amount: -500n }]);
    const r = await chk();
    assert.equal(r.ledger.entriesUnbalanced, 0);
    assert.equal(r.ledger.rightsConserved, false);
    assert.equal(r.ledger.receivableMatchesSettlement, true);
  });
  await rolledBack(async (tx, chk) => {
    await adj(tx, "adj:recv", [{ account: { kind: "RECEIVABLE" }, amount: 500n }, { account: { kind: "POOL_OPS" }, amount: -500n }]);
    const r = await chk();
    assert.equal(r.ledger.entriesUnbalanced, 0);
    assert.equal(r.ledger.receivableMatchesSettlement, false);
    assert.equal(r.ledger.rightsConserved, true);
  });
});

test("a reversal without its REVERSAL entry is listed as unposted", async () => {
  await rolledBack(async (tx, chk) => {
    const v = (await tx.query("SELECT original_run_id, event_id, result_digest FROM reversal_run WHERE reversal_id = 'rev_rf_c'")).rows[0];
    await tx.query(`INSERT INTO revenue_event (event_id, source_system, source_event_id, event_type, related_event_id, net_amount_krw, currency, occurred_at, recorded_at)
                    VALUES ('rf_ghost', 'app', 'rf_ghost', 'REFUND', $1, 100, 'KRW', '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')`, [v.event_id]);
    await tx.query("INSERT INTO reversal_run (reversal_id, original_run_id, event_id, sequence, refund_event_id, result_digest, created_at) VALUES ('rev_ghost', $1, $2, 99, 'rf_ghost', $3, '2026-12-01T00:00:00.000Z')",
      [v.original_run_id, v.event_id, v.result_digest]);
    const r = await chk();
    assert.deepEqual(r.ledger.unpostedReversals, ["rev_ghost"]);
    assert.deepEqual(r.unreflectedRefunds, [], "the ghost refund counts as reversed");
  });
});

test("pool sums that disagree with run-event nets or refund amounts are listed", async () => {
  await rolledBack(async (tx, chk) => {
    // 원 결과 라인은 run이 PENDING일 때만 들어가므로(INSERT 가드 11.2-12) 어긋난 run을 따로 만들고 run:<id> 분개를 붙인다.
    const snap = (await tx.query("SELECT snapshot_id FROM settlement_run WHERE status = 'CONFIRMED' LIMIT 1")).rows[0].snapshot_id as string;
    await tx.query("INSERT INTO settlement_batch (batch_id, period_start, period_end, executed_by, created_at) VALUES ('bat_ghost', $1, $2, 'usr_ops', $2)",
      ["2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);
    await tx.query("INSERT INTO settlement_run (run_id, batch_id, snapshot_id, created_at) VALUES ('run_ghost', 'bat_ghost', $1, '2026-12-01T00:00:00.000Z')", [snap]);
    await tx.query(`INSERT INTO revenue_event (event_id, source_system, source_event_id, event_type, vc_id, net_amount_krw, currency, occurred_at, recorded_at)
                    VALUES ('ev_ghost', 'app', 'ev_ghost', 'PURCHASE', 'vc_1', 1000, 'KRW', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`);
    await tx.query("INSERT INTO settlement_run_event (run_id, event_id, net_amount_krw, refunds_included_krw) VALUES ('run_ghost', 'ev_ghost', 1000, 0)");
    await tx.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw) VALUES ('run_ghost', 'ev_ghost', 'zzz', 1, 1005)");
    await postEntry(tx, fixedClock(NOW, 0), { kind: "ADJUSTMENT", sourceRef: "run:run_ghost", createdBy: "usr_settle",
      postings: [{ account: { kind: "RECEIVABLE" }, amount: 1n }, { account: { kind: "POOL_OPS" }, amount: -1n }] });
    const rv = (await tx.query("SELECT original_run_id, event_id, sequence FROM reversal_run WHERE reversal_id = 'rev_rf_c'")).rows[0];
    await tx.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw, reversal_id) VALUES ($1, $2, 'zzz', $3, -2, 'rev_rf_c')",
      [rv.original_run_id, rv.event_id, rv.sequence + 1]);
    const r = await chk();
    assert.deepEqual(r.ledger.poolMismatches, [
      { kind: "REVERSAL", id: "rev_rf_c", expected: "-100000", actual: "-100002" },
      { kind: "RUN", id: "run_ghost", expected: "1000", actual: "1005" },
    ]);
  });
});

test("payout reconciliation: stray clearing, cash or withholding postings, stuck instructions, conflicts and stale webhooks are reported", async () => {
  const adj = (tx: Tx, ref: string, postings: Parameters<typeof postEntry>[2]["postings"]) =>
    postEntry(tx, fixedClock(NOW, 0), { kind: "ADJUSTMENT", sourceRef: ref, createdBy: "usr_settle", postings });
  await rolledBack(async (tx, chk) => {
    // PSP 정산 중 → 현금으로, 지시 없이(열린 지시·PAID 지시 어느 쪽과도 맞지 않는다).
    await adj(tx, "adj:cash", [{ account: { kind: "PSP_CLEARING" }, amount: 700n }, { account: { kind: "CASH" }, amount: -700n }]);
    const r = (await chk()).payouts;
    assert.deepEqual([r.clearingMatchesOpen, r.cashMatchesPaid, r.withholdingMatches], [false, false, true]);
    assert.equal(BigInt(r.amounts.cash) - BigInt(r.amounts.paidNet), 700n);
  });
  await rolledBack(async (tx, chk) => {
    await adj(tx, "adj:wh", [{ account: { kind: "RECEIVABLE" }, amount: 30n }, { account: { kind: "WITHHOLDING_TAX" }, amount: -30n }]);
    const r = (await chk()).payouts;
    assert.deepEqual([r.clearingMatchesOpen, r.cashMatchesPaid, r.withholdingMatches], [true, true, false]);
  });
  await rolledBack(async (tx, chk) => {
    // 오래된 열린 지시: 전송 표식이 기준(NOW − 60분)보다 이르다. 분개(entry_id)는 같은 금액의 PAYOUT 분개로 맞춰 대조는 그대로 성립하게 한다.
    const e = await postEntry(tx, fixedClock("2026-07-31T00:00:00.000Z", 0), { kind: "PAYOUT", sourceRef: "payout:po_old_pty_label", createdBy: "usr_settle", postings: [
      { account: { kind: "PARTY_PAYABLE", partyId: "pty_label" }, amount: 1000n }, { account: { kind: "PSP_CLEARING" }, amount: -1000n }] });
    await tx.query("INSERT INTO payout_run (payout_run_id, as_of, created_by, created_at) VALUES ('old', '2026-07-31T00:00:00.000Z', 'usr_settle', '2026-07-31T00:00:00.000Z')");
    await tx.query(`INSERT INTO payout_instruction (instruction_id, payout_run_id, party_id, gross_krw, withholding_krw, net_krw, status, idempotency_key, entry_id, created_at)
                    VALUES ('po_old_pty_label', 'old', 'pty_label', 1000, 0, 1000, 'PENDING', 'payout:po_old_pty_label', $1, '2026-07-31T00:00:00.000Z')`, [e.entryId]);
    await tx.query("UPDATE payout_instruction SET status = 'SUBMITTED', submit_attempted_at = '2026-07-31T10:00:00.000Z', submitted_account_ref = 'tok' WHERE instruction_id = 'po_old_pty_label'");
    const r = (await chk()).payouts;
    assert.deepEqual(r.stuck, [{ instructionId: "po_old_pty_label", since: "2026-07-31T10:00:00.000Z" }]);
    assert.equal(r.clearingMatchesOpen, true, "the open instruction's net is in PSP_CLEARING");
    // 기준 시각보다 최근이어도 PAYOUT_STUCK 감사가 있으면 멈춘 것이다.
    const recent = (await invariantsInTx(tx, fixedClock(NOW, 0), { stuckAfterMinutes: 60 * 24 * 365 })).payouts;
    assert.deepEqual(recent.stuck, []);
    await tx.query("INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id) VALUES (now(), 'sys_payout', 'PAYOUT_STUCK', 'payout_instruction', 'po_old_pty_label')");
    assert.deepEqual((await invariantsInTx(tx, fixedClock(NOW, 0), { stuckAfterMinutes: 60 * 24 * 365 })).payouts.stuck.map((x) => x.instructionId), ["po_old_pty_label"]);
    // 결과 충돌 감사.
    await tx.query("INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id) VALUES (now(), 'sys_payout', 'PAYOUT_RESULT_CONFLICT', 'payout_instruction', 'po_old_pty_label')");
    assert.deepEqual((await chk()).payouts.resultConflicts, [{ instructionId: "po_old_pty_label" }]);
  });
  await rolledBack(async (tx, chk) => {
    // 미처리 webhook: 기준보다 오래된 것만 센다.
    await tx.query("INSERT INTO psp_webhook_inbox (provider_event_id, provider_ref, status, payload, received_at) VALUES ('evt_old', 'ref_x', 'PAID', '{}', '2026-07-31T22:59:59.999Z')");
    await tx.query("INSERT INTO psp_webhook_inbox (provider_event_id, provider_ref, status, payload, received_at) VALUES ('evt_new', 'ref_y', 'PAID', '{}', '2026-07-31T23:30:00.000Z')");
    assert.equal((await chk()).payouts.unprocessedWebhooks, 1);
  });
});
