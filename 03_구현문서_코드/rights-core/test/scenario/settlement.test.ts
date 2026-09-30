import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFreshDatabase, ADMIN_URL } from "../../src/platform/dbadmin.ts";
import { createDb } from "../../src/platform/db.ts";
import { tempBridge } from "../fixtures.ts";
import { runScenario } from "../../src/scenario/run.ts";
import { runSettlementScenario } from "../../src/scenario/settlement.ts";

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
  assert.ok(r.verified > 0);
  assert.equal(r.verifyMismatches, 0);
  assert.equal(r.conservationOk, true);
  assert.equal(r.reversalNetZeroOk, true);
  assert.equal(r.reversals, r.refundsPost);
  assert.equal(r.reversalRejected, 0);
  assert.equal(r.failedJobs, 0);
  assert.ok(r.reversals > 0 && r.refundsPre > 0);
});
