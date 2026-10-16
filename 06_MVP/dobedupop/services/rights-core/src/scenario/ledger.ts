import { performance } from "node:perf_hooks";
import { createUser, loadActor } from "../platform/actor.ts";
import { fixedClock } from "../platform/clock.ts";
import type { Db } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { startBossJobs, JOB_NAMES, type BossJobs, type JobHandler, type JobName } from "../platform/jobs.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { suggestFraudRelease } from "../engine-bridge/fraud-release.ts";
import { balance } from "../ledger/journal.ts";
import { partyStatement, type Statement } from "../ledger/statements.ts";
import { jobHandlers } from "../settlement/handlers.ts";
import { audioJobHandlers } from "../audio/handlers.ts";
import { releaseHold } from "../settlement/holds.ts";
import { invariants } from "../settlement/invariants.ts";
import { fakeProvider } from "../payout/fake-provider.ts";
import { payoutJobHandlers, recordWebhook } from "../payout/handlers.ts";
import { createPayoutRun, setPayoutProfile, type InstructionStatus } from "../payout/service.ts";
import { mulberry32 } from "./prng.ts";
import { inParallel, shuffled } from "./settlement.ts";

export type LedgerReport = {
  /** 분개·전기 수와 분개 종류별 수. */
  entries: number; postings: number; entriesByKind: Record<string, number>;
  /** 미지급금 계정이 있는 권리자 수와 프로필 구성(80% 개인·10% KYC 미확인 개인·10% 법인). */
  parties: number; profiles: { individual: number; kycPending: number; corp: number };
  /** 확정 run의 FRAUD_REVIEW 보류 수, 해제 시도(절반), 제안대로 해제한 수·금액, 건너뛴 사유(EMPTY: 역분개로 남은 보류 0, SUGGESTION_HAS_DISPUTE). */
  fraudHolds: number; releaseAttempted: number; released: number; releasedKrw: string; releaseSkipped: Record<string, number>;
  /** 지급 실행별 생성 시 상태 수(1차: 전액, 2차: 실패 복원분 재지급·나머지 이월). */
  runs: { payoutRunId: string; asOf: string; counts: Record<InstructionStatus, number> }[];
  /** 모든 지시의 최종 상태 수. */
  payouts: { PAID: number; FAILED: number; CARRIED: number; HELD: number };
  heldReasons: Record<string, number>;
  /** 실제 원천징수 합(PAID 지시) = −WITHHOLDING_TAX 잔액, 실지급 합 = −CASH 잔액. */
  withholdingKrw: string; paidNetKrw: string;
  /** PSP_CLEARING 0, CASH = −Σ PAID 실지급, WITHHOLDING_TAX = −Σ PAID 원천세, 결과 분개 수 = 끝 상태 수. */
  accountsOk: boolean;
  pspSubmits: number; pspStatusCalls: number; unknownSubmits: number;
  webhooksSent: number; webhookDuplicates: number; webhookDuplicatesIgnored: number; unprocessedWebhooks: number;
  /** 한 지시에 결과가 두 번 이상 적용된 수(결과 감사 2건 이상 또는 settled·failed 분개가 함께 있음). */
  duplicateResults: number; resultConflicts: number;
  /** PAYOUT_STUCK·PAYOUT_REF_MISMATCH 감사 수. */
  payoutAlerts: number;
  openInstructions: number; failedJobs: number;
  invariants: {
    unreflectedRefunds: number; unreflectedRevisions: number; entriesUnbalanced: number; receivableMatchesSettlement: boolean; rightsConserved: boolean;
    unpostedConfirmedRuns: number; unpostedReversals: number; poolMismatches: number; stuckRuns: number;
    /** 지급 대사(점검 API의 payouts): 멈춘 지시·결과 충돌 수, 계정 대조 셋, 오래된 미처리 webhook 수. */
    payoutStuck: number; payoutResultConflicts: number; clearingMatchesOpen: boolean; cashMatchesPaid: boolean; withholdingMatches: boolean; payoutUnprocessedWebhooks: number;
  };
  statements: number; statementIdentityFailures: number; statementClosingMismatches: number;
  statementPayoutGrossKrw: string; instructionPayoutGrossKrw: string; statementWithholdingKrw: string; instructionWithholdingKrw: string;
  releaseMs: number; payoutMs: number; resultMs: number; repayMs: number; invariantsMs: number; statementsMs: number;
  busyParty: { partyId: string; postings: number; statementMs: number };
};

/**
 * 원장·지급 통과 조건(I-2b 11.3): 점검 API의 원장 불변식·미반영 0·지급 대사(멈춘 지시·결과 충돌·미처리 webhook 0, 계정 대조 true), 명세 항등식·기말 잔액·지급 총액 대조, 계정 대조,
 * webhook 중복 무시·결과 중복 적용 0·충돌·경보 0, 열린 지시·미처리 webhook·재시도 소진 작업 0,
 * 그리고 해제·성공·실패·불명·보류·이월 경로가 실제로 지나갔을 것.
 */
export const ledgerPass = (r: LedgerReport): boolean => {
  const v = r.invariants;
  return v.unreflectedRefunds === 0 && v.unreflectedRevisions === 0 && v.entriesUnbalanced === 0 && v.receivableMatchesSettlement && v.rightsConserved &&
    v.unpostedConfirmedRuns === 0 && v.unpostedReversals === 0 && v.poolMismatches === 0 && v.stuckRuns === 0 &&
    v.payoutStuck === 0 && v.payoutResultConflicts === 0 && v.clearingMatchesOpen && v.cashMatchesPaid && v.withholdingMatches && v.payoutUnprocessedWebhooks === 0 &&
    r.statements === r.parties && r.parties > 0 && r.statementIdentityFailures === 0 && r.statementClosingMismatches === 0 &&
    r.statementPayoutGrossKrw === r.instructionPayoutGrossKrw && r.statementWithholdingKrw === r.instructionWithholdingKrw && r.accountsOk &&
    r.webhookDuplicates > 0 && r.webhookDuplicatesIgnored === r.webhookDuplicates && r.duplicateResults === 0 && r.resultConflicts === 0 && r.payoutAlerts === 0 &&
    r.openInstructions === 0 && r.unprocessedWebhooks === 0 && r.failedJobs === 0 &&
    r.released > 0 && r.payouts.PAID > 0 && r.payouts.FAILED > 0 && r.unknownSubmits > 0 && r.payouts.HELD > 0 && r.payouts.CARRIED > 0;
};

const DRAIN_MS = 30 * 60 * 1000;
/** 가짜 PSP라 실제로 기다릴 이유가 없어 poll-payout 지연을 1초로 줄인다(기본 60초면 지급 실행마다 1분씩 쉰다). */
const POLL_DELAY_SECONDS = 1;
const RELEASE_CONCURRENCY = 4;
const PERIOD_FROM = "2026-01-01T00:00:00.000Z";

/** 한 큐의 끝나지 않은 작업이 없어질 때까지 기다린다(다른 큐의 지연 작업은 기다리지 않는다). */
async function waitQueue(db: Db, name: JobName, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = (await db.pool.query(
      "SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state = ANY('{created,retry,active}'::pgboss.job_state[])", [name])).rows[0].n as number;
    if (n === 0) return;
    if (Date.now() > deadline) throw new Error(`${name} did not drain within ${timeoutMs}ms (${n} pending)`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

const count = async (db: Db, sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows[0].n as number;

/**
 * 원장·지급 시나리오(I-2b 완료 기준 11.3): runSettlementScenario(확정·post-batch·확정 후 역분개까지 끝남) 뒤에 이어서
 * 원장 반영 확인 → FRAUD_REVIEW 보류 절반을 제안대로 해제 → 권리자 프로필 → 지급 실행(가짜 PSP: 성공·실패·불명 섞음, webhook 일부 중복)
 * → 2차 지급 실행(실패 복원분 재지급, 나머지 이월) → 점검 API → 권리자별 명세 항등식을 확인한다.
 */
export async function runLedgerScenario(deps: { db: Db; ctx: BridgeCtx; appUrl: string }, opts: { seed: number }): Promise<LedgerReport> {
  const { db, ctx } = deps;
  // 정산 시나리오의 시계(2026-04-01~)보다 뒤. 프로필은 1월에 만들어 초기 보류(30일)가 끝난 상태로 둔다.
  const clock = fixedClock("2026-05-01T00:00:00.000Z", 1);
  const profileClock = fixedClock("2026-01-01T00:00:00.000Z", 0);
  const rand = mulberry32(opts.seed + 1);
  const settle = await db.tx((tx) => loadActor(tx, "usr_settle"));
  // 계좌 토큰을 등록하는 사용자는 지급 실행자(usr_settle)와 달라야 한다(ACCOUNT_SOD, 11.2-6).
  const accounts = await db.tx(async (tx) => {
    await createUser(tx, profileClock, { userId: "usr_settle2", displayName: "usr_settle2", roles: ["SPACE_SETTLE"] });
    return loadActor(tx, "usr_settle2");
  });

  // 지급 결과 계획은 프로필을 정한 뒤 채운다(가짜 PSP는 첫 submit 때 규칙을 읽는다).
  const plan = new Map<string, "FAILED" | "UNKNOWN_THEN_PAID">();
  const provider = fakeProvider({ outcome: (i) => plan.get(i.instructionId) ?? "PAID" });
  const jobs: BossJobs = await startBossJobs(deps.appUrl, { batchSize: 20, localConcurrency: 4 });
  try {
    const d = { db, ctx, clock, jobs };
    const handlers = { ...jobHandlers(d), ...payoutJobHandlers({ db, clock, jobs, provider, pollDelaySeconds: POLL_DELAY_SECONDS }), ...audioJobHandlers({ db, clock }) };
    for (const n of JOB_NAMES) if (handlers[n] === undefined) throw new Error(`missing job handler: ${n}`);
    await jobs.work(handlers as Record<JobName, JobHandler>);

    // 1. 원장 반영: post-batch는 정산 시나리오의 확정 직후 처리됐다. 남은 작업이 없음을 확인한다(점검의 unpostedConfirmedRuns로도 본다).
    await jobs.drainIdle(DRAIN_MS);

    // 2. FRAUD_REVIEW 보류 절반을 suggestFraudRelease 제안대로 해제. holding_id는 settle-run 동시 처리 순서라 비결정적이므로 (run, 이벤트) 순으로 섞는다.
    const holds = (await db.pool.query(
      `SELECT h.holding_id::text AS id FROM unallocated_holding h JOIN settlement_run r USING (run_id)
        WHERE h.line_seq = 1 AND h.reason = 'FRAUD_REVIEW' AND r.status = 'CONFIRMED' ORDER BY h.run_id, h.event_id, h.bucket`)).rows.map((r) => r.id as string);
    const targets = shuffled(rand, holds).slice(0, Math.ceil(holds.length / 2));
    const releaseSkipped: Record<string, number> = {};
    let released = 0;
    let releasedKrw = 0n;
    const t0 = performance.now();
    await inParallel(targets, RELEASE_CONCURRENCY, async (holdingId) => {
      let allocation: Record<string, string>;
      try {
        allocation = (await db.tx((tx) => suggestFraudRelease(ctx, tx, holdingId))).allocation;
      } catch (e) {
        if (!(e instanceof DomainError && e.code === "SUGGESTION_HAS_DISPUTE")) throw e;
        releaseSkipped.SUGGESTION_HAS_DISPUTE = (releaseSkipped.SUGGESTION_HAS_DISPUTE ?? 0) + 1;
        return;
      }
      if (Object.keys(allocation).length === 0) {
        releaseSkipped.EMPTY = (releaseSkipped.EMPTY ?? 0) + 1;
        return;
      }
      const r = await releaseHold(d, settle, { holdingId, allocation });
      released++;
      releasedKrw += BigInt(r.releasedKrw);
    });
    const releaseMs = performance.now() - t0;

    // 3. 권리자 프로필: 미지급금 계정이 있는 권리자를 섞어 10% KYC 미확인(개인), 10% 법인, 나머지 개인. 모두 계좌 토큰이 있다.
    const parties = shuffled(rand, (await db.pool.query("SELECT party_id FROM ledger_account WHERE kind = 'PARTY_PAYABLE' ORDER BY party_id")).rows.map((r) => r.party_id as string));
    const tenth = Math.max(1, Math.round(parties.length * 0.1));
    const kycPending = parties.slice(0, tenth);
    const corp = parties.slice(tenth, 2 * tenth);
    const individual = parties.slice(2 * tenth);
    if (individual.length < 2) throw new Error(`need at least 2 individual payees to mix payout outcomes, got ${individual.length}`);
    await db.tx(async (tx) => {
      for (const p of parties) {
        await setPayoutProfile(tx, profileClock, accounts, {
          partyId: p, taxType: corp.includes(p) ? "DOMESTIC_CORP" : "DOMESTIC_INDIVIDUAL", payoutAccountRef: `tok_${p}`, kycVerified: !kycPending.includes(p),
        });
      }
    });

    // 4. 1차 지급 실행: 개인 한 명은 PSP 실패, 한 명은 첫 전송 결과 불명(재조회로 PAID), 나머지는 PAID(결과를 시나리오가 정한다 — 금액 규칙은 권리자 몇 명으로는 거의 걸리지 않는다).
    const sortedIndividuals = [...individual].sort();
    plan.set(`po_pay-1_${sortedIndividuals[0]}`, "FAILED");
    plan.set(`po_pay-1_${sortedIndividuals[1]}`, "UNKNOWN_THEN_PAID");
    let webhooksSent = 0, webhookDuplicates = 0, webhookDuplicatesIgnored = 0;
    /** 전송된 지시마다 webhook을 보내고, 짝수 번째는 한 번 더 보낸다(두 번째는 created:false여야 한다). */
    const sendWebhooks = async (payoutRunId: string) => {
      const keys = (await db.pool.query(
        "SELECT idempotency_key FROM payout_instruction WHERE payout_run_id = $1 AND submit_attempted_at IS NOT NULL ORDER BY instruction_id", [payoutRunId])).rows.map((r) => r.idempotency_key as string);
      for (const [k, key] of keys.entries()) {
        const w = provider.webhook(key);
        const send = () => db.tx((tx) => recordWebhook(tx, clock, jobs, { ...w, payload: { source: "scenario", key } }));
        await send();
        webhooksSent++;
        if (k % 2 === 0) {
          const again = await send();
          webhooksSent++;
          webhookDuplicates++;
          if (!again.created) webhookDuplicatesIgnored++;
        }
      }
    };
    const runs: LedgerReport["runs"] = [];
    const t1 = performance.now();
    const run1 = await createPayoutRun({ db, clock, jobs }, settle, { payoutRunId: "pay-1", asOf: clock.now() });
    runs.push({ payoutRunId: run1.payoutRunId, asOf: run1.asOf, counts: run1.counts });
    await waitQueue(db, "submit-payout", DRAIN_MS);
    const payoutMs = performance.now() - t1;
    const t2 = performance.now();
    await sendWebhooks("pay-1");
    await jobs.drainIdle(DRAIN_MS);
    const resultMs = performance.now() - t2;

    // 4-1. 2차 지급 실행: 실패로 복원된 잔액만 다시 지급되고, 지급된 권리자는 잔액 0으로 이월, KYC 미확인은 계속 보류.
    const t3 = performance.now();
    const run2 = await createPayoutRun({ db, clock, jobs }, settle, { payoutRunId: "pay-2", asOf: clock.now() });
    runs.push({ payoutRunId: run2.payoutRunId, asOf: run2.asOf, counts: run2.counts });
    await waitQueue(db, "submit-payout", DRAIN_MS);
    await sendWebhooks("pay-2");
    await jobs.drainIdle(DRAIN_MS);
    const repayMs = performance.now() - t3;

    // 5. 점검 API.
    const t4 = performance.now();
    const inv = await invariants(db, clock);
    const invariantsMs = performance.now() - t4;

    // 6. 권리자별 명세: 항등식, 기말 = 실제 부채 잔액, 명세 지급 총액·원천세 합 = 지급 지시 합.
    const to = clock.now();
    const t5 = performance.now();
    const statements: Statement[] = [];
    let statementIdentityFailures = 0, statementClosingMismatches = 0;
    for (const p of [...parties].sort()) {
      const s = await db.tx((tx) => partyStatement(tx, p, PERIOD_FROM, to));
      statements.push(s);
      const n = (x: string) => BigInt(x);
      const expected = n(s.opening) + n(s.settled) + n(s.reversed) + n(s.holdReleased) + n(s.adjusted) - n(s.payoutGross) + n(s.payoutFailedRestored);
      if (expected !== n(s.closing) || s.opening !== "0" || n(s.payoutNet) + n(s.withholding) !== n(s.payoutGross)
        || n(s.netRestored) + n(s.withholdingRestored) !== n(s.payoutFailedRestored)) statementIdentityFailures++;
      const actual = -(await db.tx((tx) => balance(tx, { kind: "PARTY_PAYABLE", partyId: p }, to)));
      if (actual !== n(s.closing)) statementClosingMismatches++;
    }
    const statementsMs = performance.now() - t5;
    const busy = (await db.pool.query(
      `SELECT a.party_id, count(*)::int AS n FROM posting p JOIN ledger_account a USING (account_id)
        WHERE a.kind = 'PARTY_PAYABLE' GROUP BY a.party_id ORDER BY n DESC, a.party_id LIMIT 1`)).rows[0];
    const t6 = performance.now();
    await db.tx((tx) => partyStatement(tx, busy.party_id, PERIOD_FROM, to));
    const busyStatementMs = performance.now() - t6;
    const instr = (await db.pool.query(
      "SELECT COALESCE(SUM(gross_krw), 0)::text AS g, COALESCE(SUM(withholding_krw), 0)::text AS w FROM payout_instruction WHERE entry_id IS NOT NULL")).rows[0];
    const sum = (f: (s: Statement) => string) => statements.reduce((a, s) => a + BigInt(f(s)), 0n).toString();

    // 7. 지급 결과와 계정 대조.
    const byStatus: Record<string, number> = Object.fromEntries((await db.pool.query(
      "SELECT status, count(*)::int AS n FROM payout_instruction GROUP BY status")).rows.map((r) => [r.status as string, r.n as number]));
    const heldReasons: Record<string, number> = Object.fromEntries((await db.pool.query(
      "SELECT hold_reason, count(*)::int AS n FROM payout_instruction WHERE status = 'HELD' GROUP BY hold_reason ORDER BY hold_reason")).rows.map((r) => [r.hold_reason as string, r.n as number]));
    const paid = (await db.pool.query(
      "SELECT COALESCE(SUM(net_krw), 0)::text AS net, COALESCE(SUM(withholding_krw), 0)::text AS w FROM payout_instruction WHERE status = 'PAID'")).rows[0];
    const acct = async (kind: "PSP_CLEARING" | "CASH" | "WITHHOLDING_TAX") => db.tx((tx) => balance(tx, { kind }));
    const entriesByKind: Record<string, number> = Object.fromEntries((await db.pool.query(
      "SELECT kind, count(*)::int AS n FROM journal_entry GROUP BY kind ORDER BY kind")).rows.map((r) => [r.kind as string, r.n as number]));
    const payouts = { PAID: byStatus.PAID ?? 0, FAILED: byStatus.FAILED ?? 0, CARRIED: byStatus.CARRIED ?? 0, HELD: byStatus.HELD ?? 0 };
    const accountsOk = (await acct("PSP_CLEARING")) === 0n && (await acct("CASH")) === -BigInt(paid.net) && (await acct("WITHHOLDING_TAX")) === -BigInt(paid.w) &&
      (entriesByKind.PAYOUT_SETTLED ?? 0) === payouts.PAID && (entriesByKind.PAYOUT_FAILED ?? 0) === payouts.FAILED &&
      (entriesByKind.PAYOUT ?? 0) === payouts.PAID + payouts.FAILED;
    const duplicateResults = await count(db,
      `SELECT count(*)::int AS n FROM (SELECT entity_id FROM audit_log WHERE action_name IN ('PAYOUT_PAID','PAYOUT_FAILED') GROUP BY entity_id HAVING count(*) > 1) t`)
      + await count(db, `SELECT count(*)::int AS n FROM payout_instruction i
          WHERE EXISTS (SELECT 1 FROM journal_entry WHERE source_ref = 'settled:' || i.instruction_id) AND EXISTS (SELECT 1 FROM journal_entry WHERE source_ref = 'failed:' || i.instruction_id)`);

    return {
      entries: await count(db, "SELECT count(*)::int AS n FROM journal_entry"),
      postings: await count(db, "SELECT count(*)::int AS n FROM posting"),
      entriesByKind,
      parties: parties.length, profiles: { individual: individual.length, kycPending: kycPending.length, corp: corp.length },
      fraudHolds: holds.length, releaseAttempted: targets.length, released, releasedKrw: releasedKrw.toString(), releaseSkipped,
      runs, payouts, heldReasons, withholdingKrw: paid.w, paidNetKrw: paid.net, accountsOk,
      pspSubmits: provider.calls.filter((c) => c.op === "submit").length, pspStatusCalls: provider.calls.filter((c) => c.op === "status").length,
      unknownSubmits: await count(db, "SELECT count(*)::int AS n FROM audit_log WHERE action_name = 'PAYOUT_SUBMIT_UNKNOWN'"),
      webhooksSent, webhookDuplicates, webhookDuplicatesIgnored,
      unprocessedWebhooks: await count(db, "SELECT count(*)::int AS n FROM psp_webhook_inbox WHERE processed_at IS NULL"),
      duplicateResults,
      resultConflicts: await count(db, "SELECT count(*)::int AS n FROM audit_log WHERE action_name = 'PAYOUT_RESULT_CONFLICT'"),
      payoutAlerts: await count(db, "SELECT count(*)::int AS n FROM audit_log WHERE action_name IN ('PAYOUT_STUCK','PAYOUT_REF_MISMATCH')"),
      openInstructions: await count(db, "SELECT count(*)::int AS n FROM payout_instruction WHERE status IN ('PENDING','SUBMITTED')"),
      failedJobs: await count(db, "SELECT count(*)::int AS n FROM pgboss.job WHERE name = ANY($1) AND state = 'failed'", [[...JOB_NAMES]]),
      invariants: {
        unreflectedRefunds: inv.unreflectedRefunds.length, unreflectedRevisions: inv.unreflectedRevisions.length,
        entriesUnbalanced: inv.ledger.entriesUnbalanced, receivableMatchesSettlement: inv.ledger.receivableMatchesSettlement, rightsConserved: inv.ledger.rightsConserved,
        unpostedConfirmedRuns: inv.ledger.unpostedConfirmedRuns.length, unpostedReversals: inv.ledger.unpostedReversals.length,
        poolMismatches: inv.ledger.poolMismatches.length, stuckRuns: inv.stuckRuns.length,
        payoutStuck: inv.payouts.stuck.length, payoutResultConflicts: inv.payouts.resultConflicts.length,
        clearingMatchesOpen: inv.payouts.clearingMatchesOpen, cashMatchesPaid: inv.payouts.cashMatchesPaid, withholdingMatches: inv.payouts.withholdingMatches,
        payoutUnprocessedWebhooks: inv.payouts.unprocessedWebhooks,
      },
      statements: statements.length, statementIdentityFailures, statementClosingMismatches,
      statementPayoutGrossKrw: sum((s) => s.payoutGross), instructionPayoutGrossKrw: instr.g,
      statementWithholdingKrw: sum((s) => s.withholding), instructionWithholdingKrw: instr.w,
      releaseMs, payoutMs, resultMs, repayMs, invariantsMs, statementsMs,
      busyParty: { partyId: busy.party_id, postings: busy.n, statementMs: busyStatementMs },
    };
  } finally {
    await jobs.stop();
  }
}
