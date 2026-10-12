import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadDevClock, DEV_CLOCK_START } from "../../src/dev/clock.ts";
import { ensureDevUsers } from "../../src/dev/users.ts";
import { createDevPsp } from "../../src/dev/psp.ts";
import { assertDevDbName, resetDevDatabase } from "../../src/dev/reset.ts";
import { buildServer } from "../../src/http/server.ts";
import { recordingJobs, type JobName } from "../../src/platform/jobs.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { SONG } from "../../src/scenario/synthetic-song.ts";
import { freshDevDb } from "./helpers.ts";

const { db, adminUrl, drop } = await freshDevDb();
const clock = await loadDevClock(db);
await db.tx((tx) => ensureDevUsers(tx, clock));
const blobDir = "/tmp/rc-dev-reset-test-blobs";
const psp = createDevPsp(clock);
const paused = new Set<JobName>();
const jobs = { pause: async (n: JobName) => { paused.add(n); }, resume: async (n: JobName) => { paused.delete(n); }, paused: () => [...paused] };
const testDbName = decodeURIComponent(new URL(adminUrl).pathname.slice(1));
const dev = { clock, psp, jobs, adminUrl, blobDir, devDbName: testDbName };
const ctx = createBridgeCtx(createFsBlobStore(blobDir));
const app = buildServer({ db, ctx, clock, jobs: recordingJobs(), dev });
const strict = buildServer({ db, ctx, clock, jobs: recordingJobs(), dev: { clock, psp, jobs, adminUrl, blobDir } });
after(async () => { await app.close(); await strict.close(); await drop(); });

const count = async (sql: string) => (await db.pool.query(sql)).rows[0].n as number;
const policyRows = async () => (await db.pool.query("SELECT * FROM payout_policy ORDER BY 1")).rows;

test("assertDevDbName / resetDevDatabase refuse any database but rights_core_dev", async () => {
  assert.doesNotThrow(() => assertDevDbName("rights_core_dev"));
  assert.doesNotThrow(() => assertDevDbName("rc_t_x", "rc_t_x"));
  assert.throws(() => assertDevDbName("rights_core"), /DEV_ONLY|refusing/);
  await assert.rejects(resetDevDatabase("postgres://rc:rc@localhost:54329/rights_core"), /refusing/);
  await assert.rejects(resetDevDatabase(adminUrl), /refusing/, "the test DB (rc_t_...) is not the dev DB");
  paused.clear();
  let pauseCalls = 0;
  const spy = { ...jobs, pause: async (n: JobName) => { pauseCalls++; await jobs.pause(n); } };
  const strictSpy = buildServer({ db, ctx, clock, jobs: recordingJobs(), dev: { clock, psp, jobs: spy, adminUrl, blobDir } });
  assert.equal((await strictSpy.inject({ method: "POST", url: "/dev/reset" })).statusCode, 403);
  assert.equal(pauseCalls, 0, "a refused reset must not pause the queues");
  await strictSpy.close();
  assert.equal((await strict.inject({ method: "POST", url: "/dev/reset" })).statusCode, 403, "the route uses the name-checked reset");
});

test("seed -> 409 reseed -> reset -> empty + seed rows + users + clock -> seed again 201", async () => {
  const seedPolicy = await policyRows();
  assert.ok(seedPolicy.length >= 1);
  const peek = await app.inject({ method: "GET", url: "/dev/seed/synthetic-song" });
  assert.equal(peek.statusCode, 200, peek.body);
  assert.deepEqual(peek.json(), { packId: SONG.pack, factsScopeId: SONG.scope, policyId: "pol_nova_summer", policyText: SONG.policyText });
  assert.equal(await count("SELECT count(*)::int AS n FROM party"), 0, "GET writes nothing");
  const s = await app.inject({ method: "POST", url: "/dev/seed/synthetic-song" });
  assert.equal(s.statusCode, 201, s.body);
  assert.deepEqual((await app.inject({ method: "GET", url: "/dev/seed/synthetic-song" })).json(), s.json(), "GET still works after seeding");
  assert.deepEqual(s.json(), { packId: SONG.pack, factsScopeId: SONG.scope, policyId: "pol_nova_summer", policyText: SONG.policyText });
  const again = await app.inject({ method: "POST", url: "/dev/seed/synthetic-song" });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, "ALREADY_SEEDED");
  assert.ok(await count("SELECT count(*)::int AS n FROM party") > 0);

  await app.inject({ method: "POST", url: "/dev/clock/advance", payload: { ms: 1000 } });
  psp.setOutcome("po_x", "FAILED");
  paused.add("submit-payout");
  const r = await app.inject({ method: "POST", url: "/dev/reset" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().ok, true);
  assert.ok(r.json().clock.now.startsWith("2026-01-01T00:00:0"), r.body);
  assert.ok(clock.now() >= DEV_CLOCK_START && clock.now() < "2026-01-01T00:01:00.000Z");
  assert.equal(await count("SELECT count(*)::int AS n FROM party"), 0);
  assert.deepEqual(await policyRows(), seedPolicy);
  assert.equal(await count("SELECT count(*)::int AS n FROM user_account"), 10);
  assert.equal(await count("SELECT count(*)::int AS n FROM dev_clock"), 1);
  assert.deepEqual(psp.outcomes(), { byInstruction: {}, byParty: {} });
  assert.deepEqual(jobs.paused(), []);

  assert.equal((await app.inject({ method: "POST", url: "/dev/seed/synthetic-song" })).statusCode, 201);
});

test("set stays monotonic: moving back is CLOCK_REGRESSED (only /dev/reset goes back)", async () => {
  await db.tx((tx) => clock.advance(tx, 5000));
  const r = await app.inject({ method: "POST", url: "/dev/clock/set", payload: { at: DEV_CLOCK_START } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "CLOCK_REGRESSED");
});
