import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { recordingJobs, startBossJobs, type JobName } from "../../src/platform/jobs.ts";

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
