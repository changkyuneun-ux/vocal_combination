import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadDevClock, DEV_CLOCK_START } from "../../src/dev/clock.ts";
import { ensureDevUsers, DEV_USERS } from "../../src/dev/users.ts";
import { buildServer } from "../../src/http/server.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { createDevPsp } from "../../src/dev/psp.ts";
import { freshDevDb } from "./helpers.ts";

const real = { t: Date.parse("2026-09-30T00:00:00.000Z") };
const { db, adminUrl, drop } = await freshDevDb();
const clock = await loadDevClock(db, () => real.t);
const ctx = createBridgeCtx(createFsBlobStore("/tmp/rc-dev-clock-test-blobs"));
const dev = { clock, psp: createDevPsp(clock), jobs: { pause: async () => {}, resume: async () => {}, paused: () => [] }, adminUrl, blobDir: "/tmp/rc-dev-clock-test-blobs" };
const app = buildServer({ db, ctx, clock, jobs: recordingJobs(), dev });
const plain = buildServer({ db, ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await plain.close(); await drop(); });

test("DEV_CLOCK_START is 2026-01-01 and a fresh dev DB's dev_clock.base_at equals it", async () => {
  assert.equal(DEV_CLOCK_START, "2026-01-01T00:00:00.000Z");
  const f = await freshDevDb();
  try {
    const r = await f.db.tx((tx) => tx.query("SELECT base_at FROM dev_clock"));
    assert.equal((r.rows[0].base_at as Date).toISOString(), DEV_CLOCK_START);
  } finally {
    await f.drop();
  }
});
test("starts at DEV_CLOCK_START and flows with real time", async () => {
  // dev_clock.set_real_at은 마이그레이션 때의 now()이므로 먼저 set으로 기준을 고정한다
  await db.tx((tx) => clock.set(tx, "2026-01-01T00:00:00.000Z"));
  real.t += 1500;
  assert.equal(clock.now(), "2026-01-01T00:00:01.500Z");
});
test("advance moves forward and persists", async () => {
  const at = await db.tx((tx) => clock.advance(tx, 86_400_000));
  const again = await loadDevClock(db, () => real.t);
  assert.equal(again.now(), at);
  assert.equal(clock.now(), at);
});
test("advance rejects non-positive or non-integer ms", async () => {
  for (const ms of [0, -1, 1.5, Number.NaN]) await assert.rejects(db.tx((tx) => clock.advance(tx, ms)), { code: "BAD_REQUEST" });
});
test("set backwards is CLOCK_REGRESSED", async () => {
  await assert.rejects(db.tx((tx) => clock.set(tx, "2026-01-01T00:00:00.000Z")), { code: "CLOCK_REGRESSED" });
});
test("cannot pass real time", async () => {
  await assert.rejects(db.tx((tx) => clock.set(tx, "2026-10-01T00:00:00.000Z")), { code: "CLOCK_AHEAD_OF_REAL" });
});
test("set rejects a malformed instant", async () => {
  await assert.rejects(db.tx((tx) => clock.set(tx, "2026-02-01")), { code: "INVALID_INSTANT" });
  await assert.rejects(db.tx((tx) => clock.set(tx, "2026-02-01T00:00:00Z")), { code: "INVALID_INSTANT" });
});
test("failed set leaves memory unchanged", async () => {
  const before = clock.now();
  await assert.rejects(db.tx((tx) => clock.set(tx, "2025-01-01T00:00:00.000Z")));
  assert.equal(clock.now(), before);
});
test("reload rereads dev_clock", async () => {
  await db.tx((tx) => tx.query("UPDATE dev_clock SET base_at = '2026-02-01T00:00:00.000Z', set_real_at = '2026-09-30T00:00:00.000Z'"));
  await db.tx((tx) => clock.reload(tx));
  assert.equal(clock.now(), new Date(Date.parse("2026-02-01T00:00:00.000Z") + real.t - Date.parse("2026-09-30T00:00:00.000Z")).toISOString());
});

test("GET /dev/clock returns state; absent without dev", async () => {
  const r = await app.inject({ method: "GET", url: "/dev/clock" });
  assert.equal(r.statusCode, 200);
  const b = r.json();
  assert.equal(typeof b.now, "string");
  assert.equal(typeof b.realNow, "string");
  assert.equal(typeof b.headroomMs, "number");
  assert.equal((await plain.inject({ method: "GET", url: "/dev/clock" })).statusCode, 404);
});
test("POST /dev/clock/advance and /set", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/dev/clock/advance", payload: { ms: -1 } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/dev/clock/advance", payload: {} })).statusCode, 400);
  const before = clock.now();
  const a = await app.inject({ method: "POST", url: "/dev/clock/advance", payload: { ms: 1000 } });
  assert.equal(a.statusCode, 200, a.body);
  assert.ok(a.json().now > before);
  assert.equal((await app.inject({ method: "POST", url: "/dev/clock/set", payload: { at: "bad" } })).statusCode, 422);
  const back = await app.inject({ method: "POST", url: "/dev/clock/set", payload: { at: "2026-01-01T00:00:00.000Z" } });
  assert.equal(back.statusCode, 409);
  assert.equal(back.json().code, "CLOCK_REGRESSED");
});

test("ensureDevUsers is idempotent: 8 dev users (7 platform + 1 portal label) + 3 system identities", async () => {
  await db.tx((tx) => ensureDevUsers(tx, clock));
  await db.tx((tx) => ensureDevUsers(tx, clock));
  const r = await db.tx((tx) => tx.query("SELECT user_id FROM user_account ORDER BY user_id"));
  assert.equal(r.rowCount, DEV_USERS.length + 3);
  assert.equal(DEV_USERS.length, 10);
  assert.equal(new Set(r.rows.map((x) => x.user_id)).size, r.rowCount);
});
test("ensureDevUsers creates the system identities and the editor roles", async () => {
  const ids = (await db.tx((tx) => tx.query("SELECT user_id FROM user_account"))).rows.map((x) => x.user_id as string);
  for (const id of ["sys_ingest", "sys_settler", "sys_verifier"]) assert.ok(ids.includes(id), id);
  const roles = (await db.tx((tx) => tx.query("SELECT role FROM portal_role WHERE user_id = 'usr_editor'"))).rows.map((x) => x.role as string).sort();
  assert.deepEqual(roles, ["EDITOR", "RIGHTS_EDITOR"]);
});
