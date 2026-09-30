import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { ADMIN_URL } from "../../src/platform/dbadmin.ts";
import { createDb, poolMaxFromEnv } from "../../src/platform/db.ts";
import { JOB_NAMES, startBossJobs } from "../../src/platform/jobs.ts";
import { runMigrations } from "../../src/platform/migrate-cli.ts";

const name = `rc_m_${process.pid}_${randomBytes(3).toString("hex")}`;
const at = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`); // 템플릿이 아닌 빈 DB
after(async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });

test("runMigrations is idempotent and leaves the queues usable by rc_app", async () => {
  const url = at(ADMIN_URL, name);
  const first = await runMigrations(url);
  assert.ok(first.applied.length > 0);
  assert.deepEqual(first.queues, [...JOB_NAMES].sort());
  const second = await runMigrations(url);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.queues, first.queues);
  const u = new URL(at(ADMIN_URL, name)); u.username = "rc_app"; u.password = "rc_app";
  const jobs = await startBossJobs(u.toString());
  await jobs.stop();
  const db = createDb(u.toString(), { max: 3 });
  assert.equal((await db.pool.query("SELECT 1 AS x")).rows[0].x, 1);
  assert.equal(db.pool.options.max, 3);
  await db.close();
});

test("RC_DB_POOL_MAX: default 20, positive integers only", () => {
  assert.equal(poolMaxFromEnv({}), 20);
  assert.equal(poolMaxFromEnv({ RC_DB_POOL_MAX: "" }), 20);
  assert.equal(poolMaxFromEnv({ RC_DB_POOL_MAX: "7" }), 7);
  for (const bad of ["0", "-1", "1.5", "abc", "1e3"]) assert.throws(() => poolMaxFromEnv({ RC_DB_POOL_MAX: bad }), /RC_DB_POOL_MAX/);
});
