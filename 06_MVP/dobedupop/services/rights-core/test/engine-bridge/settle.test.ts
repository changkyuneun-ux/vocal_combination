import { test, after } from "node:test";
import assert from "node:assert/strict";
import { evaluateRun, verifyRun } from "../../src/engine-bridge/settle.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { loadSealed } from "../../src/engine-bridge/seal-store.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const seal = await issueCombo(w, "vc_1");
const events = [
  { eventId: "ev_2", type: "PRIMARY" as const, amount: 1001n, integrity: "CLEAR" as const },
  { eventId: "ev_1", type: "PRIMARY" as const, amount: 10000n, integrity: "CLEAR" as const },
];

test("evaluateRun seals events (sorted) and the result; rows conserve every event amount", async () => {
  const r = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t1", snapshotId: seal.snapshotId, events }));
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.diagnostics));
  const doc = (await w.db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [r.eventsDigest])).rows[0].content;
  assert.deepEqual(doc.map((e: { id: string }) => e.id), ["ev_1", "ev_2"]);
  const result = (await w.db.pool.query("SELECT kind, format, content FROM sealed_document WHERE digest = $1", [r.resultDigest])).rows[0];
  assert.equal(result.kind, "allocation_result");
  assert.equal(result.format, "mdrl-allocation-result/1");
  for (const ev of events) {
    const pool: bigint = r.rows.pool.filter((p) => p.eventId === ev.eventId).reduce((a, p) => a + p.amount, 0n);
    assert.equal(pool, ev.amount, `pool lines of ${ev.eventId}`);
  }
  assert.ok(r.rows.lines.every((l) => l.lineSeq === 1 && l.amount > 0n));
  const again = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t1", snapshotId: seal.snapshotId, events: [...events].reverse() }));
  assert.ok(again.ok);
  assert.equal(again.resultDigest, r.resultDigest, "deterministic regardless of input order");
});

test("the sealed result body leaves out trace and result_digest, so the run digest equals the IR's result_digest", async () => {
  const r = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t5", snapshotId: seal.snapshotId, events }));
  assert.ok(r.ok);
  const row = (await w.db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [r.resultDigest])).rows[0];
  assert.equal(Object.hasOwn(row.content, "trace"), false);
  assert.equal(Object.hasOwn(row.content, "result_digest"), false);
  const loaded = (await w.db.tx((tx) => loadSealed(createBridgeCtx(w.ctx.blobs), tx, r.resultDigest))) as { result_digest: string; trace?: unknown };
  assert.equal(loaded.result_digest, r.resultDigest);
  assert.equal(loaded.trace, undefined);
  const projection = (await w.db.tx((tx) => loadSealed(createBridgeCtx(w.ctx.blobs), tx, seal.projectionDigest))) as { digest: string };
  assert.equal(projection.digest, seal.projectionDigest);
});

test("verifyRun recomputes from sealed inputs with a cold cache and detects a mismatch", async () => {
  const r = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t2", snapshotId: seal.snapshotId, events }));
  assert.ok(r.ok);
  const cold = createBridgeCtx(w.ctx.blobs);
  assert.deepEqual(await w.db.tx((tx) => verifyRun(cold, tx, { runId: "run_t2", snapshotId: seal.snapshotId, eventsDigest: r.eventsDigest, resultDigest: r.resultDigest })), []);
  const other = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t3", snapshotId: seal.snapshotId, events: events.slice(0, 1) }));
  assert.ok(other.ok);
  const diags = await w.db.tx((tx) => verifyRun(cold, tx, { runId: "run_t2", snapshotId: seal.snapshotId, eventsDigest: r.eventsDigest, resultDigest: other.resultDigest }));
  assert.ok(diags.length > 0);
});

test("engine diagnostics are returned, not thrown (event type outside the policy scope)", async () => {
  const r = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t4", snapshotId: seal.snapshotId, events: [{ ...events[0]!, type: "RESALE" }] }));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.diagnostics.some((d) => d.code === "ALLOC_SCOPE_MISMATCH"), JSON.stringify(r));
});
