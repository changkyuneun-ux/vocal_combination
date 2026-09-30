import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { confirmBatch, createBatch, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers, settleRun } from "../../src/settlement/handlers.ts";
import { requeueRun, voidRun } from "../../src/settlement/operator.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
await issueCombo(w, "vc_1");

const q = (sql: string, params: unknown[] = []) => w.db.pool.query(sql, params);
const status = async (runId: string) => (await q("SELECT status FROM settlement_run WHERE run_id = $1", [runId])).rows[0].status as string;
const activeEvents = async (runId: string) =>
  (await q("SELECT event_id FROM settlement_run_event WHERE run_id = $1 AND active ORDER BY event_id", [runId])).rows.map((r) => r.event_id as string);

let month = 0;
/** 달마다 독립된 배치: 그 달의 구매 두 건을 넣고 배치를 만든다(settle-run은 jobs에 쌓이기만 한다). */
async function batchOf(jobs = recordingJobs()): Promise<{ d: SettleDeps; jobs: ReturnType<typeof recordingJobs>; batchId: string; runId: string; period: { periodStart: string; periodEnd: string } }> {
  month += 1;
  const mm = String(month).padStart(2, "0");
  const next = String(month + 1).padStart(2, "0");
  const period = { periodStart: `2027-${mm}-01T00:00:00.000Z`, periodEnd: `2027-${next}-01T00:00:00.000Z` };
  await purchase(w, `ev_${mm}a`, "vc_1", "10000", `2027-${mm}-02T00:00:00.000Z`);
  await purchase(w, `ev_${mm}b`, "vc_1", "2000", `2027-${mm}-03T00:00:00.000Z`);
  const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
  const b = await createBatch(d, w.users.ops, { batchId: `bat_${mm}`, ...period });
  assert.equal(b.runs.length, 1);
  return { d, jobs, batchId: `bat_${mm}`, runId: b.runs[0]!, period };
}

test("voidRun and requeueRun require SPACE_SETTLE; unknown runs are 404", async () => {
  const { d, runId } = await batchOf();
  await assert.rejects(voidRun(d, w.users.ops, runId, "stuck"), { code: "ROLE_REQUIRED" });
  await assert.rejects(requeueRun(d, w.users.ops, runId), { code: "ROLE_REQUIRED" });
  await assert.rejects(voidRun(d, w.users.settle, "run_nope", "stuck"), { code: "NOT_FOUND" });
  await assert.rejects(requeueRun(d, w.users.settle, "run_nope"), { code: "NOT_FOUND" });
  await assert.rejects(voidRun(d, w.users.settle, runId, "  "), { code: "INVALID_REASON" });
  assert.equal(await status(runId), "PENDING");
});

test("voiding a PENDING run releases its events, which the next batch picks up again", async () => {
  const { d, jobs, batchId, runId, period } = await batchOf();
  const events = await activeEvents(runId);
  assert.equal(events.length, 2);
  const r = await voidRun(d, w.users.settle, runId, "operator found a stuck run");
  assert.deepEqual(r, { runId, from: "PENDING", status: "VOIDED", released: 2 });
  const row = (await q("SELECT status, diagnostics FROM settlement_run WHERE run_id = $1", [runId])).rows[0];
  assert.equal(row.status, "VOIDED");
  assert.deepEqual(row.diagnostics, [{ code: "OPERATOR_VOID", path: "$", message: "operator found a stuck run" }]);
  assert.deepEqual(await activeEvents(runId), []);
  const a = (await q("SELECT actor_user_id, after_json FROM audit_log WHERE action_name = 'RUN_VOIDED_BY_OPERATOR' AND entity_id = $1", [runId])).rows;
  assert.deepEqual(a, [{ actor_user_id: "usr_settle", after_json: { from: "PENDING", reason: "operator found a stuck run", released: 2 } }]);
  // 이미 쌓인 settle-run은 VOIDED run에 아무것도 쓰지 않는다.
  await jobs.drain(jobHandlers(d));
  assert.equal((await q("SELECT count(*)::int AS n FROM pool_line WHERE run_id = $1", [runId])).rows[0].n, 0);
  const again = await createBatch(d, w.users.ops, { batchId: `${batchId}_again`, ...period });
  assert.equal(again.runs.length, 1);
  assert.deepEqual(await activeEvents(again.runs[0]!), events);
});

test("CALCULATED and VERIFIED runs can be voided; CONFIRMED, FAILED and VOIDED runs cannot (409)", async () => {
  const calc = await batchOf();
  await calc.jobs.drain({ "settle-run": jobHandlers(calc.d)["settle-run"]! });
  assert.equal(await status(calc.runId), "CALCULATED");
  assert.equal((await voidRun(calc.d, w.users.settle, calc.runId, "bad input")).from, "CALCULATED");
  assert.deepEqual(await activeEvents(calc.runId), []);
  await assert.rejects(voidRun(calc.d, w.users.settle, calc.runId, "twice"), { code: "INVALID_STATE", status: 409 });
  // 쌓여 있던 verify-run은 VOIDED run을 건드리지 않는다.
  await calc.jobs.drain(jobHandlers(calc.d));
  assert.equal(await status(calc.runId), "VOIDED");

  const ver = await batchOf();
  await ver.jobs.drain(jobHandlers(ver.d));
  assert.equal(await status(ver.runId), "VERIFIED");
  assert.equal((await voidRun(ver.d, w.users.settle, ver.runId, "late correction")).from, "VERIFIED");
  assert.deepEqual(await activeEvents(ver.runId), []);

  const conf = await batchOf();
  await conf.jobs.drain(jobHandlers(conf.d));
  await confirmBatch(conf.d, w.users.settle, conf.batchId);
  await assert.rejects(voidRun(conf.d, w.users.settle, conf.runId, "too late"), { code: "INVALID_STATE", status: 409 });
  assert.equal(await status(conf.runId), "CONFIRMED");
  assert.equal((await activeEvents(conf.runId)).length, 2);

  const failed = await batchOf();
  await q("UPDATE settlement_run SET status = 'FAILED', diagnostics = '[]' WHERE run_id = $1", [failed.runId]);
  await assert.rejects(voidRun(failed.d, w.users.settle, failed.runId, "no"), { code: "INVALID_STATE", status: 409 });
});

test("requeue resends settle-run for a PENDING run and verify-run for a CALCULATED run; the requeued run is processed", async () => {
  // createBatch가 보낸 settle-run이 사라진 상황: 배치의 jobs는 drain하지 않는다.
  const lost = await batchOf();
  const jobs = recordingJobs();
  const d: SettleDeps = { ...lost.d, jobs };
  assert.deepEqual(await requeueRun(d, w.users.settle, lost.runId), { runId: lost.runId, status: "PENDING", job: "settle-run" });
  assert.deepEqual(jobs.sent, [{ name: "settle-run", data: { runId: lost.runId } }]);
  await jobs.drain({ "settle-run": jobHandlers(d)["settle-run"]! });
  assert.equal(await status(lost.runId), "CALCULATED");

  // verify-run도 사라졌다고 보고 새 jobs로 다시 보낸다.
  const jobs2 = recordingJobs();
  const d2: SettleDeps = { ...lost.d, jobs: jobs2 };
  assert.deepEqual(await requeueRun(d2, w.users.settle, lost.runId), { runId: lost.runId, status: "CALCULATED", job: "verify-run" });
  assert.deepEqual(jobs2.sent, [{ name: "verify-run", data: { runId: lost.runId } }]);
  await jobs2.drain(jobHandlers(d2));
  assert.equal(await status(lost.runId), "VERIFIED");

  await assert.rejects(requeueRun(d2, w.users.settle, lost.runId), { code: "INVALID_STATE", status: 409 });
  assert.equal(jobs2.sent.length, 1, "a rejected requeue sends nothing");
  const a = (await q("SELECT after_json FROM audit_log WHERE action_name = 'RUN_REQUEUED' AND entity_id = $1 ORDER BY audit_id", [lost.runId])).rows.map((r) => r.after_json);
  assert.deepEqual(a, [{ status: "PENDING", job: "settle-run" }, { status: "CALCULATED", job: "verify-run" }]);

  const voided = await batchOf();
  await voidRun(voided.d, w.users.settle, voided.runId, "gone");
  await assert.rejects(requeueRun(voided.d, w.users.settle, voided.runId), { code: "INVALID_STATE", status: 409 });
  // 재큐잉된 settle-run이 두 번 처리돼도 결과는 한 번만 쓰인다.
  await settleRun(lost.d, { runId: lost.runId });
  assert.equal(await status(lost.runId), "VERIFIED");
});
