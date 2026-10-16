import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFreshDatabase, ADMIN_URL } from "../../src/platform/dbadmin.ts";
import { createDb } from "../../src/platform/db.ts";
import { tempBridge } from "../fixtures.ts";
import { runScenario } from "../../src/scenario/run.ts";
import { runSettlementScenario, settlementPass, type SettlementReport } from "../../src/scenario/settlement.ts";

const fresh = await createFreshDatabase(ADMIN_URL);
const db = createDb(fresh.appUrl);
const { ctx, cleanup } = tempBridge();
after(async () => { await db.close(); await fresh.drop(); cleanup(); });

test("reduced settlement scenario: 100 issues, 300 purchases, refunds before and after confirmation", async () => {
  const i = await runScenario({ db, ctx }, { n: 100, seed: 7 });
  assert.equal(i.issued, 100);
  const r = await runSettlementScenario({ db, ctx, appUrl: fresh.appUrl }, { purchases: 300, seed: 7 });
  // 정산 불가 조합(한 멤버가 모든 슬롯)은 발행 사전 검사로 거부되므로 FAILED run이 없다.
  assert.equal(r.failedRuns, 0, JSON.stringify(r));
  assert.deepEqual(r.failedReasons, {});
  assert.equal(r.verified, r.runs, JSON.stringify(r));
  assert.ok(r.verified > 0);
  assert.equal(r.verifyMismatches, 0);
  assert.equal(r.conservationOk, true);
  assert.equal(r.reversalNetZeroOk, true);
  assert.equal(r.reversals, r.refundsPost);
  assert.equal(r.reversalRejected, 0);
  assert.equal(r.failedJobs, 0);
  assert.ok(r.reversals > 0 && r.refundsPre > 0);
  assert.equal(settlementPass(r), true, JSON.stringify(r));
});

test("settlementPass requires no FAILED runs (unsettleable combinations are rejected at issue)", () => {
  const ok: SettlementReport = {
    purchases: 10, refundsPre: 1, refundsPost: 1, runs: 3, verified: 3, failedRuns: 0, failedReasons: {},
    ingestMs: 0, batchMs: 0, settleMs: 0, postMs: 0, reverseMs: 0, conservationOk: true, verifyMismatches: 0, reversals: 1, reversalNetZeroOk: true,
    reversalRejected: 0, failedJobs: 0,
  };
  assert.equal(settlementPass(ok), true);
  assert.equal(settlementPass({ ...ok, runs: 5, failedRuns: 2, failedReasons: { ALLOC_INFEASIBLE: 2 } }), false, "FAILED runs fail the scenario");
  assert.equal(settlementPass({ ...ok, runs: 4, failedRuns: 1, failedReasons: {} }), false, "a FAILED run without a diagnostic");
  assert.equal(settlementPass({ ...ok, failedReasons: { ALLOC_INFEASIBLE: 1 } }), false, "a diagnostic without a FAILED run");
  assert.equal(settlementPass({ ...ok, runs: 4 }), false, "a run that is neither VERIFIED nor FAILED");
});
