import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";

const { db, adminUrl, drop } = await freshDb();
after(drop);

test("fresh database has migrations applied and connects as rc_app", async () => {
  const r = await db.pool.query("SELECT current_user AS u, (SELECT count(*) FROM schema_migrations)::int AS n");
  assert.equal(r.rows[0].u, "rc_app");
  assert.ok(r.rows[0].n >= 1);
});

test("mdrl_id domain rejects invalid ids and __proto__", async () => {
  await assert.rejects(db.pool.query("SELECT 'a b'::mdrl_id"));
  await assert.rejects(db.pool.query("SELECT '__proto__'::mdrl_id"));
  const ok = await db.pool.query("SELECT 'pty_a.b-1'::mdrl_id AS v");
  assert.equal(ok.rows[0].v, "pty_a.b-1");
});

test("audit_log is insert-only for rc_app", async () => {
  await db.pool.query(
    "INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id) VALUES (now(), 'u', 'x', 'y', 'z')",
  );
  await assert.rejects(db.pool.query("UPDATE audit_log SET action_name = 'w'"));
  await assert.rejects(db.pool.query("DELETE FROM audit_log"));
});

test("tx rolls back on error", async () => {
  await assert.rejects(db.tx(async (tx) => {
    await tx.query("INSERT INTO outbox (topic, payload, created_at) VALUES ('t', '{}', now())");
    throw new Error("boom");
  }));
  const r = await db.pool.query("SELECT count(*)::int AS n FROM outbox");
  assert.equal(r.rows[0].n, 0);
});

test("fixedClock steps by the given milliseconds", () => {
  const c = fixedClock("2026-01-01T00:00:00.000Z", 5);
  assert.equal(c.now(), "2026-01-01T00:00:00.000Z");
  assert.equal(c.now(), "2026-01-01T00:00:00.005Z");
  const still = fixedClock("2026-01-01T00:00:00.000Z", 0);
  assert.equal(still.now(), still.now());
});

async function asAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const rc001 = { code: "RC001" };

test("audit_log trigger rejects UPDATE and DELETE even for the owner (RC001)", async () => {
  await asAdmin(async (c) => {
    await c.query(
      "INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id) VALUES (now(), 'u', 'x', 'y', 'z')",
    );
    await assert.rejects(c.query("UPDATE audit_log SET action_name = 'w'"), rc001);
    await assert.rejects(c.query("DELETE FROM audit_log"), rc001);
  });
});

test("rc_allow_supersede_only permits a single superseded_at set only", async () => {
  await asAdmin(async (c) => {
    await c.query("CREATE TABLE scratch (id int, v int, superseded_at timestamptz)");
    await c.query(
      "CREATE TRIGGER scratch_guard BEFORE UPDATE OR DELETE ON scratch FOR EACH ROW EXECUTE FUNCTION rc_allow_supersede_only()",
    );
    await c.query("INSERT INTO scratch VALUES (1, 10, NULL), (2, 20, NULL)");
    await c.query("UPDATE scratch SET superseded_at = now() WHERE id = 1");
    await assert.rejects(c.query("UPDATE scratch SET superseded_at = now() WHERE id = 1"), rc001);
    await assert.rejects(c.query("UPDATE scratch SET v = 11 WHERE id = 2"), rc001);
    await assert.rejects(c.query("UPDATE scratch SET v = 11, superseded_at = now() WHERE id = 2"), rc001);
    await assert.rejects(c.query("DELETE FROM scratch WHERE id = 2"), rc001);
  });
});
