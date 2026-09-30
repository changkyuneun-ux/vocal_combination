import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../src/platform/errors.ts";
import { preflightIssue } from "../../src/engine-bridge/preflight.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());

const count = async (sql: string, args: unknown[]) => (await w.db.pool.query(sql, args)).rows[0].n as number;

test("a single-member combination (performer cap 50%) is rejected with 422 ISSUE_NOT_SETTLEABLE and leaves no rows", async () => {
  await assert.rejects(issueCombo(w, "vc_solo", "a", "a"), (e: unknown) => {
    assert.ok(e instanceof DomainError);
    assert.equal(e.code, "ISSUE_NOT_SETTLEABLE");
    assert.equal(e.status, 422);
    assert.ok(e.diagnostics.some((d) => d.code === "ALLOC_INFEASIBLE"), JSON.stringify(e.diagnostics));
    return true;
  });
  assert.equal(await count("SELECT count(*)::int AS n FROM rights_snapshot WHERE vc_id = $1", ["vc_solo"]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM issue_seal WHERE snapshot_id = $1", ["snp_vc_solo"]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM snapshot_member_pct WHERE snapshot_id = $1", ["snp_vc_solo"]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action_name = 'ISSUED' AND entity_id = $1", ["snp_vc_solo"]), 0);
});

test("a two-member combination issues normally and its seal passes the preflight", async () => {
  const seal = await issueCombo(w, "vc_duo");
  assert.equal(seal.snapshotId, "snp_vc_duo");
  assert.deepEqual(await w.db.tx((tx) => preflightIssue(w.ctx, tx, seal)), []);
  assert.equal(await count("SELECT count(*)::int AS n FROM issue_seal WHERE snapshot_id = $1", ["snp_vc_duo"]), 1);
});

test("the preflight does not seal anything (no events or allocation_result documents)", async () => {
  const before = await count("SELECT count(*)::int AS n FROM sealed_document", []);
  const seal = await issueCombo(w, "vc_duo2", "b", "a");
  const after1 = await count("SELECT count(*)::int AS n FROM sealed_document", []);
  await w.db.tx((tx) => preflightIssue(w.ctx, tx, seal));
  assert.equal(await count("SELECT count(*)::int AS n FROM sealed_document", []), after1);
  assert.equal(await count("SELECT count(*)::int AS n FROM sealed_document WHERE kind IN ('events','allocation_result')", []), 0);
  assert.ok(after1 >= before);
});
