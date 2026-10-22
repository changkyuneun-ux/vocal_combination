import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Clock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue, noRevisionHook } from "../../src/revenue/service.ts";
import { registerParty } from "../../src/registry/service.ts";
import { confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { balance, postEntry, trialBalance } from "../../src/ledger/journal.ts";
import { computeWithholding, loadPayoutPolicy } from "../../src/payout/policy.ts";
import { createPayoutRun, setPayoutProfile, type PayoutDeps } from "../../src/payout/service.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";
import { setSodRules } from "../helpers.ts";

const w = await settlementWorld();
await setSodRules(w.adminUrl, ["payout.account-run"]); // 이 파일은 직무 분리 거부를 확인한다(규칙 기본 꺼짐, 결정 RD6)
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
// 지급 쪽 시계는 테스트가 직접 옮긴다(초기 보류 기간·기준 시각을 다루기 위해).
let nowIso = "2026-03-01T00:00:00.000Z";
const payClock: Clock = { now: () => nowIso };
const p: PayoutDeps = { db: w.db, clock: payClock, jobs };

const settleMonth = async (batchId: string, eventId: string, amount: string, month: "03" | "05" | "06") => {
  const next = { "03": "04", "05": "06", "06": "07" }[month];
  await purchase(w, eventId, "vc_1", amount, `2026-${month}-02T00:00:00.000Z`);
  await createBatch(d, w.users.ops, { batchId, periodStart: `2026-${month}-01T00:00:00.000Z`, periodEnd: `2026-${next}-01T00:00:00.000Z` });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, batchId);
  await jobs.drain(jobHandlers(d));
};
/** 권리자 미지급금을 직접 늘리는 조정 분개(RECEIVABLE 차변 · PARTY_PAYABLE 대변). */
const adjust = (ref: string, partyId: string, amount: bigint) => w.db.tx((tx) => postEntry(tx, w.clock, {
  kind: "ADJUSTMENT", sourceRef: ref, createdBy: "usr_settle",
  postings: [{ account: { kind: "RECEIVABLE" }, amount }, { account: { kind: "PARTY_PAYABLE", partyId }, amount: -amount }],
}));
const payable = (partyId: string) => w.db.tx((tx) => balance(tx, { kind: "PARTY_PAYABLE", partyId }));
const bal = (kind: "WITHHOLDING_TAX" | "PSP_CLEARING") => w.db.tx((tx) => balance(tx, { kind }));
const trialSum = async () => (await w.db.tx((tx) => trialBalance(tx))).reduce((a, r) => a + r.balance, 0n);
const profile = (partyId: string, taxType: string, payoutAccountRef: string | null, kycVerified: boolean) =>
  w.db.tx((tx) => setPayoutProfile(tx, payClock, w.users.settle2, { partyId, taxType, payoutAccountRef, kycVerified }));
const instructions = async (runId: string) => {
  const r = await w.db.pool.query(
    `SELECT party_id, gross_krw::text AS g, withholding_krw::text AS wh, net_krw::text AS n, status, hold_reason, idempotency_key, instruction_id, entry_id::text AS e
       FROM payout_instruction WHERE payout_run_id = $1 ORDER BY party_id`, [runId]);
  return Object.fromEntries(r.rows.map((x) => [x.party_id as string, x]));
};
const submits = () => jobs.sent.filter((j) => j.name === "submit-payout").map((j) => j.data.instructionId);

// 3월 매출 1,234,567 → 미지급금 label 345679, agency 86420, cmo 51851, author_c 34568, member_a 172840, member_b 172839.
await issueCombo(w, "vc_1");
await settleMonth("bat_mar", "ev_1", "1234567", "03");
await w.db.tx((tx) => registerParty(tx, w.clock, { partyId: "pty_fan", partyType: "FAN", displayName: "fan" }));

test("computeWithholding truncates below 10 won and never withholds from zero or negative gross", () => {
  assert.equal(computeWithholding(10_000n, 330), 330n);
  assert.equal(computeWithholding(12_345n, 330), 400n);
  assert.equal(computeWithholding(99n, 2200), 20n);
  assert.equal(computeWithholding(0n, 330), 0n);
  assert.equal(computeWithholding(-50_000n, 2200), 0n);
  assert.equal(computeWithholding(172_840n, 330), 5700n);
  assert.equal(computeWithholding(172_839n, 2200), 38020n);
  assert.equal(computeWithholding(9_223_372_036_854_775_807n, 2200), 2_029_141_848_108_050_670n);
});

test("setPayoutProfile inserts once, then updates only the editable columns", async () => {
  await assert.rejects(w.db.tx((tx) => setPayoutProfile(tx, payClock, w.users.ops, { partyId: "pty_member_a", taxType: "EXEMPT", kycVerified: true })), { code: "ROLE_REQUIRED", status: 403 });
  await assert.rejects(profile("pty_nobody", "EXEMPT", "acct", true), { status: 404 });
  await assert.rejects(profile("pty_fan", "EXEMPT", "acct", true), { code: "INVALID_PARTY", status: 422 });
  await assert.rejects(profile("pty_member_a", "SOMETHING", "acct", true), { code: "INVALID_TAX_TYPE", status: 422 });
  await profile("pty_member_a", "EXEMPT", null, false);
  nowIso = "2026-03-01T00:00:05.000Z";
  await profile("pty_member_a", "DOMESTIC_INDIVIDUAL", "psp_tok_a", true);
  const r = (await w.db.pool.query("SELECT * FROM party_payout_profile WHERE party_id = 'pty_member_a'")).rows[0];
  assert.equal(r.tax_type, "DOMESTIC_INDIVIDUAL");
  assert.equal(r.payout_account_ref, "psp_tok_a");
  assert.equal(r.kyc_verified, true);
  assert.equal(r.first_payable_at.toISOString(), "2026-03-01T00:00:00.000Z", "first payable instant is kept");
  assert.equal(r.updated_at.toISOString(), "2026-03-01T00:00:05.000Z");
  // 계좌 토큰을 생략하면 그대로 둔다.
  await w.db.tx((tx) => setPayoutProfile(tx, payClock, w.users.settle, { partyId: "pty_member_a", taxType: "DOMESTIC_INDIVIDUAL", kycVerified: true }));
  assert.equal((await w.db.pool.query("SELECT payout_account_ref FROM party_payout_profile WHERE party_id = 'pty_member_a'")).rows[0].payout_account_ref, "psp_tok_a");
  await assert.rejects(w.db.pool.query("UPDATE party_payout_profile SET first_payable_at = now() WHERE party_id = 'pty_member_a'"));
  await assert.rejects(w.db.pool.query("DELETE FROM party_payout_profile WHERE party_id = 'pty_member_a'"));
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action_name = 'PAYOUT_PROFILE_SET' AND entity_id = 'pty_member_a'")).rows[0].n, 3);
});

test("a payout run holds, carries and pays according to the policy, and posts one PAYOUT entry per payment", async () => {
  nowIso = "2026-03-01T00:00:10.000Z";
  await profile("pty_member_b", "FOREIGN", "psp_tok_b", true);
  await profile("pty_agency", "DOMESTIC_CORP", null, true);
  await profile("pty_cmo", "DOMESTIC_CORP", "psp_tok_cmo", false);
  await profile("pty_author_b", "EXEMPT", "psp_tok_ab", true);
  await adjust("adj:ab1", "pty_author_b", 6000n);
  nowIso = "2026-03-20T00:00:00.000Z";
  await profile("pty_author_c", "DOMESTIC_INDIVIDUAL", "psp_tok_ac", true); // 초기 보류는 4월 19일까지
  nowIso = "2026-04-10T00:00:00.000Z";

  await assert.rejects(createPayoutRun(p, w.users.ops, { payoutRunId: "pr-1", asOf: "2026-04-01T00:00:00.000Z" }), { code: "ROLE_REQUIRED", status: 403 });
  await assert.rejects(createPayoutRun(p, w.users.settle, { payoutRunId: "pr-1", asOf: "2026-04-10T00:00:00.001Z" }), { code: "INVALID_AS_OF", status: 422 });
  await assert.rejects(createPayoutRun(p, w.users.settle, { payoutRunId: "pr-1", asOf: "2026-04-01" }), { code: "INVALID_INSTANT", status: 422 });
  await assert.rejects(createPayoutRun(p, w.users.settle, { payoutRunId: "pr/1", asOf: "2026-04-01T00:00:00.000Z" }), { code: "INVALID_ID", status: 422 });
  // '_'는 instruction_id(po_<run>_<party>)의 구분자이므로 run id에 쓸 수 없다.
  await assert.rejects(createPayoutRun(p, w.users.settle, { payoutRunId: "pr_1", asOf: "2026-04-01T00:00:00.000Z" }), { code: "INVALID_ID", status: 422 });

  const before = { label: await payable("pty_label"), author_b: await payable("pty_author_b"), cmo: await payable("pty_cmo") };
  const r = await createPayoutRun(p, w.users.settle, { payoutRunId: "pr-1", asOf: "2026-04-01T00:00:00.000Z" });
  assert.deepEqual(r.counts, { PENDING: 2, HELD: 4, CARRIED: 1 });
  const ins = await instructions("pr-1");
  assert.deepEqual(Object.keys(ins), ["pty_agency", "pty_author_b", "pty_author_c", "pty_cmo", "pty_label", "pty_member_a", "pty_member_b"]);
  assert.deepEqual([ins.pty_label.status, ins.pty_label.hold_reason, ins.pty_label.g], ["HELD", "NO_PROFILE", "345679"]);
  assert.deepEqual([ins.pty_agency.status, ins.pty_agency.hold_reason], ["HELD", "NO_ACCOUNT"]);
  assert.deepEqual([ins.pty_cmo.status, ins.pty_cmo.hold_reason], ["HELD", "KYC_REQUIRED"]);
  assert.deepEqual([ins.pty_author_c.status, ins.pty_author_c.hold_reason], ["HELD", "INITIAL_HOLD"]);
  assert.deepEqual([ins.pty_author_b.status, ins.pty_author_b.hold_reason, ins.pty_author_b.g, ins.pty_author_b.wh], ["CARRIED", null, "6000", "0"]);
  for (const k of ["pty_label", "pty_agency", "pty_cmo", "pty_author_c", "pty_author_b"]) assert.equal(ins[k].e, null, k);
  assert.deepEqual([ins.pty_member_a.status, ins.pty_member_a.g, ins.pty_member_a.wh, ins.pty_member_a.n], ["PENDING", "172840", "5700", "167140"]);
  assert.deepEqual([ins.pty_member_b.status, ins.pty_member_b.g, ins.pty_member_b.wh, ins.pty_member_b.n], ["PENDING", "172839", "38020", "134819"]);
  assert.equal(ins.pty_member_a.instruction_id, "po_pr-1_pty_member_a");
  assert.equal(ins.pty_member_a.idempotency_key, "payout:po_pr-1_pty_member_a");

  const e = (await w.db.pool.query("SELECT kind, entry_id::text AS id, occurred_at FROM journal_entry WHERE source_ref = 'payout:po_pr-1_pty_member_a'")).rows[0];
  assert.equal(e.kind, "PAYOUT");
  assert.equal(e.id, ins.pty_member_a.e);
  const postings = (await w.db.pool.query("SELECT account_id, amount_krw::text AS a FROM posting WHERE entry_id = $1 ORDER BY account_id", [e.id])).rows;
  assert.deepEqual(postings, [
    { account_id: "PARTY_PAYABLE:pty_member_a", a: "172840" }, { account_id: "PSP_CLEARING", a: "-167140" }, { account_id: "WITHHOLDING_TAX", a: "-5700" },
  ]);
  assert.equal(await payable("pty_member_a"), 0n);
  assert.equal(await payable("pty_member_b"), 0n);
  assert.equal(await bal("WITHHOLDING_TAX"), -(5700n + 38020n));
  assert.equal(await bal("PSP_CLEARING"), -(167140n + 134819n));
  assert.equal(await payable("pty_label"), before.label, "held balance stays");
  assert.equal(await payable("pty_author_b"), before.author_b, "carried balance stays");
  assert.equal(await payable("pty_cmo"), before.cmo);
  assert.equal(await trialSum(), 0n);
  assert.deepEqual(submits(), ["po_pr-1_pty_member_a", "po_pr-1_pty_member_b"]);
  const a = await w.db.pool.query("SELECT after_json FROM audit_log WHERE action_name = 'PAYOUT_RUN_CREATED' AND entity_id = 'pr-1'");
  assert.equal(a.rowCount, 1);
});

test("the same payoutRunId is rejected with 409 and writes nothing", async () => {
  const entries = (await w.db.pool.query("SELECT count(*)::int AS n FROM journal_entry")).rows[0].n;
  await assert.rejects(createPayoutRun(p, w.users.settle, { payoutRunId: "pr-1", asOf: "2026-04-02T00:00:00.000Z" }), { code: "PAYOUT_RUN_EXISTS", status: 409 });
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM journal_entry")).rows[0].n, entries);
  assert.equal(submits().length, 2);
});

test("a refund after payout leaves a negative payable that is carried; an earlier asOf never pays the same balance twice", async () => {
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "rf_1", sourceSystem: "app", sourceEventId: "rf_1", eventType: "REFUND", relatedEventId: "ev_1", amountKrw: "123456", currency: "KRW", occurredAt: "2026-04-05T00:00:00.000Z",
  }, refundHook(jobs), noRevisionHook));
  await jobs.drain(jobHandlers(d));
  const owedA = await payable("pty_member_a");
  assert.ok(owedA > 0n, "member_a now owes (debit balance)");
  nowIso = "2026-04-12T00:00:00.000Z";
  // asOf(4/5)는 pr-1 기준 시각(4/1) 뒤지만 pr-1의 PAYOUT 분개(4/10) 앞이다. 이미 지급한 금액은 다시 지급하지 않는다.
  const r = await createPayoutRun(p, w.users.settle, { payoutRunId: "pr-2", asOf: "2026-04-05T00:00:00.000Z" });
  const ins = await instructions("pr-2");
  assert.deepEqual([ins.pty_member_a.status, ins.pty_member_a.g, ins.pty_member_a.wh, ins.pty_member_a.n], ["CARRIED", (-owedA).toString(), "0", (-owedA).toString()]);
  assert.equal(ins.pty_member_b.status, "CARRIED");
  assert.ok(BigInt(ins.pty_member_b.g) < 0n);
  assert.equal(r.counts.PENDING ?? 0, 0);
  assert.equal(await payable("pty_member_a"), owedA);
  assert.equal(submits().length, 2);
  assert.equal(await trialSum(), 0n);
});

test("carried balances accumulate and are paid in a later run once they reach the minimum", async () => {
  await adjust("adj:ab2", "pty_author_b", 6000n);
  await settleMonth("bat_may", "ev_2", "1234567", "05");
  const owedA = await payable("pty_member_a");
  const acBal = await payable("pty_author_c");
  nowIso = "2026-06-01T00:00:00.000Z";
  await createPayoutRun(p, w.users.settle, { payoutRunId: "pr-3", asOf: "2026-06-01T00:00:00.000Z" });
  const ins = await instructions("pr-3");
  assert.deepEqual([ins.pty_author_b.status, ins.pty_author_b.g, ins.pty_author_b.wh, ins.pty_author_b.n], ["PENDING", "12000", "0", "12000"]);
  assert.deepEqual([ins.pty_member_a.status, ins.pty_member_a.g], ["PENDING", (-owedA).toString()]);
  assert.equal(BigInt(ins.pty_member_a.wh), computeWithholding(-owedA, 330));
  assert.deepEqual([ins.pty_author_c.status, ins.pty_author_c.g], ["PENDING", (-acBal).toString()], "initial hold is over");
  assert.equal(ins.pty_label.status, "HELD");
  for (const k of ["pty_author_b", "pty_member_a", "pty_member_b", "pty_author_c"]) assert.equal(await payable(k), 0n, k);
  assert.deepEqual(submits().slice(2), ["po_pr-3_pty_author_b", "po_pr-3_pty_author_c", "po_pr-3_pty_member_a", "po_pr-3_pty_member_b"]);
  assert.equal(await trialSum(), 0n);
});

test("concurrent payout runs are serialized so a balance is paid once", async () => {
  await settleMonth("bat_jun", "ev_3", "500000", "06");
  nowIso = "2026-07-01T00:00:00.000Z";
  const owed = await payable("pty_member_a");
  assert.ok(owed < -10000n);
  await Promise.all([
    createPayoutRun(p, w.users.settle, { payoutRunId: "pr-4a", asOf: "2026-07-01T00:00:00.000Z" }),
    createPayoutRun(p, w.users.settle, { payoutRunId: "pr-4b", asOf: "2026-07-01T00:00:00.000Z" }),
  ]);
  const paid = (await w.db.pool.query(
    "SELECT payout_run_id, gross_krw::text AS g FROM payout_instruction WHERE party_id = 'pty_member_a' AND payout_run_id IN ('pr-4a','pr-4b') AND status = 'PENDING'")).rows;
  assert.equal(paid.length, 1);
  assert.equal(paid[0].g, (-owed).toString());
  assert.equal(await payable("pty_member_a"), 0n);
  assert.equal(await trialSum(), 0n);
});

test("a run whose asOf is earlier than a previous run's asOf is rejected, so clawed-back money is not paid again", async () => {
  const at = (iso: string): Clock => ({ now: () => iso });
  const post = (ref: string, iso: string, amount: bigint) => w.db.tx((tx) => postEntry(tx, at(iso), {
    kind: "ADJUSTMENT", sourceRef: ref, createdBy: "usr_settle",
    postings: [{ account: { kind: "RECEIVABLE" }, amount }, { account: { kind: "PARTY_PAYABLE", partyId: "pty_author_b" }, amount: -amount }],
  }));
  assert.equal(await payable("pty_author_b"), 0n);
  await post("adj:regress-credit", "2026-07-02T00:00:00.000Z", 100_000n); // 7/2 발생 100,000
  await post("adj:regress-claw", "2026-07-20T00:00:00.000Z", -40_000n); // 7/20 환수 −40,000
  nowIso = "2026-08-01T00:00:00.000Z";
  await createPayoutRun(p, w.users.settle, { payoutRunId: "pr-5", asOf: "2026-08-01T00:00:00.000Z" });
  assert.deepEqual([(await instructions("pr-5")).pty_author_b.status, (await instructions("pr-5")).pty_author_b.g], ["PENDING", "60000"]);
  assert.equal(await payable("pty_author_b"), 0n);
  const entries = (await w.db.pool.query("SELECT count(*)::int AS n FROM journal_entry")).rows[0].n;
  const sent = submits().length;
  // asOf 7/15로 다시 실행하면 7/20 환수가 빠져 40,000을 다시 지급하게 된다 → 거부.
  await assert.rejects(createPayoutRun(p, w.users.settle, { payoutRunId: "pr-6", asOf: "2026-07-15T00:00:00.000Z" }), { code: "AS_OF_REGRESSED", status: 422 });
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM payout_run WHERE payout_run_id = 'pr-6'")).rows[0].n, 0);
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM journal_entry")).rows[0].n, entries);
  assert.equal(submits().length, sent);
  assert.equal(await payable("pty_author_b"), 0n);
  // 같은 asOf는 허용된다(이미 지급한 잔액은 0으로 남는다).
  await createPayoutRun(p, w.users.settle, { payoutRunId: "pr-7", asOf: "2026-08-01T00:00:00.000Z" });
  assert.deepEqual([(await instructions("pr-7")).pty_author_b.status, (await instructions("pr-7")).pty_author_b.g], ["CARRIED", "0"]);
  assert.equal(await trialSum(), 0n);
});

test("payout_instruction state guard: allowed transitions only, write-once provider fields, identity columns immutable", async () => {
  const id = "po_pr-3_pty_author_b";
  const q = (sql: string) => w.db.pool.query(sql, [id]);
  await assert.rejects(q("UPDATE payout_instruction SET status = 'CARRIED' WHERE instruction_id = $1"), { code: "RC001" });
  await assert.rejects(q("UPDATE payout_instruction SET gross_krw = 1, net_krw = 1 WHERE instruction_id = $1"));
  await q("UPDATE payout_instruction SET status = 'SUBMITTED', provider_ref = 'psp_1' WHERE instruction_id = $1");
  await assert.rejects(q("UPDATE payout_instruction SET provider_ref = 'psp_2' WHERE instruction_id = $1"), { code: "RC001" });
  await assert.rejects(q("UPDATE payout_instruction SET status = 'PENDING' WHERE instruction_id = $1"), { code: "RC001" });
  await q("UPDATE payout_instruction SET status = 'PAID' WHERE instruction_id = $1");
  await assert.rejects(q("UPDATE payout_instruction SET status = 'FAILED' WHERE instruction_id = $1"), { code: "RC001" });
  await assert.rejects(q("DELETE FROM payout_instruction WHERE instruction_id = $1"));
  const held = "po_pr-1_pty_label";
  await assert.rejects(w.db.pool.query("UPDATE payout_instruction SET status = 'PENDING' WHERE instruction_id = $1", [held]), { code: "RC001" });
  await assert.rejects(w.db.pool.query("UPDATE payout_instruction SET provider_ref = 'x' WHERE instruction_id = $1", [held]), { code: "RC001" });
  await assert.rejects(w.db.pool.query("UPDATE payout_run SET as_of = as_of WHERE payout_run_id = 'pr-1'"));
  await assert.rejects(w.db.pool.query("UPDATE payout_policy SET min_payout_krw = 1"));
});

test("payout_instruction INSERT guard: only PENDING, CARRIED or HELD, with every PSP field NULL", async () => {
  const entry = (await w.db.pool.query("SELECT entry_id::text AS e FROM payout_instruction WHERE instruction_id = 'po_pr-1_pty_member_a'")).rows[0].e as string;
  let n = 0;
  const ins = (status: string, extra: Record<string, unknown> = {}) => {
    n++;
    const cols: Record<string, unknown> = {
      instruction_id: `po_guard${n}_x`, payout_run_id: "pr-1", party_id: "pty_fan", gross_krw: 1000, withholding_krw: 0, net_krw: 1000, status,
      hold_reason: status === "HELD" ? "NO_PROFILE" : null, idempotency_key: `payout:po_guard${n}_x`,
      entry_id: status === "CARRIED" || status === "HELD" ? null : entry, decided_account_ref: status === "CARRIED" || status === "HELD" ? null : "tok",
      created_at: "2026-08-01T00:00:00.000Z", ...extra,
    };
    const keys = Object.keys(cols);
    return w.db.pool.query(`INSERT INTO payout_instruction (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => cols[k]));
  };
  const c = await w.db.pool.connect();
  try {
    await c.query("BEGIN");
    // 허용: PENDING·CARRIED·HELD, PSP 필드 NULL. (롤백한다)
    for (const s of ["PENDING", "CARRIED", "HELD"]) {
      await c.query("INSERT INTO payout_run (payout_run_id, as_of, created_by, created_at) VALUES ($1, '2026-08-01T00:00:00.000Z', 'usr_settle', '2026-08-01T00:00:00.000Z')", [`ok-${s}`]);
      await c.query(`INSERT INTO payout_instruction (instruction_id, payout_run_id, party_id, gross_krw, withholding_krw, net_krw, status, hold_reason, idempotency_key, entry_id, decided_account_ref, created_at)
        VALUES ($1, $2, 'pty_fan', 1000, 0, 1000, $3, $4, $5, $6, $7, '2026-08-01T00:00:00.000Z')`,
      [`po_ok-${s}_x`, `ok-${s}`, s, s === "HELD" ? "NO_PROFILE" : null, `payout:po_ok-${s}_x`, s === "PENDING" ? entry : null, s === "PENDING" ? "tok" : null]);
    }
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
  await assert.rejects(ins("SUBMITTED"), { code: "RC001" });
  await assert.rejects(ins("PAID", { settled_entry_id: entry }), { code: "RC001" });
  await assert.rejects(ins("FAILED", { settled_entry_id: entry }), { code: "RC001" });
  await assert.rejects(ins("PENDING", { provider_ref: "psp_x" }), { code: "RC001" });
  await assert.rejects(ins("PENDING", { settled_entry_id: entry }), { code: "RC001" });
  await assert.rejects(ins("PENDING", { submit_attempted_at: "2026-08-01T00:00:00.000Z", submitted_account_ref: "tok" }), { code: "RC001" });
  await assert.rejects(ins("PENDING", { submit_unknown_at: "2026-08-01T00:00:00.000Z" }), { code: "RC001" });
  // 판정한 계좌 토큰: PENDING에는 반드시, CARRIED·HELD에는 없다. 이후에는 바꿀 수 없다(UPDATE 권한 없음, 가드).
  await assert.rejects(ins("PENDING", { decided_account_ref: null }), { code: "RC001" });
  await assert.rejects(ins("HELD", { decided_account_ref: "tok" }), { code: "RC001" });
  await assert.rejects(ins("CARRIED", { decided_account_ref: "tok" }), { code: "RC001" });
  assert.equal((await w.db.pool.query("SELECT decided_account_ref AS r FROM payout_instruction WHERE instruction_id = 'po_pr-1_pty_member_a'")).rows[0].r, "psp_tok_a");
  assert.equal((await w.db.pool.query("SELECT decided_account_ref AS r FROM payout_instruction WHERE instruction_id = 'po_pr-1_pty_label'")).rows[0].r, null);
  await assert.rejects(w.db.pool.query("UPDATE payout_instruction SET decided_account_ref = 'x' WHERE instruction_id = 'po_pr-1_pty_member_a'"), { code: "42501" });
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM payout_instruction WHERE instruction_id LIKE 'po_guard%'")).rows[0].n, 0);
});

test("account change control: a new token cools for 72 hours, and the user who changed it cannot run the payout that pays it", async () => {
  assert.equal((await w.db.tx((tx) => loadPayoutPolicy(tx))).accountCoolingHours, 72, "default cooling");
  const row = async () => (await w.db.pool.query(
    "SELECT payout_account_ref AS ref, account_changed_at AS at, account_changed_by AS by FROM party_payout_profile WHERE party_id = 'pty_author_b'")).rows[0];
  const before = await row();
  assert.equal(before.by, "usr_settle2");
  // 토큰 없이(KYC·세금 유형만) 바꾸면 변경 기록은 그대로다.
  nowIso = "2026-08-30T00:00:00.000Z";
  await w.db.tx((tx) => setPayoutProfile(tx, payClock, w.users.settle, { partyId: "pty_author_b", taxType: "EXEMPT", kycVerified: true }));
  await profile("pty_author_b", "EXEMPT", "psp_tok_ab", true); // 같은 토큰
  assert.deepEqual(await row(), before, "same token: account_changed_at/by unchanged");
  // DB도 토큰 변경 없이 변경 기록을 바꾸지 못하게 한다.
  await assert.rejects(w.db.pool.query("UPDATE party_payout_profile SET account_changed_at = '2020-01-01T00:00:00.000Z' WHERE party_id = 'pty_author_b'"), { code: "RC001" });
  await assert.rejects(w.db.pool.query("UPDATE party_payout_profile SET account_changed_by = 'usr_settle' WHERE party_id = 'pty_author_b'"), { code: "RC001" });

  // usr_settle2가 9/1에 토큰을 바꾼다: 변경 기록과 감사(이전·새 토큰).
  nowIso = "2026-09-01T00:00:00.000Z";
  await profile("pty_author_b", "EXEMPT", "psp_tok_ab_new", true);
  const changed = await row();
  assert.deepEqual([changed.ref, changed.at.toISOString(), changed.by], ["psp_tok_ab_new", "2026-09-01T00:00:00.000Z", "usr_settle2"]);
  const a = (await w.db.pool.query(
    "SELECT after_json FROM audit_log WHERE action_name = 'PAYOUT_PROFILE_SET' AND entity_id = 'pty_author_b' ORDER BY audit_id DESC LIMIT 1")).rows[0].after_json;
  assert.equal(a.accountChanged, true);
  assert.deepEqual(a.before, { taxType: "EXEMPT", payoutAccountRef: "psp_tok_ab", kycVerified: true });
  assert.deepEqual(a.after, { taxType: "EXEMPT", payoutAccountRef: "psp_tok_ab_new", kycVerified: true });

  await adjust("adj:cool", "pty_author_b", 50_000n);
  const status = async (runId: string) => { const i = (await instructions(runId)).pty_author_b; return [i.status, i.hold_reason]; };
  // 24시간 뒤 기준 시각: 냉각 중.
  nowIso = "2026-09-02T00:00:00.000Z";
  await createPayoutRun(p, w.users.settle, { payoutRunId: "cool-1", asOf: "2026-09-02T00:00:00.000Z" });
  assert.deepEqual(await status("cool-1"), ["HELD", "ACCOUNT_COOLING"]);
  // 72시간 − 1ms: 여전히 냉각 중.
  nowIso = "2026-09-05T00:00:00.000Z";
  await createPayoutRun(p, w.users.settle, { payoutRunId: "cool-2", asOf: "2026-09-03T23:59:59.999Z" });
  assert.deepEqual(await status("cool-2"), ["HELD", "ACCOUNT_COOLING"]);
  // 냉각이 끝났어도 토큰을 바꾼 usr_settle2가 실행하면 직무 분리로 보류.
  await createPayoutRun(p, w.users.settle2, { payoutRunId: "cool-3", asOf: "2026-09-04T00:00:00.000Z" });
  assert.deepEqual(await status("cool-3"), ["HELD", "ACCOUNT_SOD"]);
  assert.equal(await payable("pty_author_b"), -50_000n, "held: nothing paid yet");
  // 냉각이 끝나고 다른 사용자(usr_settle)가 실행하면 지급된다.
  await createPayoutRun(p, w.users.settle, { payoutRunId: "cool-4", asOf: "2026-09-04T00:00:00.000Z" });
  assert.deepEqual(await status("cool-4"), ["PENDING", null]);
  assert.equal(await payable("pty_author_b"), 0n);
  assert.equal(await trialSum(), 0n);
});

test("with payout.account-run disabled the user who changed the token may run the payout (MVP 총괄 운영, 결정 RD6)", async () => {
  await setSodRules(w.adminUrl, ["payout.account-run"], false);
  try {
    // 이전 시험과 같은 준비: usr_settle2가 토큰을 바꾸고 냉각이 끝난 뒤 같은 사람이 실행한다 → 보류 없이 지급.
    nowIso = "2026-10-01T00:00:00.000Z";
    await profile("pty_author_b", "EXEMPT", "psp_tok_ab_off", true);
    await adjust("adj:sod-off", "pty_author_b", 50_000n);
    nowIso = "2026-10-05T00:00:00.000Z";
    await createPayoutRun(p, w.users.settle2, { payoutRunId: "sod-off", asOf: "2026-10-04T00:00:00.000Z" });
    const i = (await instructions("sod-off")).pty_author_b;
    assert.deepEqual([i.status, i.hold_reason], ["PENDING", null]);
    assert.equal(await payable("pty_author_b"), 0n);
  } finally {
    await setSodRules(w.adminUrl, ["payout.account-run"], true);
  }
});
