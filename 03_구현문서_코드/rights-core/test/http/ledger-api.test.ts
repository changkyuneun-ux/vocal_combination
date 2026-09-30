import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fixedClock, type Clock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { payoutJobHandlers, submitPayout } from "../../src/payout/handlers.ts";
import { fakeProvider } from "../../src/payout/fake-provider.ts";
import type { PayoutProvider } from "../../src/payout/provider.ts";
import { computeWithholding } from "../../src/payout/policy.ts";
import { postEntry } from "../../src/ledger/journal.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
const jobs = recordingJobs();
let cur: Clock = fixedClock("2026-03-10T00:00:00.000Z", 1);
const clock: Clock = { now: () => cur.now() };
const base = fakeProvider();
let failNextSubmit = false;
const provider: PayoutProvider = {
  async submit(i, key) {
    if (failNextSubmit) { failNextSubmit = false; throw new Error("transient PSP outage"); }
    return base.submit(i, key);
  },
  status: (ref, key) => base.status(ref, key),
};
const SECRET = "s3cret";
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs, provider, pspSecret: SECRET });
const noSecretApp = buildServer({ db: w.db, ctx: w.ctx, clock, jobs, provider });
after(async () => { await app.close(); await noSecretApp.close(); await w.drop(); });

const req = (method: "GET" | "POST" | "PUT", url: string, actor: string | undefined, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(actor !== undefined && { "x-actor": actor }), ...headers }, ...(payload !== undefined && { payload: payload as object }) });
const settleDeps = () => ({ db: w.db, ctx: w.ctx, clock, jobs });
const payDeps = () => ({ db: w.db, clock, jobs, provider });
const drainSettle = () => jobs.drain(jobHandlers(settleDeps()));
const PARTIES = ["pty_member_a", "pty_member_b", "pty_label", "pty_agency", "pty_cmo", "pty_author_b", "pty_author_c"];

await issueCombo(w, "vc_1");
await purchase(w, "ev_c", "vc_1", "1000000");
await purchase(w, "ev_f", "vc_1", "100000", "2026-03-02T00:00:00.000Z", "FLAGGED");

test("confirm -> hold suggestion and release -> profiles over HTTP", async () => {
  const b = await req("POST", "/batches", "usr_ops", { batchId: "bat_l", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
  assert.equal(b.statusCode, 201, b.body);
  await drainSettle();
  assert.equal((await req("POST", "/batches/bat_l/confirm", "usr_settle", {})).statusCode, 200);
  await drainSettle();
  const hold = (await w.db.pool.query("SELECT holding_id::text AS id FROM unallocated_holding WHERE event_id = 'ev_f' AND line_seq = 1")).rows[0].id as string;

  assert.equal((await req("GET", `/holds/${hold}/suggestion`, undefined)).statusCode, 401);
  assert.equal((await req("GET", `/holds/${hold}/suggestion`, "usr_ops")).statusCode, 403);
  const s = await req("GET", `/holds/${hold}/suggestion`, "usr_settle");
  assert.equal(s.statusCode, 200, s.body);
  const allocation = s.json().allocation;
  assert.equal((await req("POST", `/holds/${hold}/release`, "usr_ops", { allocation })).statusCode, 403);
  assert.equal((await req("POST", `/holds/${hold}/release`, "usr_settle", {})).statusCode, 400);
  const rel = await req("POST", `/holds/${hold}/release`, "usr_settle", { allocation });
  assert.equal(rel.statusCode, 200, rel.body);
  assert.equal((await req("POST", `/holds/${hold}/release`, "usr_settle", { allocation })).statusCode, 409);

  cur = fixedClock("2026-04-10T00:00:00.000Z", 1);
  const body = (taxType: string) => ({ taxType, payoutAccountRef: "tok", kycVerified: true });
  assert.equal((await req("PUT", "/parties/pty_member_a/payout-profile", "usr_ops", body("DOMESTIC_INDIVIDUAL"))).statusCode, 403);
  assert.equal((await req("PUT", "/parties/pty_member_a/payout-profile", "usr_settle", { taxType: "NOPE", kycVerified: true })).statusCode, 422);
  for (const p of PARTIES) {
    const r = await req("PUT", `/parties/${p}/payout-profile`, "usr_settle", { ...body(p.startsWith("pty_member") ? "DOMESTIC_INDIVIDUAL" : "EXEMPT"), payoutAccountRef: `tok_${p}` });
    assert.equal(r.statusCode, 200, r.body);
  }
});

test("payout run -> webhook (secret, duplicate) -> results", async () => {
  cur = fixedClock("2026-06-01T00:00:00.000Z", 1);
  assert.equal((await req("POST", "/payout-runs", "usr_ops", { payoutRunId: "po-1", asOf: "2026-06-01T00:00:00.000Z" })).statusCode, 403);
  assert.equal((await req("POST", "/payout-runs", "usr_settle", { payoutRunId: 5 })).statusCode, 400);
  const run = await req("POST", "/payout-runs", "usr_settle", { payoutRunId: "po-1", asOf: "2026-06-01T00:00:00.000Z" });
  assert.equal(run.statusCode, 201, run.body);
  const pending = run.json().instructions.filter((i: any) => i.status === "PENDING");
  assert.ok(pending.length > 0);
  // 접수까지만 진행(submit-payout만 처리)한 뒤 webhook으로 결과를 보낸다.
  await jobs.drain({ "submit-payout": payoutJobHandlers(payDeps())["submit-payout"]! });
  const target = pending[0].instructionId as string;
  const hook = base.webhook(`payout:${target}`);
  const send = (headers: Record<string, string>, a = app) => a.inject({ method: "POST", url: "/psp/webhook", headers, payload: hook });
  assert.equal((await send({}, noSecretApp)).statusCode, 503);
  assert.equal((await send({ "x-psp-secret": SECRET }, noSecretApp)).statusCode, 503);
  assert.equal((await send({})).statusCode, 401);
  assert.equal((await send({ "x-psp-secret": "wrong" })).statusCode, 401);
  const bad = await app.inject({ method: "POST", url: "/psp/webhook", headers: { "x-psp-secret": SECRET }, payload: { providerEventId: "e" } });
  assert.equal(bad.statusCode, 400);
  const first = await send({ "x-psp-secret": SECRET });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal((await send({ "x-psp-secret": SECRET })).statusCode, 200);
  await jobs.drain(payoutJobHandlers(payDeps()));
  const rows = (await w.db.pool.query("SELECT status FROM payout_instruction WHERE instruction_id = $1", [target])).rows;
  assert.equal(rows[0].status, hook.status);
});

test("resubmit a stuck payout with the same idempotency key: PAID exactly once", async () => {
  cur = fixedClock("2026-06-02T00:00:00.000Z", 1);
  const plain = (n: bigint) => n % 97n !== 0n && n % 89n !== 0n;
  let g = 200_000n;
  while (!plain(g - computeWithholding(g, 330))) g++;
  await w.db.tx((tx) => postEntry(tx, clock, { kind: "ADJUSTMENT", sourceRef: "adj:resubmit", createdBy: "usr_settle",
    postings: [{ account: { kind: "RECEIVABLE" }, amount: g }, { account: { kind: "PARTY_PAYABLE", partyId: "pty_member_a" }, amount: -g }] }));
  cur = fixedClock("2026-06-03T00:00:00.000Z", 1);
  const run = await req("POST", "/payout-runs", "usr_settle", { payoutRunId: "po-2", asOf: "2026-06-03T00:00:00.000Z" });
  assert.equal(run.statusCode, 201, run.body);
  const id = "po_po-2_pty_member_a";
  assert.equal(run.json().instructions.find((i: any) => i.instructionId === id)?.status, "PENDING");
  // 전송 표식을 남기고 provider가 일시 장애로 예외 → 지시는 PENDING으로 멈춘다.
  failNextSubmit = true;
  await assert.rejects(submitPayout(payDeps(), { instructionId: id }), /transient/);
  const status = async () => (await w.db.pool.query("SELECT status FROM payout_instruction WHERE instruction_id = $1", [id])).rows[0].status;
  assert.equal(await status(), "PENDING");

  assert.equal((await req("POST", `/payouts/${id}/resubmit`, "usr_ops", {})).statusCode, 403);
  assert.equal((await req("POST", `/payouts/${id}/resubmit`, undefined, {})).statusCode, 401);
  assert.equal((await req("POST", "/payouts/po_nope/resubmit", "usr_settle", {})).statusCode, 404);
  const r = await req("POST", `/payouts/${id}/resubmit`, "usr_settle", {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, "SUBMITTED");
  await jobs.drain(payoutJobHandlers(payDeps()));
  assert.equal(await status(), "PAID");
  const n = (await w.db.pool.query("SELECT count(*)::int AS n FROM journal_entry WHERE kind = 'PAYOUT_SETTLED' AND source_ref = $1", [`settled:${id}`])).rows[0].n;
  assert.equal(n, 1);
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action_name = 'PAYOUT_RESUBMITTED' AND entity_id = $1", [id])).rows[0].n, 1);
  // 끝난 지시와 한 번도 보내지 않은 지시는 재전송할 수 없다.
  assert.equal((await req("POST", `/payouts/${id}/resubmit`, "usr_settle", {})).json().code, "NOT_RESUBMITTABLE");
  const held = (await w.db.pool.query("SELECT instruction_id FROM payout_instruction WHERE submit_attempted_at IS NULL LIMIT 1")).rows[0];
  if (held !== undefined) assert.equal((await req("POST", `/payouts/${held.instruction_id}/resubmit`, "usr_settle", {})).statusCode, 409);
});

test("statements, trial balance and invariants over HTTP", async () => {
  const q = "?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z";
  assert.equal((await req("GET", `/parties/pty_member_a/statements${q}`, "usr_ops")).statusCode, 403);
  assert.equal((await req("GET", `/parties/pty_member_a/statements${q}`, undefined)).statusCode, 401);
  assert.equal((await req("GET", "/parties/pty_member_a/statements", "usr_settle")).statusCode, 400);
  assert.equal((await req("GET", `/parties/nope/statements${q}`, "usr_settle")).statusCode, 404);
  const st = await req("GET", `/parties/pty_member_a/statements${q}`, "usr_settle");
  assert.equal(st.statusCode, 200, st.body);
  assert.ok(BigInt(st.json().settled) > 0n);
  assert.equal(st.json().closing, "0");

  assert.equal((await req("GET", "/ledger/trial-balance", "usr_ops")).statusCode, 403);
  const tb = await req("GET", "/ledger/trial-balance", "usr_settle");
  assert.equal(tb.statusCode, 200);
  assert.equal(tb.json().sum, "0");
  assert.ok(tb.json().accounts.length > 0);

  assert.equal((await req("GET", "/settlement/invariants", "usr_ops")).statusCode, 403);
  assert.equal((await req("GET", "/settlement/invariants", undefined)).statusCode, 401);
  const inv = await req("GET", "/settlement/invariants", "usr_settle");
  assert.equal(inv.statusCode, 200, inv.body);
  assert.equal(inv.json().ledger.entriesUnbalanced, 0);
  assert.deepEqual(inv.json().unreflectedRefunds, []);
});

test("operator run and quarantine routes: 401/403/404", async () => {
  for (const [method, url, body] of [["POST", "/runs/nope/void", { reason: "x" }], ["POST", "/runs/nope/requeue", {}], ["POST", "/quarantine/nope/release", {}]] as const) {
    assert.equal((await req(method, url, undefined, body)).statusCode, 401, url);
    assert.equal((await req(method, url, "usr_ops", body)).statusCode, 403, url);
    assert.equal((await req(method, url, "usr_settle", body)).statusCode, 404, url);
  }
  assert.equal((await req("POST", "/runs/nope/void", "usr_settle", {})).statusCode, 400);
});
