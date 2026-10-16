import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { onCommit } from "../../src/platform/db.ts";

const { db, drop } = await freshDb();
after(drop);

test("onCommit hooks run after COMMIT, in registration order", async () => {
  const seen: string[] = [];
  await db.tx(async (tx) => {
    onCommit(tx, () => seen.push("a"));
    onCommit(tx, () => seen.push("b"));
    assert.deepEqual(seen, []);
  });
  assert.deepEqual(seen, ["a", "b"]);
});

test("onCommit hooks are discarded on rollback and do not leak into the next tx", async () => {
  const seen: string[] = [];
  await assert.rejects(db.tx(async (tx) => { onCommit(tx, () => seen.push("x")); throw new Error("boom"); }), /boom/);
  await db.tx(async () => {});
  assert.deepEqual(seen, []);
});

test("a throwing onCommit hook is logged and does not fail the committed tx", async () => {
  const errs: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a); };
  const seen: string[] = [];
  try {
    const out = await db.tx(async (tx) => {
      onCommit(tx, () => { throw new Error("hook-fail"); });
      onCommit(tx, () => seen.push("after"));
      return 42;
    });
    assert.equal(out, 42);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.deepEqual(seen, ["after"]);
});

test("onCommit outside db.tx throws", async () => {
  const c = await db.pool.connect();
  try {
    assert.throws(() => onCommit(c, () => {}), /inside db\.tx/);
  } finally {
    c.release();
  }
});
