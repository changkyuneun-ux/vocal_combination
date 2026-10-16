import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { healthServer, listenHostFromEnv, queuesFor, roleFromEnv } from "../../src/http/assemble.ts";
import { buildServer } from "../../src/http/server.ts";
import { startBossJobs, JOB_NAMES } from "../../src/platform/jobs.ts";
import { productionProviderFromEnv } from "../../src/payout/provider.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";

// 프로세스 역할(MVP 진행계획 M2): 같은 이미지를 API·워커·검증 워커로 나눠 띄운다. 검증은 실행과 다른 프로세스에서만 돈다.
const { db, drop } = await freshDb();
after(drop);

test("RC_ROLE picks the role (default all) and refuses unknown roles", () => {
  assert.equal(roleFromEnv({}), "all");
  assert.equal(roleFromEnv({ RC_ROLE: "" }), "all");
  for (const r of ["api", "worker", "verifier", "all"]) assert.equal(roleFromEnv({ RC_ROLE: r }), r);
  assert.throws(() => roleFromEnv({ RC_ROLE: "web" }), /RC_ROLE/);
  assert.equal(listenHostFromEnv({}), "127.0.0.1");
  assert.equal(listenHostFromEnv({ RC_LISTEN_HOST: "0.0.0.0" }), "0.0.0.0");
});

test("queues per role: the API only sends, the worker never verifies, the verifier only verifies", () => {
  assert.deepEqual(queuesFor("api"), []);
  assert.deepEqual(queuesFor("verifier"), ["verify-run"]);
  assert.ok(!queuesFor("worker").includes("verify-run"));
  assert.deepEqual([...queuesFor("worker"), "verify-run"].sort(), [...JOB_NAMES].sort());
  assert.deepEqual(queuesFor("all"), [...JOB_NAMES]);
});

test("a worker registered for some queues leaves the other queues' jobs waiting", async () => {
  const boss = await startBossJobs((db.pool as any).options.connectionString);
  try {
    const got: string[] = [];
    await boss.work({ "verify-run": async (d) => { got.push(d.id!); } });
    await db.tx(async (tx) => { await boss.send(tx, "verify-run", { id: "v" }); await boss.send(tx, "settle-run", { id: "s" }); });
    for (let i = 0; i < 100 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(got, ["v"]);
    const r = await db.pool.query("SELECT state FROM pgboss.job WHERE name = 'settle-run'");
    assert.deepEqual(r.rows.map((x) => x.state), ["created"], "no settle-run handler here: the job waits for a worker");
  } finally {
    await boss.stop();
  }
});

test("health endpoints: the API and the worker roles answer /healthz and /readyz", async () => {
  const api = buildServer({ db, ctx: createBridgeCtx(createFsBlobStore("/tmp/rc-roles-test-blobs")), clock: fixedClock("2026-01-01T00:00:00.000Z", 0), jobs: recordingJobs() });
  const worker = healthServer(db, "worker");
  try {
    assert.deepEqual((await api.inject({ method: "GET", url: "/healthz" })).json(), { status: "ok", role: "api" });
    assert.deepEqual((await api.inject({ method: "GET", url: "/readyz" })).json(), { status: "ready", role: "api" });
    assert.deepEqual((await worker.inject({ method: "GET", url: "/readyz" })).json(), { status: "ready", role: "worker" });
    assert.equal((await worker.inject({ method: "GET", url: "/ops/parties" })).statusCode, 404, "a worker serves no business API");
  } finally {
    await api.close();
    await worker.close();
  }
});

test("production refuses the fake PSP (no real adapter yet)", () => {
  assert.throws(() => productionProviderFromEnv({}), /PRODUCTION_REFUSES_FAKE/);
  assert.throws(() => productionProviderFromEnv({ RC_PSP: "fake" }), /PRODUCTION_REFUSES_FAKE/);
  assert.throws(() => productionProviderFromEnv({ RC_PSP: "toss" }), /unknown PSP adapter/);
});
