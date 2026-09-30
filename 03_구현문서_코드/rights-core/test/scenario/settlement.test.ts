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
  await runScenario({ db, ctx }, { n: 100, seed: 7 });
  const r = await runSettlementScenario({ db, ctx, appUrl: fresh.appUrl }, { purchases: 300, seed: 7 });
  // 한 멤버가 모든 슬롯을 부른 조합은 performer cap(50%) 때문에 ALLOC_INFEASIBLE로 실패한다(알려진 제품 발견).
  assert.equal(r.verified + r.failedRuns, r.runs, JSON.stringify(r));
  assert.deepEqual(Object.keys(r.failedReasons).filter((c) => c !== "ALLOC_INFEASIBLE"), []);
  assert.equal(r.failedReasons.ALLOC_INFEASIBLE ?? 0, r.failedRuns, "every FAILED run is attributed to ALLOC_INFEASIBLE");
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

test("settlementPass requires every FAILED run to carry ALLOC_INFEASIBLE", () => {
  const ok: SettlementReport = {
    purchases: 10, refundsPre: 1, refundsPost: 1, runs: 5, verified: 3, failedRuns: 2, failedReasons: { ALLOC_INFEASIBLE: 2 },
    ingestMs: 0, batchMs: 0, settleMs: 0, reverseMs: 0, conservationOk: true, verifyMismatches: 0, reversals: 1, reversalNetZeroOk: true,
    reversalRejected: 0, failedJobs: 0,
  };
  assert.equal(settlementPass(ok), true);
  assert.equal(settlementPass({ ...ok, failedReasons: { ALLOC_INFEASIBLE: 1 } }), false, "one FAILED run without a diagnostic");
  assert.equal(settlementPass({ ...ok, failedReasons: {} }), false, "FAILED runs without any diagnostic");
  assert.equal(settlementPass({ ...ok, failedReasons: { ALLOC_INFEASIBLE: 2, ALLOC_OTHER: 1 } }), false);
  assert.equal(settlementPass({ ...ok, runs: 3, verified: 3, failedRuns: 0, failedReasons: {} }), true);
});
