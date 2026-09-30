import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { fixedClock, type Clock } from "../../src/platform/clock.ts";
import { recordingJobs, type RecordingJobs } from "../../src/platform/jobs.ts";
import { balance, postEntry, trialBalance } from "../../src/ledger/journal.ts";
import { computeWithholding } from "../../src/payout/policy.ts";
import { createPayoutRun, setPayoutProfile } from "../../src/payout/service.ts";
import type { PayoutProvider, ProviderResult } from "../../src/payout/provider.ts";
import { providerFromEnv } from "../../src/payout/provider.ts";
import { fakeProvider } from "../../src/payout/fake-provider.ts";
import { applyPspResult, payoutJobHandlers, pollPayout, recordWebhook, submitPayout, type PayoutDeps } from "../../src/payout/handlers.ts";
import { settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
// 지급 시계: 초기 보류(30일)가 끝난 6월부터 1ms씩 흐른다. 프로필은 1월에 만든다.
const clock: Clock = fixedClock("2026-06-01T00:00:00.000Z", 1);
const profileClock = fixedClock("2026-01-01T00:00:00.000Z", 0);

type Env = { jobs: RecordingJobs; provider: ReturnType<typeof fakeProvider>; p: PayoutDeps };
const env = (provider = fakeProvider()): Env => {
  const jobs = recordingJobs();
  return { jobs, provider, p: { db: w.db, clock, jobs, provider } };
};
const profile = (partyId: string, taxType: string, payoutAccountRef: string | null = `tok_${partyId}`) =>
  w.db.tx((tx) => setPayoutProfile(tx, profileClock, w.users.settle, { partyId, taxType, payoutAccountRef, kycVerified: true }));
const adjust = (ref: string, partyId: string, amount: bigint) => w.db.tx((tx) => postEntry(tx, clock, {
  kind: "ADJUSTMENT", sourceRef: ref, createdBy: "usr_settle",
  postings: [{ account: { kind: "RECEIVABLE" }, amount }, { account: { kind: "PARTY_PAYABLE", partyId }, amount: -amount }],
}));
const payable = (partyId: string) => w.db.tx((tx) => balance(tx, { kind: "PARTY_PAYABLE", partyId }));
const bal = (kind: "WITHHOLDING_TAX" | "PSP_CLEARING" | "CASH") => w.db.tx((tx) => balance(tx, { kind }));
const trialSum = async () => (await w.db.tx((tx) => trialBalance(tx))).reduce((a, r) => a + r.balance, 0n);
let runSeq = 0;
/** 권리자에게 gross를 쌓고 지급 실행을 만든다. 돌려주는 값은 그 권리자의 지시 id. */
const payRun = async (e: Env, partyId: string, gross: bigint | null) => {
  const runId = `psp-${++runSeq}`;
  if (gross !== null) await adjust(`adj:${runId}`, partyId, gross);
  await createPayoutRun(e.p, w.users.settle, { payoutRunId: runId, asOf: clock.now() });
  return `po_${runId}_${partyId}`;
};
const instr = async (id: string) => (await w.db.pool.query(
  "SELECT status, provider_ref, gross_krw::text AS g, withholding_krw::text AS wh, net_krw::text AS n, entry_id::text AS e, settled_entry_id::text AS s FROM payout_instruction WHERE instruction_id = $1", [id])).rows[0];
const entries = async (id: string) => (await w.db.pool.query(
  "SELECT kind, source_ref FROM journal_entry WHERE source_ref IN ($1, $2, $3) ORDER BY entry_id", [`payout:${id}`, `settled:${id}`, `failed:${id}`])).rows.map((r) => `${r.kind} ${r.source_ref}`);
const postings = async (sourceRef: string) => (await w.db.pool.query(
  "SELECT p.account_id, p.amount_krw::text AS a FROM posting p JOIN journal_entry j USING (entry_id) WHERE j.source_ref = $1 ORDER BY p.account_id", [sourceRef])).rows;
const ops = (e: Env) => e.provider.calls.map((c) => c.op);
/** 가짜 어댑터 규칙(실지급액 기준): 97의 배수 → FAILED, 89의 배수 → 첫 submit UNKNOWN, 그 밖 → ACCEPTED 후 PAID. */
const net = (g: bigint, bps: number) => g - computeWithholding(g, bps);
const findGross = (from: bigint, ok: (g: bigint) => boolean) => { let g = from; while (!ok(g)) g++; return g; };
const plain = (n: bigint) => n % 97n !== 0n && n % 89n !== 0n;

await profile("pty_member_a", "DOMESTIC_INDIVIDUAL");
await profile("pty_member_b", "DOMESTIC_INDIVIDUAL");
await profile("pty_label", "EXEMPT");
await profile("pty_agency", "EXEMPT");
await profile("pty_cmo", "EXEMPT");
await profile("pty_author_b", "EXEMPT");
await profile("pty_author_c", "EXEMPT");

test("fake provider is deterministic by amount and idempotency key and records every call", async () => {
  const f = fakeProvider();
  const i = (amountKrw: bigint) => ({ instructionId: "po_x", partyId: "pty_x", accountRef: "tok", amountKrw });
  const ok = await f.submit(i(10_000n), "k1");
  assert.equal(ok.status, "ACCEPTED");
  assert.ok(ok.providerRef);
  assert.deepEqual(await f.submit(i(10_000n), "k1"), ok, "same key, same result");
  assert.deepEqual(await f.status(ok.providerRef!, "k1"), { status: "PAID", providerRef: ok.providerRef });
  assert.equal((await f.submit(i(97n * 200n), "k2")).status, "FAILED");
  assert.equal((await f.status("", "k2")).status, "FAILED");
  const u = await f.submit(i(89n * 200n), "k3");
  assert.deepEqual(u, { status: "UNKNOWN" });
  const s = await f.status("", "k3");
  assert.equal(s.status, "PAID");
  assert.ok(s.providerRef);
  assert.equal((await f.status("", "never")).status, "UNKNOWN");
  assert.deepEqual(f.webhook("k1"), { providerEventId: "evt_k1", providerRef: ok.providerRef, status: "PAID" });
  assert.equal(f.webhook("k2").status, "FAILED");
  assert.throws(() => f.webhook("never"));
  assert.deepEqual(f.calls.map((c) => `${c.op} ${c.key}`), ["submit k1", "submit k1", "status k1", "submit k2", "status k2", "submit k3", "status k3", "status never"]);
});

test("RC_PSP selects the fake provider when unset or 'fake' and refuses anything else", () => {
  assert.equal(typeof providerFromEnv({}).submit, "function");
  assert.equal(typeof providerFromEnv({ RC_PSP: "fake" }).submit, "function");
  assert.equal(typeof providerFromEnv({ RC_PSP: "" }).submit, "function");
  assert.throws(() => providerFromEnv({ RC_PSP: "toss" }), /RC_PSP/);
});

test("accepted payout: SUBMITTED with provider ref, delayed poll, then PAID with a PAYOUT_SETTLED entry", async () => {
  const e = env();
  const g = findGross(150_000n, (x) => plain(net(x, 330)));
  const cashBefore = await bal("CASH");
  const clearingBefore = await bal("PSP_CLEARING");
  const id = await payRun(e, "pty_member_a", g);
  const n = net(g, 330);
  assert.deepEqual(e.jobs.sent.map((j) => j.name), ["submit-payout"]);

  await submitPayout(e.p, { instructionId: id });
  const s = await instr(id);
  assert.equal(s.status, "SUBMITTED");
  assert.equal(s.provider_ref, e.provider.webhook(`payout:${id}`).providerRef);
  const poll = e.jobs.sent.find((j) => j.name === "poll-payout")!;
  assert.deepEqual(poll.data, { instructionId: id, attempt: "1" });
  assert.ok((poll.startAfterSeconds ?? 0) > 0, "poll is delayed");
  assert.deepEqual(e.provider.calls, [{ op: "submit", key: `payout:${id}` }]);

  await e.jobs.drain(payoutJobHandlers(e.p));
  const f = await instr(id);
  assert.equal(f.status, "PAID");
  assert.deepEqual(await entries(id), [`PAYOUT payout:${id}`, `PAYOUT_SETTLED settled:${id}`]);
  assert.equal(f.s, (await w.db.pool.query("SELECT entry_id::text AS e FROM journal_entry WHERE source_ref = $1", [`settled:${id}`])).rows[0].e);
  assert.deepEqual(await postings(`settled:${id}`), [{ account_id: "CASH", a: (-n).toString() }, { account_id: "PSP_CLEARING", a: n.toString() }]);
  assert.equal(await payable("pty_member_a"), 0n);
  assert.equal(await bal("CASH"), cashBefore - n);
  assert.equal(await bal("PSP_CLEARING"), clearingBefore);
  assert.deepEqual(ops(e), ["submit", "status"]);

  // 끝 상태의 지시는 다시 실행해도 provider를 부르지 않고 아무것도 쓰지 않는다.
  await submitPayout(e.p, { instructionId: id });
  await pollPayout(e.p, { instructionId: id });
  await applyPspResult(e.p, { instructionId: id, status: "FAILED" });
  assert.deepEqual(ops(e), ["submit", "status"]);
  assert.equal((await instr(id)).status, "PAID");
  assert.deepEqual(await entries(id), [`PAYOUT payout:${id}`, `PAYOUT_SETTLED settled:${id}`]);
  assert.equal(await trialSum(), 0n);
});

test("failed payout: PAYOUT_FAILED exactly reverses PAYOUT, restoring payable and withholding; a later run pays the balance once", async () => {
  const e = env();
  // 원천징수 후 실지급액이 97의 배수(실패). 총액 자체는 보통 금액이라 면세로 바꾸면 성공한다.
  const g = findGross(150_000n, (x) => net(x, 330) % 97n === 0n && plain(x) && computeWithholding(x, 330) > 0n);
  const whBefore = await bal("WITHHOLDING_TAX");
  const clearingBefore = await bal("PSP_CLEARING");
  const cashBefore = await bal("CASH");
  const id = await payRun(e, "pty_member_b", g);
  assert.equal(await payable("pty_member_b"), 0n);
  assert.equal(await bal("WITHHOLDING_TAX"), whBefore - computeWithholding(g, 330));

  await e.jobs.drain(payoutJobHandlers(e.p));
  const f = await instr(id);
  assert.equal(f.status, "FAILED");
  assert.equal(f.provider_ref, e.provider.webhook(`payout:${id}`).providerRef);
  assert.deepEqual(await entries(id), [`PAYOUT payout:${id}`, `PAYOUT_FAILED failed:${id}`]);
  const neg = (await postings(`payout:${id}`)).map((r) => ({ account_id: r.account_id, a: (-BigInt(r.a)).toString() }));
  assert.deepEqual(await postings(`failed:${id}`), neg);
  assert.deepEqual(await postings(`failed:${id}`), [
    { account_id: "PARTY_PAYABLE:pty_member_b", a: (-g).toString() },
    { account_id: "PSP_CLEARING", a: net(g, 330).toString() },
    { account_id: "WITHHOLDING_TAX", a: computeWithholding(g, 330).toString() },
  ]);
  assert.equal(await payable("pty_member_b"), -g, "payable restored");
  assert.equal(await bal("WITHHOLDING_TAX"), whBefore, "withholding back");
  assert.equal(await bal("PSP_CLEARING"), clearingBefore);
  assert.equal(await bal("CASH"), cashBefore);
  assert.deepEqual(ops(e), ["submit"], "a FAILED submit is final without a status call");

  // 계좌 문제를 고친 뒤(면세 → 실지급액 = 총액, 보통 금액) 다음 실행이 복원된 잔액을 한 번 지급한다.
  await profile("pty_member_b", "EXEMPT");
  const id2 = await payRun(e, "pty_member_b", null);
  assert.deepEqual([(await instr(id2)).status, (await instr(id2)).g, (await instr(id2)).n], ["PENDING", g.toString(), g.toString()]);
  await e.jobs.drain(payoutJobHandlers(e.p));
  assert.equal((await instr(id2)).status, "PAID");
  assert.equal(await payable("pty_member_b"), 0n);
  assert.equal(await bal("CASH"), cashBefore - g);
  const id3 = await payRun(e, "pty_member_b", null);
  assert.deepEqual([(await instr(id3)).status, (await instr(id3)).g], ["CARRIED", "0"], "the restored balance is paid exactly once");
  await profile("pty_member_b", "DOMESTIC_INDIVIDUAL");
  assert.equal(await trialSum(), 0n);
});

test("unknown submit result: submit once, never resubmit, and resolve by status polling", async () => {
  const e = env();
  const g = findGross(150_000n, (x) => x % 89n === 0n && x % 97n !== 0n);
  const id = await payRun(e, "pty_label", g);
  await submitPayout(e.p, { instructionId: id });
  const s = await instr(id);
  assert.deepEqual([s.status, s.provider_ref], ["PENDING", null], "UNKNOWN keeps the state");
  assert.deepEqual(e.jobs.sent.filter((j) => j.name === "poll-payout").map((j) => j.data), [{ instructionId: id, attempt: "1" }]);
  // submit-payout 재실행(중복 작업·재시도)도 새로 보내지 않는다 — 재조회가 먼저다.
  await submitPayout(e.p, { instructionId: id });
  assert.deepEqual(ops(e), ["submit"]);
  await e.jobs.drain(payoutJobHandlers(e.p));
  const f = await instr(id);
  assert.equal(f.status, "PAID");
  assert.ok(f.provider_ref, "the provider ref learned by status is stored");
  assert.deepEqual(ops(e), ["submit", "status"]);
  assert.deepEqual(await entries(id), [`PAYOUT payout:${id}`, `PAYOUT_SETTLED settled:${id}`]);
  assert.equal(await payable("pty_label"), 0n);
  assert.equal(await trialSum(), 0n);
});

test("webhook: stored once in the inbox, a duplicate does nothing, and the result is applied once together with polling", async () => {
  const e = env();
  const g = findGross(150_000n, plain);
  const id = await payRun(e, "pty_agency", g);
  await submitPayout(e.p, { instructionId: id });
  assert.equal((await instr(id)).status, "SUBMITTED");
  const hook = e.provider.webhook(`payout:${id}`);
  const rec = () => w.db.tx((tx) => recordWebhook(tx, clock, e.jobs, { ...hook, payload: { raw: hook } }));
  assert.deepEqual(await rec(), { created: true });
  assert.deepEqual(await rec(), { created: false });
  const applies = e.jobs.sent.filter((j) => j.name === "apply-psp-result");
  assert.deepEqual(applies.map((j) => j.data), [{ instructionId: id, status: "PAID", providerEventId: hook.providerEventId }]);
  // webhook 결과를 먼저 반영하고, 뒤이어 대기 중인 poll-payout이 처리돼도 분개는 하나.
  const h = payoutJobHandlers(e.p);
  await e.jobs.drain({ "apply-psp-result": h["apply-psp-result"]! });
  await e.jobs.drain(h);
  assert.equal((await instr(id)).status, "PAID");
  assert.deepEqual(await entries(id), [`PAYOUT payout:${id}`, `PAYOUT_SETTLED settled:${id}`]);
  assert.deepEqual(ops(e), ["submit"], "poll after a final state does not call the provider");
  const inbox = (await w.db.pool.query("SELECT provider_ref, status, payload, processed_at FROM psp_webhook_inbox WHERE provider_event_id = $1", [hook.providerEventId])).rows[0];
  assert.deepEqual([inbox.provider_ref, inbox.status, inbox.payload], [hook.providerRef, "PAID", { raw: hook }]);
  assert.ok(inbox.processed_at instanceof Date);
  assert.equal(await trialSum(), 0n);
});

test("a webhook for an unknown provider ref is kept unprocessed and applied once submit records that ref", async () => {
  const e = env();
  const g = findGross(150_000n, plain);
  const id = await payRun(e, "pty_author_c", g);
  // PSP가 결과를 먼저 알려 온다(우리 쪽 submit 결과 반영 전).
  await e.provider.submit({ instructionId: id, partyId: "pty_author_c", accountRef: "tok_pty_author_c", amountKrw: g }, `payout:${id}`);
  const hook = e.provider.webhook(`payout:${id}`);
  assert.deepEqual(await w.db.tx((tx) => recordWebhook(tx, clock, e.jobs, { ...hook, payload: {} })), { created: true });
  assert.equal(e.jobs.sent.filter((j) => j.name === "apply-psp-result").length, 0);
  await submitPayout(e.p, { instructionId: id });
  assert.deepEqual(e.jobs.sent.filter((j) => j.name === "apply-psp-result").map((j) => j.data), [{ instructionId: id, status: "PAID", providerEventId: hook.providerEventId }]);
  await e.jobs.drain(payoutJobHandlers(e.p));
  assert.equal((await instr(id)).status, "PAID");
  assert.deepEqual(await entries(id), [`PAYOUT payout:${id}`, `PAYOUT_SETTLED settled:${id}`]);
  assert.ok((await w.db.pool.query("SELECT processed_at FROM psp_webhook_inbox WHERE provider_event_id = $1", [hook.providerEventId])).rows[0].processed_at);
});

test("concurrent webhook applications and a poll write a single settlement entry", async () => {
  const e = env();
  const g = findGross(150_000n, plain);
  const id = await payRun(e, "pty_cmo", g);
  await submitPayout(e.p, { instructionId: id });
  await Promise.all([
    applyPspResult(e.p, { instructionId: id, status: "PAID" }),
    applyPspResult(e.p, { instructionId: id, status: "PAID" }),
    pollPayout(e.p, { instructionId: id }),
    applyPspResult(e.p, { instructionId: id, status: "PAID" }),
  ]);
  assert.equal((await instr(id)).status, "PAID");
  assert.deepEqual(await entries(id), [`PAYOUT payout:${id}`, `PAYOUT_SETTLED settled:${id}`]);
  assert.equal(await payable("pty_cmo"), 0n);
  // 다른 결과가 뒤늦게 와도 바꾸지 않고 감사에 남긴다.
  await applyPspResult(e.p, { instructionId: id, status: "FAILED" });
  assert.equal((await instr(id)).status, "PAID");
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action_name = 'PAYOUT_RESULT_CONFLICT' AND entity_id = $1", [id])).rows[0].n, 1);
  assert.equal(await trialSum(), 0n);
});

test("a payout the provider never settles stops polling after 10 attempts with a PAYOUT_STUCK audit", async () => {
  const f = fakeProvider();
  const stuck: PayoutProvider & { calls: { op: string; key: string }[] } = {
    calls: f.calls,
    submit: (i, k) => f.submit(i, k),
    status: async (_ref, k): Promise<ProviderResult> => { f.calls.push({ op: "status", key: k }); return { status: "ACCEPTED" }; },
  };
  const jobs = recordingJobs();
  const p: PayoutDeps = { db: w.db, clock, jobs, provider: stuck };
  const g = findGross(150_000n, plain);
  const runId = `psp-${++runSeq}`;
  await adjust(`adj:${runId}`, "pty_author_b", g);
  await createPayoutRun(p, w.users.settle, { payoutRunId: runId, asOf: clock.now() });
  const id = `po_${runId}_pty_author_b`;
  await jobs.drain(payoutJobHandlers(p));
  assert.equal((await instr(id)).status, "SUBMITTED");
  assert.equal(stuck.calls.filter((c) => c.op === "status").length, 10);
  assert.deepEqual(jobs.sent.filter((j) => j.name === "poll-payout").map((j) => j.data.attempt), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action_name = 'PAYOUT_STUCK' AND entity_id = $1", [id])).rows[0].n, 1);
  assert.deepEqual(await entries(id), [`PAYOUT payout:${id}`]);
});

test("a payout whose account token was removed after the run fails without calling the provider", async () => {
  const e = env();
  const g = findGross(150_000n, plain);
  const runId = `psp-${++runSeq}`;
  await adjust(`adj:${runId}`, "pty_cmo", g);
  await createPayoutRun(e.p, w.users.settle, { payoutRunId: runId, asOf: clock.now() });
  const id = `po_${runId}_pty_cmo`;
  await profile("pty_cmo", "EXEMPT", null);
  await e.jobs.drain(payoutJobHandlers(e.p));
  assert.equal((await instr(id)).status, "FAILED");
  assert.deepEqual(ops(e), []);
  assert.equal(await payable("pty_cmo"), -g);
  await profile("pty_cmo", "EXEMPT");
  assert.equal(await trialSum(), 0n);
});

test("psp_webhook_inbox: only processed_at changes, once; no deletes", async () => {
  await w.db.pool.query("INSERT INTO psp_webhook_inbox (provider_event_id, provider_ref, status, payload, received_at) VALUES ('evt_guard', 'ref_guard', 'PAID', '{}', '2026-06-01T00:00:00.000Z')");
  const q = (sql: string) => w.db.pool.query(sql);
  // rc_app은 processed_at만 UPDATE 권한이 있다(42501). 가드 트리거(RC001)는 소유자 역할에도 적용된다.
  await assert.rejects(q("UPDATE psp_webhook_inbox SET provider_ref = 'x' WHERE provider_event_id = 'evt_guard'"), { code: "42501" });
  await assert.rejects(q("UPDATE psp_webhook_inbox SET status = 'FAILED' WHERE provider_event_id = 'evt_guard'"), { code: "42501" });
  await q("UPDATE psp_webhook_inbox SET processed_at = '2026-06-01T00:00:01.000Z' WHERE provider_event_id = 'evt_guard'");
  await assert.rejects(q("UPDATE psp_webhook_inbox SET processed_at = '2026-06-01T00:00:02.000Z' WHERE provider_event_id = 'evt_guard'"), { code: "RC001" });
  await assert.rejects(q("DELETE FROM psp_webhook_inbox WHERE provider_event_id = 'evt_guard'"));
  const admin = new pg.Client({ connectionString: w.adminUrl });
  await admin.connect();
  try {
    await admin.query("INSERT INTO psp_webhook_inbox (provider_event_id, provider_ref, status, payload, received_at) VALUES ('evt_owner', 'ref_owner', 'PAID', '{}', '2026-06-01T00:00:00.000Z')");
    await assert.rejects(admin.query("UPDATE psp_webhook_inbox SET provider_ref = 'x' WHERE provider_event_id = 'evt_owner'"), { code: "RC001" });
  } finally {
    await admin.end();
  }
  await assert.rejects(q("INSERT INTO psp_webhook_inbox (provider_event_id, provider_ref, status, payload, received_at) VALUES ('evt_ms', 'r', 'PAID', '{}', '2026-06-01T00:00:00.0001Z')"));
});
