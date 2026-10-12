import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { batchView, createBatch, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { releaseQuarantine } from "../../src/settlement/quarantine.ts";
import { ingestRevenue, noRefundHook, noRevisionHook } from "../../src/revenue/service.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const P = { periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" };
const q = (sql: string, params: unknown[] = []) => w.db.pool.query(sql, params);

await issueCombo(w, "vc_1");
await issueCombo(w, "vc_2", "b", "a");
// 정책 범위(events: [PRIMARY]) 밖의 RESALE → vc_1의 run은 엔진 진단 ALLOC_SCOPE_MISMATCH로 FAILED.
await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
  eventId: "ev_r", sourceSystem: "app", sourceEventId: "ev_r", eventType: "RESALE", vcId: "vc_1", amountKrw: "4000", currency: "KRW", occurredAt: "2026-03-05T00:00:00.000Z",
}, noRefundHook, noRevisionHook));
await purchase(w, "ev_ok", "vc_2", "5000");

const quarantines = async () => (await q(
  "SELECT snapshot_id, reason, diagnostics, released_by, released_at FROM quarantine ORDER BY quarantine_id",
)).rows;

test("an engine-failed run quarantines its issue seal in the same transaction", async () => {
  const b = await createBatch(d, w.users.ops, { batchId: "bat_1", ...P });
  assert.equal(b.runs.length, 2);
  await jobs.drain(jobHandlers(d));
  const runs = (await q("SELECT snapshot_id, status FROM settlement_run WHERE batch_id = 'bat_1' ORDER BY snapshot_id")).rows;
  assert.deepEqual(runs.map((r) => [r.snapshot_id, r.status]), [["snp_vc_1", "FAILED"], ["snp_vc_2", "VERIFIED"]]);
  const qs = await quarantines();
  assert.equal(qs.length, 1);
  assert.equal(qs[0].snapshot_id, "snp_vc_1");
  assert.ok(qs[0].reason.includes("run_bat_1_snp_vc_1"), qs[0].reason);
  assert.ok(JSON.stringify(qs[0].diagnostics).includes("ALLOC_SCOPE_MISMATCH"));
  assert.equal(qs[0].released_by, null);
  assert.equal(qs[0].released_at, null);
});

test("the next batch skips events of a quarantined seal as ENGINE_FAILED", async () => {
  await purchase(w, "ev_p2", "vc_1", "7000", "2026-03-06T00:00:00.000Z");
  const b = await createBatch(d, w.users.ops, { batchId: "bat_2", ...P });
  assert.deepEqual(b.runs, []);
  assert.deepEqual(b.skipped, [{ eventId: "ev_p2", reason: "ENGINE_FAILED" }, { eventId: "ev_r", reason: "ENGINE_FAILED" }]);
  const v = await w.db.tx((tx) => batchView(tx, "bat_2"));
  assert.deepEqual(v.skipped.map((s) => s.reason), ["ENGINE_FAILED", "ENGINE_FAILED"]);
});

test("only SPACE_SETTLE may release; unknown or already released quarantines are refused", async () => {
  await assert.rejects(releaseQuarantine(d, w.users.ops, "snp_vc_1"), { code: "ROLE_REQUIRED", status: 403 });
  await assert.rejects(releaseQuarantine(d, w.users.settle, "snp_vc_2"), { status: 404 });
  const r = await releaseQuarantine(d, w.users.settle, "snp_vc_1");
  assert.equal(r.snapshotId, "snp_vc_1");
  assert.equal(r.releasedBy, "usr_settle");
  const qs = await quarantines();
  assert.equal(qs[0].released_by, "usr_settle");
  assert.ok(qs[0].released_at instanceof Date);
  const audit = await q("SELECT actor_user_id FROM audit_log WHERE action_name = 'QUARANTINE_RELEASED' AND entity_id = 'snp_vc_1'");
  assert.deepEqual(audit.rows.map((x) => x.actor_user_id), ["usr_settle"]);
  await assert.rejects(releaseQuarantine(d, w.users.settle, "snp_vc_1"), { code: "NOT_QUARANTINED", status: 409 });
});

test("after release the seal's events are candidates again; failing again quarantines again", async () => {
  const b = await createBatch(d, w.users.ops, { batchId: "bat_3", ...P });
  assert.deepEqual(b.runs, ["run_bat_3_snp_vc_1"]);
  assert.deepEqual(b.skipped, []);
  await jobs.drain(jobHandlers(d));
  const run = (await q("SELECT status FROM settlement_run WHERE run_id = 'run_bat_3_snp_vc_1'")).rows[0];
  assert.equal(run.status, "FAILED");
  const qs = await quarantines();
  assert.equal(qs.length, 2);
  assert.deepEqual(qs.map((x) => [x.snapshot_id, x.released_by]), [["snp_vc_1", "usr_settle"], ["snp_vc_1", null]]);
  assert.ok(qs[1].reason.includes("run_bat_3_snp_vc_1"));
  const b4 = await createBatch(d, w.users.ops, { batchId: "bat_4", ...P });
  assert.deepEqual(b4.skipped.map((s) => s.reason), ["ENGINE_FAILED", "ENGINE_FAILED"]);
});

test("quarantine rows: only released_by/released_at change, once; no delete", async () => {
  const rc001OrDenied = (e: { code?: string }) => e.code === "RC001" || e.code === "42501";
  await assert.rejects(q("UPDATE quarantine SET released_by = 'usr_ops', released_at = date_trunc('milliseconds', now()) WHERE released_by IS NOT NULL"), rc001OrDenied);
  await assert.rejects(q("UPDATE quarantine SET reason = 'x'"), rc001OrDenied);
  await assert.rejects(q("DELETE FROM quarantine"), rc001OrDenied);
  await assert.rejects(q("UPDATE quarantine SET released_by = 'usr_settle' WHERE released_by IS NULL"), (e: { code?: string }) => e.code === "RC001" || e.code === "23514",
    "released_by and released_at are set together");
});
