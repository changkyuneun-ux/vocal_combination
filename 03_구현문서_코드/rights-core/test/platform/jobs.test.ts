import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { freshDb } from "../helpers.ts";
import { recordingJobs, startBossJobs, workOptionsFromEnv, type JobName } from "../../src/platform/jobs.ts";

const { db, drop } = await freshDb();
after(drop);

test("recordingJobs records sends and drains handlers, including jobs sent by handlers", async () => {
  const jobs = recordingJobs();
  await db.tx((tx) => jobs.send(tx, "settle-run", { runId: "r1" }));
  const seen: string[] = [];
  const n = await jobs.drain({
    "settle-run": async (d) => { seen.push(`settle:${d.runId}`); await db.tx((tx) => jobs.send(tx, "verify-run", { runId: d.runId! })); },
    "verify-run": async (d) => { seen.push(`verify:${d.runId}`); },
  });
  assert.equal(n, 2);
  assert.deepEqual(seen, ["settle:r1", "verify:r1"]);
});

test("recordingJobs.drain with a partial handler map leaves unhandled jobs pending for a later drain", async () => {
  const jobs = recordingJobs();
  await db.tx(async (tx) => {
    await jobs.send(tx, "verify-run", { runId: "v1" });
    await jobs.send(tx, "settle-run", { runId: "s1" });
    await jobs.send(tx, "settle-run", { runId: "s2" });
  });
  const seen: string[] = [];
  const handlers = {
    "settle-run": async (d: Record<string, string>) => { seen.push(`settle:${d.runId}`); },
    "verify-run": async (d: Record<string, string>) => { seen.push(`verify:${d.runId}`); },
  };
  assert.equal(await jobs.drain({ "settle-run": handlers["settle-run"] }), 2);
  assert.deepEqual(seen, ["settle:s1", "settle:s2"]);
  assert.equal(await jobs.drain(handlers), 1);
  assert.deepEqual(seen, ["settle:s1", "settle:s2", "verify:v1"]);
  assert.equal(await jobs.drain(handlers), 0, "handled jobs are not run twice");
});

test("pg-boss jobs are sent inside the caller's transaction (rolled back sends never run)", async () => {
  const boss = await startBossJobs((db.pool as any).options.connectionString);
  try {
    const got: string[] = [];
    const handlers = Object.fromEntries((["settle-run", "verify-run", "refund-recorded", "reverse-event"] as JobName[])
      .map((n) => [n, async (d: Record<string, string>) => { got.push(`${n}:${d.id}`); }])) as never;
    await boss.work(handlers);
    await db.tx((tx) => boss.send(tx, "settle-run", { id: "kept" }));
    await assert.rejects(db.tx(async (tx) => { await boss.send(tx, "settle-run", { id: "rolled" }); throw new Error("boom"); }));
    await boss.drainIdle(10_000);
    assert.deepEqual(got, ["settle-run:kept"]);
  } finally {
    await boss.stop();
  }
});

test("worker options come from RC_JOB_BATCH_SIZE / RC_JOB_CONCURRENCY with defaults 20 and 4", () => {
  assert.deepEqual(workOptionsFromEnv({}), { batchSize: 20, localConcurrency: 4 });
  assert.deepEqual(workOptionsFromEnv({ RC_JOB_BATCH_SIZE: "", RC_JOB_CONCURRENCY: "" }), { batchSize: 20, localConcurrency: 4 });
  assert.deepEqual(workOptionsFromEnv({ RC_JOB_BATCH_SIZE: "50", RC_JOB_CONCURRENCY: "1" }), { batchSize: 50, localConcurrency: 1 });
  for (const bad of ["0", "-1", "1.5", "x", " 2"]) {
    assert.throws(() => workOptionsFromEnv({ RC_JOB_BATCH_SIZE: bad }), /RC_JOB_BATCH_SIZE/);
    assert.throws(() => workOptionsFromEnv({ RC_JOB_CONCURRENCY: bad }), /RC_JOB_CONCURRENCY/);
  }
});

test("the server entry point passes env worker options to startBossJobs", () => {
  // 조립은 src/http/assemble.ts로 옮겼다(운영·개발 진입점 공용).
  const assemble = readFileSync(fileURLToPath(new URL("../../src/http/assemble.ts", import.meta.url)), "utf8");
  assert.match(assemble, /startBossJobs\(opts\.url, workOptionsFromEnv\(process\.env\)\)/);
});

test("a delayed send is recorded with its delay and stored by pg-boss with a future start_after", async () => {
  const rec = recordingJobs();
  await db.tx((tx) => rec.send(tx, "poll-payout", { instructionId: "po_1", attempt: "1" }, { startAfterSeconds: 60 }));
  assert.deepEqual(rec.sent, [{ name: "poll-payout", data: { instructionId: "po_1", attempt: "1" }, startAfterSeconds: 60 }]);
  const boss = await startBossJobs((db.pool as any).options.connectionString);
  try {
    await db.tx((tx) => boss.send(tx, "poll-payout", { instructionId: "po_delay" }, { startAfterSeconds: 60 }));
    await db.tx((tx) => boss.send(tx, "poll-payout", { instructionId: "po_now" }));
    const r = await db.pool.query(
      "SELECT data->>'instructionId' AS id, start_after > now() + interval '30 seconds' AS later FROM pgboss.job WHERE name = 'poll-payout' ORDER BY id");
    assert.deepEqual(r.rows.map((x) => [x.id, x.later]), [["po_delay", true], ["po_now", false]]);
  } finally {
    await boss.stop();
  }
});

test("the server entry point registers the payout job handlers with the RC_PSP-selected provider", () => {
  const main = readFileSync(fileURLToPath(new URL("../../src/http/main.ts", import.meta.url)), "utf8");
  assert.match(main, /providerFromEnv\(process\.env\)/);
  const assemble = readFileSync(fileURLToPath(new URL("../../src/http/assemble.ts", import.meta.url)), "utf8");
  assert.match(assemble, /payoutJobHandlers\(\{ db, clock: opts\.clock, jobs, provider: opts\.provider \}\)/);
});
