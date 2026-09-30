import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { batchView, confirmBatch, createBatch, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers, settleRun, verifyRunJob } from "../../src/settlement/handlers.ts";
import { evaluateRun } from "../../src/engine-bridge/settle.ts";
import { verifyAttestations } from "../../src/engine-bridge/attest.ts";
import pg from "pg";
import { openDispute, closeDispute } from "../../src/registry/disputes.ts";
import { ingestRevenue } from "../../src/revenue/service.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const P = { periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" };

await issueCombo(w, "vc_1");
await issueCombo(w, "vc_2", "b", "a");
// 분쟁 종결 뒤에는 재고정 없이 발행할 수 없으므로 뒤 테스트의 조합도 여기서 발행한다.
await issueCombo(w, "vc_3");
await issueCombo(w, "vc_4");
await purchase(w, "ev_1a", "vc_1", "10000");
await purchase(w, "ev_1b", "vc_1", "1001");
await purchase(w, "ev_2a", "vc_2", "5000");
await purchase(w, "ev_nos", "vc_missing", "700");
await purchase(w, "ev_late", "vc_1", "300", "2026-04-02T00:00:00.000Z");

test("createBatch groups events by issue seal, skips unissued ones and enqueues settle jobs", async () => {
  const b = await createBatch(d, w.users.ops, { batchId: "bat_1", ...P });
  assert.equal(b.runs.length, 2);
  assert.deepEqual(b.skipped, [{ eventId: "ev_nos", reason: "NO_ISSUE_SEAL" }]);
  assert.deepEqual(jobs.sent.map((j) => j.name), ["settle-run", "settle-run"]);
  const events = await w.db.pool.query("SELECT run_id, event_id, net_amount_krw::text AS net FROM settlement_run_event ORDER BY event_id");
  assert.deepEqual(events.rows.map((r) => [r.event_id, r.net]), [["ev_1a", "10000"], ["ev_1b", "1001"], ["ev_2a", "5000"]]);
  const dup = await createBatch(d, w.users.ops, { batchId: "bat_dup", ...P });
  assert.deepEqual(dup.runs, [], "events already in a live run are not re-batched");
});

test("settle and verify jobs run to VERIFIED with conserved lines and two distinct signers", async () => {
  await jobs.drain(jobHandlers(d));
  const v = await w.db.tx((tx) => batchView(tx, "bat_1"));
  assert.equal(v.progress, "READY");
  assert.ok(v.runs.every((r) => r.status === "VERIFIED"));
  const sums = await w.db.pool.query(
    `SELECT e.event_id, e.net_amount_krw::text AS net,
            (SELECT SUM(amount_krw) FROM pool_line p WHERE p.run_id = e.run_id AND p.event_id = e.event_id)::text AS pool
       FROM settlement_run_event e ORDER BY e.event_id`,
  );
  assert.ok(sums.rows.every((r) => r.net === r.pool), JSON.stringify(sums.rows));
  const signers = await w.db.pool.query(
    "SELECT DISTINCT a.signer_id, a.role FROM attestation a JOIN settlement_run r ON r.result_digest = a.digest ORDER BY 1",
  );
  assert.deepEqual(signers.rows.map((r) => [r.signer_id, r.role]), [["sys_settler", "SPACE_OPS"], ["sys_verifier", "PLATFORM"]]);
  const digests = (await w.db.pool.query("SELECT result_digest FROM settlement_run WHERE batch_id = 'bat_1'")).rows.map((r) => r.result_digest as string);
  for (const dg of digests) assert.ok(await w.db.tx((tx) => verifyAttestations(tx, dg)), `signatures over ${dg} verify`);
  const lines = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line WHERE run_id = $1", [v.runs[0]!.runId]);
  await settleRun(d, { runId: v.runs[0]!.runId });
  const again = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line WHERE run_id = $1", [v.runs[0]!.runId]);
  assert.equal(lines.rows[0].n, again.rows[0].n, "re-running a settled run writes nothing");
});

test("confirmBatch requires SPACE_SETTLE, a different person, and seals a signed manifest", async () => {
  await assert.rejects(confirmBatch(d, w.users.ops, "bat_1"), { code: "ROLE_REQUIRED" });
  const r = await confirmBatch(d, w.users.settle, "bat_1");
  const v = await w.db.tx((tx) => batchView(tx, "bat_1"));
  assert.equal(v.status, "CONFIRMED");
  assert.ok(v.runs.every((x) => x.status === "CONFIRMED"));
  const manifest = (await w.db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [r.manifestDigest])).rows[0].content;
  assert.equal(manifest.format, "rc-batch-manifest/1");
  assert.equal(manifest.results.length, 2);
  const s = await w.db.pool.query("SELECT signer_id, role FROM attestation WHERE digest = $1", [r.manifestDigest]);
  assert.deepEqual(s.rows.map((x) => [x.signer_id, x.role]), [["usr_settle", "SPACE_SETTLE"]]);
  await assert.rejects(confirmBatch(d, w.users.settle, "bat_1"), { code: "INVALID_STATE" });
});

test("an open dispute skips the scope's events; they are picked up after the dispute closes", async () => {
  await purchase(w, "ev_1c", "vc_1", "2000");
  await w.db.tx((tx) => openDispute(tx, w.clock, { disputeId: "dsp_b", targetType: "RIGHT_CLAIM", targetId: "c_master", reason: "t" }));
  const b2 = await createBatch(d, w.users.ops, { batchId: "bat_2", ...P });
  assert.deepEqual(b2.runs, []);
  assert.ok(b2.skipped.some((s) => s.eventId === "ev_1c" && s.reason === "FACTS_DISPUTE_OPEN"));
  await w.db.tx((tx) => closeDispute(tx, w.clock, { disputeId: "dsp_b" }));
  const b3 = await createBatch(d, w.users.ops, { batchId: "bat_3", ...P });
  assert.equal(b3.runs.length, 1);
});

test("an engine failure (event type outside the policy scope) marks the run FAILED and releases its events", async () => {
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "ev_3r", sourceSystem: "app", sourceEventId: "ev_3r", eventType: "RESALE", vcId: "vc_3", amountKrw: "4000", currency: "KRW", occurredAt: "2026-03-05T00:00:00.000Z",
  }));
  const b = await createBatch(d, w.users.ops, { batchId: "bat_4", ...P });
  assert.equal(b.runs.length, 1);
  await jobs.drain(jobHandlers(d));
  const run = (await w.db.pool.query("SELECT status, diagnostics FROM settlement_run WHERE run_id = $1", [b.runs[0]])).rows[0];
  assert.equal(run.status, "FAILED");
  assert.ok(JSON.stringify(run.diagnostics).includes("ALLOC_SCOPE_MISMATCH"));
  const active = await w.db.pool.query("SELECT active FROM settlement_run_event WHERE event_id = 'ev_3r'");
  assert.deepEqual(active.rows.map((r) => r.active), [false]);
  const v = await w.db.tx((tx) => batchView(tx, "bat_4"));
  assert.equal(v.progress, "EMPTY");
});

test("a verify mismatch (result digest swapped for another sealed result) voids the run and releases its events", async () => {
  const MAY = { periodStart: "2026-05-01T00:00:00.000Z", periodEnd: "2026-06-01T00:00:00.000Z" };
  await purchase(w, "ev_4a", "vc_4", "8000", "2026-05-02T00:00:00.000Z");
  const b = await createBatch(d, w.users.ops, { batchId: "bat_5", ...MAY });
  assert.equal(b.runs.length, 1);
  const runId = b.runs[0]!;
  await jobs.drain({ "settle-run": jobHandlers(d)["settle-run"]! });
  const run = (await w.db.pool.query("SELECT status, snapshot_id, result_digest FROM settlement_run WHERE run_id = $1", [runId])).rows[0];
  assert.equal(run.status, "CALCULATED");
  assert.ok(jobs.sent.some((j) => j.name === "verify-run" && j.data.runId === runId));
  const other = await w.db.tx((tx) => evaluateRun(w.ctx, tx, {
    runId, snapshotId: run.snapshot_id, events: [{ eventId: "ev_4a", type: "PRIMARY", amount: 7000n, integrity: "CLEAR" }],
  }));
  assert.ok(other.ok);
  assert.notEqual(other.resultDigest, run.result_digest);
  const admin = new pg.Client({ connectionString: w.adminUrl });
  await admin.connect();
  try {
    await admin.query("ALTER TABLE settlement_run DISABLE TRIGGER settlement_run_guard");
    await admin.query("UPDATE settlement_run SET result_digest = $2 WHERE run_id = $1", [runId, other.resultDigest]);
    await admin.query("ALTER TABLE settlement_run ENABLE TRIGGER settlement_run_guard");
  } finally {
    await admin.end();
  }
  await verifyRunJob(d, { runId });
  const after_ = (await w.db.pool.query("SELECT status, diagnostics, verified_by FROM settlement_run WHERE run_id = $1", [runId])).rows[0];
  assert.equal(after_.status, "VOIDED");
  assert.equal(after_.verified_by, null);
  assert.ok(Array.isArray(after_.diagnostics) && after_.diagnostics.length > 0);
  const active = await w.db.pool.query("SELECT active FROM settlement_run_event WHERE run_id = $1", [runId]);
  assert.deepEqual(active.rows.map((r) => r.active), [false]);
  const audit = await w.db.pool.query("SELECT actor_user_id AS actor FROM audit_log WHERE action_name = 'RUN_VERIFY_MISMATCH' AND entity_id = $1", [runId]);
  assert.deepEqual(audit.rows.map((r) => r.actor), ["sys_verifier"]);
  const v = await w.db.tx((tx) => batchView(tx, "bat_5"));
  assert.equal(v.progress, "EMPTY");
});
