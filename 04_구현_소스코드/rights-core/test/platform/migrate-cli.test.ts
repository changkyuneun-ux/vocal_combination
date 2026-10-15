import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
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

test("RC_DB_POOL_MAX: default 48 (10 queues x 4 workers + 3 extra post-batch connections + HTTP), positive integers only", () => {
  assert.equal(poolMaxFromEnv({}), 48);
  assert.equal(poolMaxFromEnv({ RC_DB_POOL_MAX: "" }), 48);
  assert.ok(poolMaxFromEnv({}) >= JOB_NAMES.length * 4 + 3, "the default covers the default worker concurrency");
  assert.equal(poolMaxFromEnv({ RC_DB_POOL_MAX: "7" }), 7);
  for (const bad of ["0", "-1", "1.5", "abc", "1e3"]) assert.throws(() => poolMaxFromEnv({ RC_DB_POOL_MAX: bad }), /RC_DB_POOL_MAX/);
});

test("the CLI runs when invoked through a symlink and fails without RC_ADMIN_URL", async () => {
  const { symlinkSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "rc-mig-"));
  try {
    const link = join(dir, "migrate-link.ts");
    symlinkSync(fileURLToPath(new URL("../../src/platform/migrate-cli.ts", import.meta.url)), link);
    const env = { ...process.env }; delete env.RC_ADMIN_URL;
    const r = spawnSync(process.execPath, [link], { env, encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /RC_ADMIN_URL/);
    const ok = spawnSync(process.execPath, [link], { env: { ...env, RC_ADMIN_URL: at(ADMIN_URL, name) }, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /applied migrations \(0\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
