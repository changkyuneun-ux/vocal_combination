import { test, after } from "node:test";
import assert from "node:assert/strict";
import { partyStatement, type Statement } from "../../src/ledger/statements.ts";
import { balance } from "../../src/ledger/journal.ts";
import { registerParty } from "../../src/registry/service.ts";
import { computeWithholding } from "../../src/payout/policy.ts";
import { issueCombo, ledgerFlow, LEDGER_PHASE_AT, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
await issueCombo(w, "vc_1");

const START = "2026-01-01T00:00:00.000Z";
const END = "2027-01-01T00:00:00.000Z";
const stmt = (partyId: string, from: string, to: string) => w.db.tx((tx) => partyStatement(tx, partyId, from, to));
const payableParties = async () => (await w.db.pool.query("SELECT party_id FROM ledger_account WHERE kind = 'PARTY_PAYABLE' ORDER BY party_id")).rows.map((r) => r.party_id as string);
const B = (s: string) => BigInt(s);
/** 명세 항등식: closing = opening + settled + reversed + holdReleased − payoutGross + payoutFailedRestored, payoutGross = withholding + payoutNet. */
const assertIdentity = (s: Statement) => {
  assert.equal(B(s.closing), B(s.opening) + B(s.settled) + B(s.reversed) + B(s.holdReleased) - B(s.payoutGross) + B(s.payoutFailedRestored), `${s.partyId} ${s.from}..${s.to}`);
  assert.equal(B(s.payoutGross), B(s.withholding) + B(s.payoutNet), `${s.partyId} payout split`);
};

const phases: string[] = [];
await ledgerFlow(w, async (phase) => {
  phases.push(phase);
  // 단계마다 모든 권리자의 전체 기간 명세가 항등식을 지키고, closing이 원장 잔액(부채 = −합)과 같다.
  for (const p of await payableParties()) {
    const s = await stmt(p, START, END);
    assertIdentity(s);
    assert.equal(B(s.opening), 0n);
    assert.equal(B(s.closing), -(await w.db.tx((tx) => balance(tx, { kind: "PARTY_PAYABLE", partyId: p }))), `${phase} ${p}`);
  }
});

const sum = async (sql: string, params: unknown[]) => B((await w.db.pool.query(sql, params)).rows[0].s);

test("the flow ran every phase", () => {
  assert.deepEqual(phases, ["settled", "released", "reversed", "paid", "repaid"]);
});

test("each figure comes from the settlement, release, reversal and payout records of that party", async () => {
  const p = "pty_member_b";
  const s = await stmt(p, START, END);
  const settledLines = await sum("SELECT COALESCE(SUM(amount_krw),0)::text AS s FROM allocation_line WHERE party_id = $1 AND line_seq = 1", [p]);
  assert.ok(settledLines > 0n);
  assert.equal(B(s.settled), settledLines);
  const released = await sum("SELECT COALESCE(SUM((allocation->>$1)::bigint),0)::text AS s FROM hold_release", [p]);
  assert.ok(released > 0n);
  assert.equal(B(s.holdReleased), released);
  const reversedLines = await sum("SELECT COALESCE(SUM(amount_krw),0)::text AS s FROM allocation_line WHERE party_id = $1 AND line_kind = 'REVERSAL'", [p]);
  const reversedReleased = await sum("SELECT COALESCE(SUM(amount_krw),0)::text AS s FROM hold_release_reversal WHERE party_id = $1", [p]);
  assert.ok(reversedLines < 0n && reversedReleased > 0n, "reversed both lines and released hold");
  assert.equal(B(s.reversed), reversedLines - reversedReleased);
  // 6월 지급은 실패(복원), 7월 지급은 성공: 총액 = 두 지시의 합, 복원 = 6월 지시 총액.
  const ins = (await w.db.pool.query(
    "SELECT payout_run_id, status, gross_krw::text AS g, withholding_krw::text AS wh, net_krw::text AS n FROM payout_instruction WHERE party_id = $1 ORDER BY payout_run_id DESC", [p])).rows;
  assert.deepEqual(ins.map((r) => `${r.payout_run_id} ${r.status}`), ["po-jun FAILED", "po-jul PAID"]);
  const [jun, jul] = ins;
  assert.equal(jun.g, jul.g, "the failed amount is paid in full next time");
  assert.equal(B(s.payoutGross), B(jun.g) + B(jul.g));
  assert.equal(B(s.payoutFailedRestored), B(jun.g));
  assert.equal(B(s.withholding), B(jun.wh) + B(jul.wh));
  assert.equal(B(jul.wh), computeWithholding(B(jul.g), 330));
  assert.ok(B(jul.wh) > 0n);
  assert.equal(B(s.payoutNet), B(jun.n) + B(jul.n));
  assert.equal(B(s.opening), 0n);
  assert.equal(B(s.closing), B(s.settled) + B(s.reversed) + B(s.holdReleased) - B(jul.g));
  assert.deepEqual({ partyId: s.partyId, from: s.from, to: s.to }, { partyId: p, from: START, to: END });
});

test("period statements split the flow at the phase boundaries and chain opening to closing", async () => {
  const p = "pty_member_b";
  const whole = await stmt(p, START, END);
  const cuts = [START, LEDGER_PHASE_AT.settled, LEDGER_PHASE_AT.released, LEDGER_PHASE_AT.paid, LEDGER_PHASE_AT.repaid, END];
  const parts: Statement[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) parts.push(await stmt(p, cuts[i]!, cuts[i + 1]!));
  for (const s of parts) assertIdentity(s);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i]!.opening, parts[i - 1]!.closing);
  assert.equal(parts.at(-1)!.closing, whole.closing);
  const total = (k: keyof Statement) => parts.reduce((a, s) => a + B(s[k]), 0n).toString();
  for (const k of ["settled", "reversed", "holdReleased", "payoutGross", "withholding", "payoutNet", "payoutFailedRestored"] as const) assert.equal(total(k), whole[k], k);
  const [before, mar, apr, jun, jul] = parts;
  assert.deepEqual([before!.opening, before!.closing, before!.settled], ["0", "0", "0"]);
  assert.equal(mar!.settled, whole.settled);
  assert.deepEqual([mar!.reversed, mar!.holdReleased, mar!.payoutGross], ["0", "0", "0"]);
  assert.equal(apr!.holdReleased, whole.holdReleased);
  assert.equal(apr!.reversed, whole.reversed);
  assert.equal(apr!.settled, "0");
  assert.equal(jun!.payoutGross, jun!.payoutFailedRestored, "June: paid then restored");
  assert.equal(jun!.closing, jun!.opening);
  assert.equal(jul!.payoutFailedRestored, "0");
  assert.equal(jul!.payoutGross, jul!.opening);
  assert.equal(jul!.closing, "0");
});

test("an entry at exactly `from` is inside the period and one at exactly `to` is outside", async () => {
  const p = "pty_member_b";
  const at = ((await w.db.pool.query("SELECT occurred_at FROM journal_entry WHERE kind = 'SETTLEMENT' ORDER BY entry_id LIMIT 1")).rows[0].occurred_at as Date).toISOString();
  const upto = await stmt(p, START, at);
  assert.deepEqual([upto.settled, upto.closing], ["0", "0"]);
  const from = await stmt(p, at, LEDGER_PHASE_AT.released);
  assert.equal(from.settled, (await stmt(p, START, END)).settled);
  assert.equal(from.opening, "0");
  const empty = await stmt(p, at, at);
  assert.deepEqual([empty.settled, empty.opening, empty.closing], ["0", "0", "0"]);
});

test("every party's statements sum to the payout instructions and to the ledger", async () => {
  let gross = 0n;
  let wh = 0n;
  for (const p of await payableParties()) {
    const s = await stmt(p, START, END);
    assertIdentity(s);
    gross += B(s.payoutGross);
    wh += B(s.withholding);
  }
  assert.equal(gross, await sum("SELECT COALESCE(SUM(gross_krw),0)::text AS s FROM payout_instruction WHERE entry_id IS NOT NULL", []));
  assert.equal(wh, -(await w.db.tx((tx) => balance(tx, { kind: "WITHHOLDING_TAX" }))) + await sum(
    "SELECT COALESCE(SUM(withholding_krw),0)::text AS s FROM payout_instruction WHERE status = 'FAILED'", []), "failed withholding is restored in the ledger");
});

test("a party without an account has an all-zero statement; unknown parties and bad input are rejected", async () => {
  await w.db.tx((tx) => registerParty(tx, w.clock, { partyId: "pty_quiet", partyType: "AUTHOR", displayName: "quiet" }));
  const z = await stmt("pty_quiet", START, END);
  for (const k of ["opening", "settled", "reversed", "holdReleased", "payoutGross", "withholding", "payoutNet", "payoutFailedRestored", "closing"] as const) assert.equal(z[k], "0", k);
  await assert.rejects(stmt("pty_nobody", START, END), { status: 404 });
  await assert.rejects(stmt("pty_member_a", "2026-01-01", END), { code: "INVALID_INSTANT", status: 422 });
  await assert.rejects(stmt("pty_member_a", START, "2026-13-01T00:00:00.000Z"), { code: "INVALID_INSTANT", status: 422 });
  await assert.rejects(stmt("pty_member_a", END, START), { code: "INVALID_PERIOD", status: 422 });
});
