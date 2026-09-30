import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue } from "../../src/revenue/service.ts";
import { registerParty } from "../../src/registry/service.ts";
import { confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { releaseHold } from "../../src/settlement/holds.ts";
import { suggestFraudRelease } from "../../src/engine-bridge/fraud-release.ts";
import { balance, trialBalance } from "../../src/ledger/journal.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
await issueCombo(w, "vc_1");
await w.db.tx((tx) => registerParty(tx, w.clock, { partyId: "pty_fan", partyType: "FAN", displayName: "fan" }));

// 3월: 정상 매출 ev_c와 FLAGGED 매출 ev_f(10000 → 권리 풀 7000 보류)·ev_g(5000 → 3500 보류). 확정·원장 반영.
await purchase(w, "ev_c", "vc_1", "10000");
await purchase(w, "ev_f", "vc_1", "10000", "2026-03-02T00:00:00.000Z", "FLAGGED");
await purchase(w, "ev_g", "vc_1", "5000", "2026-03-03T00:00:00.000Z", "FLAGGED");
await createBatch(d, w.users.ops, { batchId: "bat_h", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
await jobs.drain(jobHandlers(d));
await confirmBatch(d, w.users.settle, "bat_h");
await jobs.drain(jobHandlers(d));
// 4월: FLAGGED 매출 ev_p는 검증까지만(확정 전).
await purchase(w, "ev_p", "vc_1", "4000", "2026-04-02T00:00:00.000Z", "FLAGGED");
await createBatch(d, w.users.ops, { batchId: "bat_p", periodStart: "2026-04-01T00:00:00.000Z", periodEnd: "2026-05-01T00:00:00.000Z" });
await jobs.drain(jobHandlers(d));

const holdOf = async (eventId: string) => {
  const r = (await w.db.pool.query("SELECT holding_id::text AS id, amount_krw::text AS a, reason FROM unallocated_holding WHERE event_id = $1 AND line_seq = 1", [eventId])).rows[0];
  return { id: r.id as string, amount: BigInt(r.a), reason: r.reason as string };
};
const suggest = (holdingId: string) => w.db.tx((tx) => suggestFraudRelease(w.ctx, tx, holdingId));
const holdBal = () => w.db.tx((tx) => balance(tx, { kind: "HOLD", reason: "FRAUD_REVIEW" }));
const payable = (partyId: string) => w.db.tx((tx) => balance(tx, { kind: "PARTY_PAYABLE", partyId }));
const trialSum = async () => (await w.db.tx((tx) => trialBalance(tx))).reduce((a, r) => a + r.balance, 0n);
const sumOf = (a: Record<string, string>) => Object.values(a).reduce((s, v) => s + BigInt(v), 0n);
const refund = (eventId: string, relatedEventId: string, amountKrw: string) => w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
  eventId, sourceSystem: "app", sourceEventId: eventId, eventType: "REFUND", relatedEventId, amountKrw, currency: "KRW", occurredAt: "2026-05-05T00:00:00.000Z",
}, refundHook(jobs)));

let fSuggestion: Record<string, string> = {};

test("suggestFraudRelease re-evaluates the flagged event as CLEAR; parts sum to the hold", async () => {
  const h = await holdOf("ev_f");
  assert.equal(h.reason, "FRAUD_REVIEW");
  assert.equal(h.amount, 7000n);
  const s = await suggest(h.id);
  assert.equal(s.heldKrw, "7000");
  assert.equal(s.remainingKrw, "7000");
  assert.equal(sumOf(s.allocation), 7000n);
  // 같은 금액의 정상 매출 ev_c와 같은 권리자별 배분이다.
  const clear = await w.db.pool.query("SELECT party_id, SUM(amount_krw)::text AS a FROM allocation_line WHERE event_id = 'ev_c' GROUP BY party_id ORDER BY party_id");
  assert.deepEqual(s.allocation, Object.fromEntries(clear.rows.map((r) => [r.party_id, r.a])));
  fSuggestion = s.allocation;
  await assert.rejects(suggest("999999"), { status: 404 });
});

test("releaseHold rejects the wrong role, a mismatched sum, bad parties or amounts, and an unconfirmed run", async () => {
  const h = await holdOf("ev_f");
  await assert.rejects(releaseHold(d, w.users.ops, { holdingId: h.id, allocation: fSuggestion }), { code: "ROLE_REQUIRED", status: 403 });
  await assert.rejects(releaseHold(d, w.users.settle, { holdingId: h.id, allocation: { pty_label: "6999" } }), { code: "ALLOCATION_MISMATCH", status: 422 });
  await assert.rejects(releaseHold(d, w.users.settle, { holdingId: h.id, allocation: { pty_label: "6000", pty_fan: "1000" } }), { code: "INVALID_PARTY", status: 422 });
  await assert.rejects(releaseHold(d, w.users.settle, { holdingId: h.id, allocation: { pty_label: "7000", pty_nobody: "0" } }), { code: "INVALID_AMOUNT", status: 422 });
  await assert.rejects(releaseHold(d, w.users.settle, { holdingId: h.id, allocation: { pty_label: "6000", pty_nobody: "1000" } }), { code: "INVALID_PARTY", status: 422 });
  const p = await holdOf("ev_p");
  await assert.rejects(releaseHold(d, w.users.settle, { holdingId: p.id, allocation: { pty_label: p.amount.toString() } }), { code: "INVALID_STATE", status: 409 });
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM hold_release")).rows[0].n, 0);
});

test("releasing moves the hold into party payables in one balanced HOLD_RELEASE entry", async () => {
  const h = await holdOf("ev_f");
  const beforeHold = await holdBal();
  assert.equal(beforeHold, -(7000n + 3500n));
  const before = new Map<string, bigint>();
  for (const p of Object.keys(fSuggestion)) before.set(p, await payable(p));
  const r = await releaseHold(d, w.users.settle, { holdingId: h.id, allocation: fSuggestion });
  assert.equal(r.releasedKrw, "7000");
  assert.equal(await holdBal(), -3500n, "only ev_g is still held");
  for (const [p, amt] of Object.entries(fSuggestion)) assert.equal(await payable(p), before.get(p)! - BigInt(amt), p);
  assert.equal(await trialSum(), 0n);
  const e = (await w.db.pool.query("SELECT kind, entry_id::text AS id FROM journal_entry WHERE source_ref = $1", [`hold:${h.id}`])).rows[0];
  assert.equal(e.kind, "HOLD_RELEASE");
  const rel = (await w.db.pool.query("SELECT released_by, allocation, entry_id::text AS entry FROM hold_release WHERE holding_id = $1", [h.id])).rows[0];
  assert.equal(rel.released_by, "usr_settle");
  assert.equal(rel.entry, e.id);
  assert.deepEqual(rel.allocation, fSuggestion);
  const a = await w.db.pool.query("SELECT 1 FROM audit_log WHERE action_name = 'HOLD_RELEASED' AND entity_id = $1", [h.id]);
  assert.equal(a.rowCount, 1);
  await assert.rejects(w.db.pool.query("UPDATE hold_release SET allocation = '{}' WHERE holding_id = $1", [h.id]));
});

test("a hold is released only once", async () => {
  const h = await holdOf("ev_f");
  await assert.rejects(releaseHold(d, w.users.settle, { holdingId: h.id, allocation: fSuggestion }), { code: "HOLD_ALREADY_RELEASED", status: 409 });
});

test("a full refund after release reverses the released payables, not the hold", async () => {
  const before = new Map<string, bigint>();
  for (const p of Object.keys(fSuggestion)) before.set(p, await payable(p));
  const holdBefore = await holdBal();
  await refund("rf_f", "ev_f", "10000");
  await jobs.drain(jobHandlers(d));
  assert.equal((await w.db.pool.query("SELECT kind FROM journal_entry WHERE source_ref = 'rev:rev_rf_f'")).rows[0].kind, "REVERSAL");
  assert.equal(await holdBal(), holdBefore, "the released hold account does not move");
  for (const [p, amt] of Object.entries(fSuggestion)) assert.equal(await payable(p), before.get(p)! + BigInt(amt), p);
  const net = await w.db.pool.query(
    `SELECT a.party_id, SUM(p.amount_krw)::text AS s FROM posting p JOIN ledger_account a USING (account_id)
      WHERE a.kind = 'PARTY_PAYABLE' AND p.event_id = 'ev_f' GROUP BY a.party_id HAVING SUM(p.amount_krw) <> 0`);
  assert.deepEqual(net.rows, [], "ev_f payables net to zero");
  assert.equal(await trialSum(), 0n);
});

test("a partial refund before release shrinks the releasable amount; a later refund reverses by the release ratio", async () => {
  await refund("rf_g1", "ev_g", "2000");
  await jobs.drain(jobHandlers(d));
  const h = await holdOf("ev_g");
  assert.equal(await holdBal(), -2100n);
  const s = await suggest(h.id);
  assert.equal(s.heldKrw, "3500");
  assert.equal(s.remainingKrw, "2100");
  assert.equal(sumOf(s.allocation), 2100n);
  const full = Object.fromEntries(Object.entries(s.allocation).map(([k, v], i) => [k, i === 0 ? (BigInt(v) + 1400n).toString() : v]));
  await assert.rejects(releaseHold(d, w.users.settle, { holdingId: h.id, allocation: full }), { code: "ALLOCATION_MISMATCH", status: 422 });
  const r = await releaseHold(d, w.users.settle, { holdingId: h.id, allocation: s.allocation });
  assert.equal(r.releasedKrw, "2100");
  assert.equal(await holdBal(), 0n);
  assert.equal(await trialSum(), 0n);

  await refund("rf_g2", "ev_g", "3000");
  await jobs.drain(jobHandlers(d));
  assert.equal(await holdBal(), 0n);
  const net = await w.db.pool.query(
    `SELECT a.party_id, SUM(p.amount_krw)::text AS s FROM posting p JOIN ledger_account a USING (account_id)
      WHERE a.kind = 'PARTY_PAYABLE' AND p.event_id = 'ev_g' GROUP BY a.party_id HAVING SUM(p.amount_krw) <> 0`);
  assert.deepEqual(net.rows, [], "ev_g payables net to zero");
  assert.equal(await trialSum(), 0n);
});
