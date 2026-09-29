import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";

const { db, drop } = await freshDb();
after(drop);

test("fresh database has migrations applied and connects as rc_app", async () => {
  const r = await db.pool.query("SELECT current_user AS u, (SELECT count(*) FROM schema_migrations)::int AS n");
  assert.equal(r.rows[0].u, "rc_app");
  assert.ok(r.rows[0].n >= 1);
});

test("vcrl_id domain rejects invalid ids and __proto__", async () => {
  await assert.rejects(db.pool.query("SELECT 'a b'::vcrl_id"));
  await assert.rejects(db.pool.query("SELECT '__proto__'::vcrl_id"));
  const ok = await db.pool.query("SELECT 'pty_a.b-1'::vcrl_id AS v");
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
