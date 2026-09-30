import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFreshDatabase, ADMIN_URL } from "../../src/platform/dbadmin.ts";
import { createDb } from "../../src/platform/db.ts";
import { tempBridge } from "../fixtures.ts";
import { runScenario } from "../../src/scenario/run.ts";
import { runSettlementScenario, settlementPass } from "../../src/scenario/settlement.ts";
import { ledgerPass, runLedgerScenario, type LedgerReport } from "../../src/scenario/ledger.ts";

const fresh = await createFreshDatabase(ADMIN_URL);
const db = createDb(fresh.appUrl);
const { ctx, cleanup } = tempBridge();
after(async () => { await db.close(); await fresh.drop(); cleanup(); });

let report: LedgerReport | undefined;

test("reduced ledger scenario: 100 issues, 300 purchases → posting, fraud releases, payouts, statements", async () => {
  const i = await runScenario({ db, ctx }, { n: 100, seed: 7 });
  assert.equal(i.issued, 100);
  const s = await runSettlementScenario({ db, ctx, appUrl: fresh.appUrl }, { purchases: 300, seed: 7 });
  assert.equal(settlementPass(s), true, JSON.stringify(s));
  const r = await runLedgerScenario({ db, ctx, appUrl: fresh.appUrl }, { seed: 7 });
  report = r;
  const j = JSON.stringify(r);
  // 원장 반영과 점검 API
  assert.ok(r.entries > 0 && r.entriesByKind.SETTLEMENT! > 0, j);
  assert.deepEqual(r.invariants, {
    unreflectedRefunds: 0, unreflectedRevisions: 0, entriesUnbalanced: 0, receivableMatchesSettlement: true, rightsConserved: true,
    unpostedConfirmedRuns: 0, unpostedReversals: 0, poolMismatches: 0, stuckRuns: 0,
  });
  // 보류 절반 해제(제안대로)
  assert.ok(r.fraudHolds > 0 && r.released > 0, j);
  assert.equal(r.releaseAttempted, Math.ceil(r.fraudHolds / 2));
  assert.equal(r.released + Object.values(r.releaseSkipped).reduce((a, n) => a + n, 0), r.releaseAttempted, j);
  assert.equal(r.entriesByKind.HOLD_RELEASE, r.released);
  // 프로필 80 / 10 / 10
  assert.equal(r.profiles.individual + r.profiles.kycPending + r.profiles.corp, r.parties);
  assert.ok(r.profiles.kycPending >= 1 && r.profiles.corp >= 1, j);
  // 지급: 성공·실패·불명 섞음, 두 번째 실행은 실패 복원분만 지급하고 나머지는 이월
  assert.ok(r.payouts.PAID > 0 && r.payouts.FAILED > 0 && r.payouts.HELD > 0 && r.payouts.CARRIED > 0, j);
  assert.ok(r.unknownSubmits > 0, j);
  assert.equal(r.runs[1]!.counts.PENDING, r.payouts.FAILED, "the second run repays exactly the restored FAILED balances");
  assert.ok(BigInt(r.withholdingKrw) > 0n, j);
  assert.equal(r.accountsOk, true, j);
  // webhook 중복은 저장되지 않고, 결과는 지시마다 한 번만 적용된다
  assert.ok(r.webhookDuplicates > 0, j);
  assert.equal(r.webhookDuplicatesIgnored, r.webhookDuplicates);
  assert.equal(r.duplicateResults, 0);
  assert.equal(r.resultConflicts, 0);
  assert.equal(r.payoutAlerts, 0);
  assert.equal(r.unprocessedWebhooks, 0);
  assert.equal(r.openInstructions, 0);
  assert.equal(r.failedJobs, 0);
  // 명세 항등식과 지급 총액 대조
  assert.equal(r.statements, r.parties);
  assert.equal(r.statementIdentityFailures, 0);
  assert.equal(r.statementClosingMismatches, 0);
  assert.equal(r.statementPayoutGrossKrw, r.instructionPayoutGrossKrw);
  assert.equal(r.statementWithholdingKrw, r.instructionWithholdingKrw);
  assert.ok(r.busyParty.postings > 0 && r.busyParty.statementMs > 0 && r.invariantsMs > 0);
  assert.equal(ledgerPass(r), true, j);
});

test("ledgerPass rejects any broken invariant, identity, duplicate or missing path", () => {
  assert.ok(report !== undefined, "scenario test must run first");
  const ok = report!;
  assert.equal(ledgerPass(ok), true);
  const bad: [string, LedgerReport][] = [
    ["unbalanced entry", { ...ok, invariants: { ...ok.invariants, entriesUnbalanced: 1 } }],
    ["receivable", { ...ok, invariants: { ...ok.invariants, receivableMatchesSettlement: false } }],
    ["rights pool", { ...ok, invariants: { ...ok.invariants, rightsConserved: false } }],
    ["unreflected refund", { ...ok, invariants: { ...ok.invariants, unreflectedRefunds: 1 } }],
    ["unposted run", { ...ok, invariants: { ...ok.invariants, unpostedConfirmedRuns: 1 } }],
    ["statement identity", { ...ok, statementIdentityFailures: 1 }],
    ["statement closing", { ...ok, statementClosingMismatches: 1 }],
    ["statement payout total", { ...ok, statementPayoutGrossKrw: "1" }],
    ["duplicate result", { ...ok, duplicateResults: 1 }],
    ["webhook duplicate applied", { ...ok, webhookDuplicatesIgnored: ok.webhookDuplicates - 1 }],
    ["open instruction", { ...ok, openInstructions: 1 }],
    ["no failure path", { ...ok, payouts: { ...ok.payouts, FAILED: 0 } }],
    ["no unknown path", { ...ok, unknownSubmits: 0 }],
    ["no release", { ...ok, released: 0 }],
    ["accounts", { ...ok, accountsOk: false }],
    ["failed job", { ...ok, failedJobs: 1 }],
  ];
  for (const [name, r] of bad) assert.equal(ledgerPass(r), false, name);
});
