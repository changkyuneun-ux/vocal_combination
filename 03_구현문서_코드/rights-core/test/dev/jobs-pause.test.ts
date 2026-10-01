import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startBossJobs, JOB_NAMES, type JobName } from "../../src/platform/jobs.ts";
import { createDevJobs } from "../../src/dev/jobs.ts";
import { freshDb } from "../helpers.ts";

const { db, drop } = await freshDb();
after(async () => { await drop(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pause stops one queue (jobs wait), resume processes them, other queues keep running", async () => {
  const boss = await startBossJobs((db.pool as any).options.connectionString);
  try {
    const got: string[] = [];
    const handlers = Object.fromEntries(JOB_NAMES.map((n) => [n, async (d: Record<string, string>) => { got.push(`${n}:${d.id}`); }])) as never;
    await boss.work(handlers);
    const dev = createDevJobs(boss);
    await dev.pause("submit-payout" as JobName);
    assert.deepEqual(dev.paused(), ["submit-payout"]);
    await db.tx((tx) => boss.send(tx, "submit-payout", { id: "p1" }));
    await db.tx((tx) => boss.send(tx, "settle-run", { id: "s1" }));
    await sleep(2000);
    assert.deepEqual(got, ["settle-run:s1"], "paused queue holds its job while another queue is processed");
    await dev.resume("submit-payout");
    assert.deepEqual(dev.paused(), []);
    await boss.drainIdle(10_000);
    assert.deepEqual([...got].sort(), ["settle-run:s1", "submit-payout:p1"]);
    await dev.resume("submit-payout"); // 멈추지 않은 큐는 그대로 둔다
    await dev.pause("poll-payout");
    await dev.pause("poll-payout"); // 두 번 멈춰도 안전
    await dev.resume("poll-payout");
  } finally {
    await boss.stop();
  }
});
