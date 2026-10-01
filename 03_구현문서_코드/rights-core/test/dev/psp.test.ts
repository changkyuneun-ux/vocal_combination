import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadDevClock } from "../../src/dev/clock.ts";
import { createDevPsp } from "../../src/dev/psp.ts";
import { buildServer } from "../../src/http/server.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { confirmBatch, createBatch } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { setPayoutProfile } from "../../src/payout/service.ts";
import { payoutJobHandlers, submitPayout } from "../../src/payout/handlers.ts";
import { balance, postEntry } from "../../src/ledger/journal.ts";
import { migrate } from "../../src/platform/migrate.ts";
import { MIGRATIONS_DEV_DIR } from "../../src/dev/setup-db.ts";
import pg from "pg";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
{
  const c = new pg.Client({ connectionString: w.adminUrl });
  await c.connect();
  try { await migrate(c, MIGRATIONS_DEV_DIR); } finally { await c.end(); }
}
// 실제 시간이 흐르지 않는 가상 시계(realNow 고정): set으로 시각을 옮긴다.
const REAL = Date.parse("2026-12-31T00:00:00.000Z");
const clock = await loadDevClock(w.db, () => REAL);
await w.db.tx((tx) => clock.resetTo(tx, "2026-01-01T00:00:00.000Z")); // 마이그레이션 시각 기준을 고정한다
const at = (iso: string) => w.db.tx((tx) => clock.set(tx, iso));
const psp = createDevPsp(clock);
const jobs = recordingJobs();
const SECRET = "dev-secret";
const dev = { clock, psp, jobs: { pause: async () => {}, resume: async () => {}, paused: () => [] }, adminUrl: w.adminUrl, blobDir: "/tmp/rc-dev-psp-test-blobs" };
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs, provider: psp.provider, pspSecret: SECRET, dev });
after(async () => { await app.close(); await w.drop(); });

const payDeps = () => ({ db: w.db, clock, jobs, provider: psp.provider });
const req = (method: "GET" | "POST" | "PUT", url: string, actor?: string, payload?: unknown) =>
  app.inject({ method, url, headers: actor === undefined ? {} : { "x-actor": actor }, ...(payload !== undefined && { payload: payload as object }) });
const status = async (id: string) => (await w.db.pool.query("SELECT status FROM payout_instruction WHERE instruction_id = $1", [id])).rows[0].status as string;
const payable = (partyId: string, gross: bigint, ref: string) => w.db.tx((tx) => postEntry(tx, clock, { kind: "ADJUSTMENT", sourceRef: ref, createdBy: "usr_settle",
  postings: [{ account: { kind: "RECEIVABLE" }, amount: gross }, { account: { kind: "PARTY_PAYABLE", partyId }, amount: -gross }] }));

await issueCombo(w, "vc_1");
await purchase(w, "ev_c", "vc_1", "1000000");
await at("2026-03-10T00:00:00.000Z");
const sd = { db: w.db, ctx: w.ctx, clock, jobs };
await createBatch(sd, w.users.ops, { batchId: "bat_mar", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
await jobs.drain(jobHandlers(sd));
await confirmBatch(sd, w.users.settle, "bat_mar");
await jobs.drain(jobHandlers(sd));
await at("2026-04-10T00:00:00.000Z");
for (const p of ["pty_member_a", "pty_member_b", "pty_label", "pty_agency", "pty_cmo", "pty_author_b", "pty_author_c"]) {
  await w.db.tx((tx) => setPayoutProfile(tx, clock, w.users.settle2, { partyId: p, taxType: p.startsWith("pty_member") ? "DOMESTIC_INDIVIDUAL" : "EXEMPT", payoutAccountRef: `tok_${p}`, kycVerified: true }));
}

test("per-instruction outcomes: FAILED, UNKNOWN (re-query pending) and default; requests are logged", async () => {
  await at("2026-06-01T00:00:00.000Z");
  const [a, b, l] = ["pty_member_a", "pty_member_b", "pty_label"].map((p) => `po_po-1_${p}`) as [string, string, string];
  assert.equal((await req("PUT", `/dev/psp/outcomes/${l}`, undefined, { outcome: "FAILED" })).statusCode, 200);
  assert.equal((await req("PUT", `/dev/psp/outcomes/${b}`, undefined, { outcome: "UNKNOWN" })).statusCode, 200);
  assert.equal((await req("PUT", `/dev/psp/outcomes/${a}`, undefined, { outcome: "NOPE" })).statusCode, 400);
  assert.equal((await req("PUT", `/dev/psp/outcomes/party/pty_cmo`, undefined, { outcome: "BOGUS" })).statusCode, 400);
  assert.deepEqual((await req("GET", "/dev/psp/outcomes")).json(), { byInstruction: { [l]: "FAILED", [b]: "UNKNOWN" }, byParty: {} });
  const run = await req("POST", "/payout-runs", "usr_settle", { payoutRunId: "po-1", asOf: "2026-06-01T00:00:00.000Z" });
  assert.equal(run.statusCode, 201, run.body);
  const ids = run.json().instructions.map((i: any) => i.instructionId as string);
  assert.ok([a, b, l].every((i) => ids.includes(i)), ids.join(","));
  // 세 지시만 보낸다(나머지는 PENDING으로 남겨 전송 전 webhook을 시험한다).
  for (const i of [a, b, l]) await submitPayout(payDeps(), { instructionId: i });
  assert.equal(await status(l), "FAILED");
  // UNKNOWN: 접수 여부 불명이라 PENDING에 머물고 submit_unknown_at이 찍힌다(poll-payout이 멱등 키로 재조회한다).
  assert.equal(await status(b), "PENDING");
  assert.equal((await w.db.pool.query("SELECT submit_unknown_at IS NOT NULL AS u FROM payout_instruction WHERE instruction_id = $1", [b])).rows[0].u, true);
  assert.equal(await status(a), "SUBMITTED");
  const items = (await req("GET", "/dev/psp/requests")).json().items as { op: string; instructionId: string; result: string; at: string }[];
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((x) => x.instructionId), [l, b, a], "most recent first");
  assert.deepEqual(items.map((x) => x.result), ["FAILED", "UNKNOWN", "ACCEPTED"]);
  assert.ok(items.every((x) => x.op === "submit" && x.at === "2026-06-01T00:00:00.000Z"));
});

test("webhook repeat: first is stored, the repeat is a duplicate; unsent instruction is 409 NOT_SUBMITTED", async () => {
  const a = "po_po-1_pty_member_a";
  // pty_agency 지시는 아직 PSP에 보내지 않았다(드레인 전).
  const notSent = await req("POST", "/dev/psp/webhook", undefined, { instructionId: "po_po-1_pty_agency" });
  assert.equal(notSent.statusCode, 409);
  assert.equal(notSent.json().code, "NOT_SUBMITTED");
  const r = await req("POST", "/dev/psp/webhook", undefined, { instructionId: a, repeat: 2 });
  assert.equal(r.statusCode, 200, r.body);
  const { responses } = r.json() as { responses: { statusCode: number; body: { created: boolean } }[] };
  assert.deepEqual(responses.map((x) => [x.statusCode, x.body.created]), [[201, true], [200, false]]);
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM psp_webhook_inbox")).rows[0].n, 1);
  await jobs.drain(payoutJobHandlers(payDeps()));
  assert.equal(await status(a), "PAID");

  assert.equal((await req("POST", "/dev/psp/webhook", undefined, { instructionId: "po_po-1_pty_label", repeat: 6 })).statusCode, 400);
  assert.equal((await req("POST", "/dev/psp/webhook", undefined, { instructionId: "po_po-1_pty_label", repeat: 0 })).statusCode, 400);
  assert.equal((await req("POST", "/dev/psp/webhook", undefined, {})).statusCode, 400);
});

test("party outcome applies to later instructions; an instruction outcome wins over the party outcome", async () => {
  await at("2026-06-05T00:00:00.000Z");
  await payable("pty_cmo", 500_000n, "adj:ps-1");
  await payable("pty_agency", 500_000n, "adj:ps-2");
  await at("2026-06-05T12:00:00.000Z");
  assert.equal((await req("PUT", "/dev/psp/outcomes/party/pty_cmo", undefined, { outcome: "FAILED" })).statusCode, 200);
  assert.equal((await req("PUT", "/dev/psp/outcomes/party/pty_agency", undefined, { outcome: "FAILED" })).statusCode, 200);
  assert.equal((await req("PUT", "/dev/psp/outcomes/po_po-2_pty_agency", undefined, { outcome: "PAID" })).statusCode, 200);
  const run = await req("POST", "/payout-runs", "usr_settle", { payoutRunId: "po-2", asOf: "2026-06-05T12:00:00.000Z" });
  assert.equal(run.statusCode, 201, run.body);
  for (const p of ["pty_cmo", "pty_agency"]) await submitPayout(payDeps(), { instructionId: `po_po-2_${p}` });
  assert.equal(await status("po_po-2_pty_cmo"), "FAILED");
  assert.equal(await status("po_po-2_pty_agency"), "SUBMITTED");
  assert.deepEqual(psp.outcomes().byParty, { pty_cmo: "FAILED", pty_agency: "FAILED" });
});

test("webhook status FAILED on a SUBMITTED (outcome PAID) instruction restores the balance; poll-payout agrees", async () => {
  const id = "po_po-2_pty_agency";
  assert.equal(await status(id), "SUBMITTED");
  const payableOf = async () => (await w.db.tx((tx) => balance(tx, { kind: "PARTY_PAYABLE", partyId: "pty_agency" }))).toString();
  const before = await payableOf();
  assert.equal((await req("POST", "/dev/psp/webhook", undefined, { instructionId: id, status: "BOGUS" })).statusCode, 400);
  const r = await req("POST", "/dev/psp/webhook", undefined, { instructionId: id, status: "FAILED" });
  assert.equal(r.statusCode, 200, r.body);
  await jobs.drain(payoutJobHandlers(payDeps()));
  assert.equal(await status(id), "FAILED");
  const kinds = (await w.db.pool.query("SELECT kind FROM journal_entry WHERE kind = 'PAYOUT_FAILED' AND source_ref LIKE $1", [`%${id}%`])).rows;
  assert.equal(kinds.length, 1);
  assert.notEqual(await payableOf(), before);
  assert.equal(await payableOf(), "-500000", "gross restored to the payable");
  assert.equal((await psp.provider.status("", `payout:${id}`)).status, "FAILED", "later status() agrees with the webhook");
});

test("reset clears outcomes and requests", () => {
  psp.reset();
  assert.deepEqual(psp.outcomes(), { byInstruction: {}, byParty: {} });
  assert.deepEqual(psp.requests(), []);
  assert.throws(() => psp.webhookFor("po_po-1_pty_member_a"), { code: "NOT_SUBMITTED" });
});
