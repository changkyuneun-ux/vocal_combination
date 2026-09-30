import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ensureSystemIdentities } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const seal = await issueCombo(w, "vc_1");
const D1 = seal.projectionDigest;
const D2 = seal.membersDigest;
const q = (sql: string, params: unknown[] = []) => w.db.pool.query(sql, params);
const rc001 = (e: { code?: string }) => e.code === "RC001";
const AT = "2026-04-01T00:00:00.000Z";

let n = 0;
/** 배치 1개 + PENDING run 1개(+ 선택적 이벤트 1개)를 SQL로 직접 만든다. */
async function newRun(withEvent = false): Promise<{ batchId: string; runId: string; eventId: string }> {
  n += 1;
  const batchId = `bat_${n}`, runId = `run_${n}`, eventId = `ev_${n}`;
  await q("INSERT INTO settlement_batch (batch_id, period_start, period_end, executed_by, created_at) VALUES ($1,$2,$3,'usr_settle',$4)",
    [batchId, "2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z", AT]);
  await q("INSERT INTO settlement_run (run_id, batch_id, snapshot_id, created_at) VALUES ($1,$2,$3,$4)", [runId, batchId, seal.snapshotId, AT]);
  if (withEvent) {
    await purchase(w, eventId, "vc_1", "1000");
    await q("INSERT INTO settlement_run_event (run_id, event_id, net_amount_krw, refunds_included_krw) VALUES ($1,$2,1000,0)", [runId, eventId]);
  }
  return { batchId, runId, eventId };
}
const setStatus = (runId: string, status: string) => q("UPDATE settlement_run SET status = $2 WHERE run_id = $1", [runId, status]);
const calculate = (runId: string) => q("UPDATE settlement_run SET status = 'CALCULATED', events_digest = $2, result_digest = $3 WHERE run_id = $1", [runId, D1, D2]);
const verify = (runId: string) => q("UPDATE settlement_run SET status = 'VERIFIED', verified_by = 'sys_verifier', verified_at = $2 WHERE run_id = $1", [runId, AT]);

test("run: PENDING → CALCULATED → VERIFIED → CONFIRMED is allowed; CONFIRMED is terminal", async () => {
  const { runId } = await newRun();
  await calculate(runId);
  await verify(runId);
  await setStatus(runId, "CONFIRMED");
  await assert.rejects(setStatus(runId, "PENDING"), rc001);
  await assert.rejects(setStatus(runId, "VOIDED"), rc001);
});

test("run: skipping states and leaving FAILED/VOIDED are rejected", async () => {
  const a = await newRun();
  await assert.rejects(q("UPDATE settlement_run SET status = 'VERIFIED', events_digest = $2, result_digest = $2, verified_by = 'sys_verifier', verified_at = $3 WHERE run_id = $1", [a.runId, D1, AT]), rc001);
  await q("UPDATE settlement_run SET status = 'FAILED', diagnostics = '[{\"code\":\"X\"}]' WHERE run_id = $1", [a.runId]);
  await assert.rejects(setStatus(a.runId, "VOIDED"), rc001);
  await assert.rejects(setStatus(a.runId, "PENDING"), rc001);
  const b = await newRun();
  await calculate(b.runId);
  await assert.rejects(setStatus(b.runId, "FAILED"), rc001);
  await assert.rejects(setStatus(b.runId, "CONFIRMED"), rc001);
  await q("UPDATE settlement_run SET status = 'VOIDED', diagnostics = '[]' WHERE run_id = $1", [b.runId]);
  await assert.rejects(setStatus(b.runId, "CALCULATED"), rc001);
});

test("run: digests and verifier are write-once; diagnostics only with FAILED/VOIDED", async () => {
  const { runId } = await newRun();
  await calculate(runId);
  await assert.rejects(q("UPDATE settlement_run SET result_digest = $2 WHERE run_id = $1", [runId, D1]), rc001);
  await assert.rejects(q("UPDATE settlement_run SET events_digest = NULL WHERE run_id = $1", [runId]), rc001);
  await assert.rejects(q("UPDATE settlement_run SET diagnostics = '[]' WHERE run_id = $1", [runId]), rc001);
  await verify(runId);
  await assert.rejects(q("UPDATE settlement_run SET verified_at = $2 WHERE run_id = $1", [runId, "2026-04-02T00:00:00.000Z"]), rc001);
  await assert.rejects(q("UPDATE settlement_run SET verified_by = 'usr_settle' WHERE run_id = $1", [runId]), rc001);
  await assert.rejects(q("UPDATE settlement_run SET status = 'CONFIRMED', diagnostics = '[]' WHERE run_id = $1", [runId]), rc001);
});

test("run: VERIFIED requires verified_at (CHECK)", async () => {
  const { runId } = await newRun();
  await calculate(runId);
  await assert.rejects(q("UPDATE settlement_run SET status = 'VERIFIED', verified_by = 'sys_verifier' WHERE run_id = $1", [runId]), (e: { code?: string }) => e.code === "23514");
});

test("run_event: released only true → false and only after the run is FAILED/VOIDED", async () => {
  const { runId, eventId } = await newRun(true);
  const release = () => q("UPDATE settlement_run_event SET active = false WHERE run_id = $1 AND event_id = $2", [runId, eventId]);
  await assert.rejects(release(), rc001);
  await calculate(runId);
  await verify(runId);
  await assert.rejects(release(), rc001, "VERIFIED run keeps its events");
  await setStatus(runId, "VOIDED");
  await release();
  await assert.rejects(q("UPDATE settlement_run_event SET active = true WHERE run_id = $1 AND event_id = $2", [runId, eventId]), rc001);
  // 풀린 이벤트는 새 run에 다시 묶일 수 있다.
  const next = await newRun();
  await q("INSERT INTO settlement_run_event (run_id, event_id, net_amount_krw, refunds_included_krw) VALUES ($1,$2,1000,0)", [next.runId, eventId]);
});

test("batch: OPEN → CONFIRMED once; confirmation fields are write-once", async () => {
  const { batchId } = await newRun();
  const confirm = () => q("UPDATE settlement_batch SET status = 'CONFIRMED', confirmed_by = 'usr_ops', confirmed_at = $2, batch_manifest_digest = $3 WHERE batch_id = $1", [batchId, AT, D1]);
  await confirm();
  await assert.rejects(confirm(), rc001, "re-confirming rewrites nothing but is still a CONFIRMED → CONFIRMED update");
  await assert.rejects(q("UPDATE settlement_batch SET status = 'OPEN' WHERE batch_id = $1", [batchId]), rc001);
  await assert.rejects(q("UPDATE settlement_batch SET batch_manifest_digest = $2 WHERE batch_id = $1", [batchId, D2]), rc001);
  await assert.rejects(q("UPDATE settlement_batch SET confirmed_at = $2 WHERE batch_id = $1", [batchId, "2026-04-02T00:00:00.000Z"]), rc001);
});

test("ensureSystemIdentities is idempotent", async () => {
  const clock = fixedClock("2026-05-01T00:00:00.000Z", 1);
  await w.db.tx((tx) => ensureSystemIdentities(tx, clock));
  await w.db.tx((tx) => ensureSystemIdentities(tx, clock));
  const ids = ["sys_ingest", "sys_settler", "sys_verifier"];
  const roles = (await q("SELECT user_id, role FROM portal_role WHERE user_id = ANY($1) ORDER BY user_id", [ids])).rows;
  assert.deepEqual(roles, ids.map((user_id) => ({ user_id, role: "SYSTEM" })));
  const keys = (await q("SELECT COUNT(*)::int AS n FROM dev_signing_key WHERE user_id = ANY($1)", [ids])).rows[0].n;
  assert.equal(keys, 3);
});
