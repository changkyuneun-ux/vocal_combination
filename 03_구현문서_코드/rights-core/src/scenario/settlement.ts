import { performance } from "node:perf_hooks";
import { createUser, ensureSystemIdentities, loadActor } from "../platform/actor.ts";
import { fixedClock } from "../platform/clock.ts";
import type { Db } from "../platform/db.ts";
import { startBossJobs, JOB_NAMES, type JobHandler, type JobName } from "../platform/jobs.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { ingestRevenue, type RevenueInput } from "../revenue/service.ts";
import { confirmBatch, createBatch, refundHook } from "../settlement/service.ts";
import { jobHandlers } from "../settlement/handlers.ts";
import { mulberry32 } from "./prng.ts";

export type SettlementReport = {
  purchases: number; refundsPre: number; refundsPost: number; runs: number; verified: number;
  /** FAILED run 수와 진단 코드별 run 수(한 멤버가 모든 슬롯을 부른 조합은 performer cap(50%) 때문에 ALLOC_INFEASIBLE). */
  failedRuns: number; failedReasons: Record<string, number>;
  ingestMs: number; batchMs: number; settleMs: number; reverseMs: number;
  conservationOk: boolean; verifyMismatches: number; reversals: number; reversalNetZeroOk: boolean;
  /** 정산액 초과로 거부된 역분개(REVERSAL_REJECTED 감사) 수. 0이어야 한다. */
  reversalRejected: number;
  /** 재시도를 모두 소진해 failed 상태로 끝난 pg-boss 작업 수. 0이어야 한다. */
  failedJobs: number;
};

const BATCH = "bat_2026_03";
const PERIOD_START = "2026-03-01T00:00:00.000Z";
const PERIOD_END = "2026-04-01T00:00:00.000Z";
const DRAIN_MS = 30 * 60 * 1000;
const INGEST_CONCURRENCY = 8;

/** items를 동시에 최대 limit개씩 처리한다(순서는 보장하지 않는다). */
async function inParallel<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** 시드 난수로 섞은 사본(Fisher–Yates). */
function shuffled<T>(rand: () => number, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 1 이상 max 미만의 정수(부분 환불 금액). max ≥ 2여야 한다. */
const partOf = (rand: () => number, max: bigint) => 1n + BigInt(Math.floor(rand() * Number(max - 1n)));

/**
 * 정산 시나리오(I-2a 완료 기준): runScenario가 발행한 조합에 매출을 넣고, 배치 전 환불 → 배치 생성 → 실제 pg-boss로
 * 정산·검증 → 보존식 확인 → 확정 → 확정 후 환불(역분개) → 전액 환불 순합 0을 확인한다.
 */
export async function runSettlementScenario(deps: { db: Db; ctx: BridgeCtx; appUrl: string }, opts: { purchases: number; seed: number }): Promise<SettlementReport> {
  const { db, ctx } = deps;
  const base = fixedClock("2026-01-01T00:00:00.000Z", 0);
  const clock = fixedClock("2026-04-01T00:00:00.000Z", 1);
  const u = await db.tx(async (tx) => {
    for (const [id, role] of [["usr_ops", "SPACE_OPS"], ["usr_settle", "SPACE_SETTLE"]] as const) {
      await createUser(tx, base, { userId: id, displayName: id, roles: [role] });
    }
    await ensureSystemIdentities(tx, base);
    return { ops: await loadActor(tx, "usr_ops"), settle: await loadActor(tx, "usr_settle"), ingest: await loadActor(tx, "sys_ingest") };
  });

  const jobs = await startBossJobs(deps.appUrl, { batchSize: 20, localConcurrency: 4 });
  try {
    const d = { db, ctx, clock, jobs };
    const handlers = jobHandlers(d);
    for (const n of JOB_NAMES) if (handlers[n] === undefined) throw new Error(`missing job handler: ${n}`);
    await jobs.work(handlers as Record<JobName, JobHandler>);
    const onRefund = refundHook(jobs);
    const ingest = (input: RevenueInput) => db.tx((tx) => ingestRevenue(tx, clock, u.ingest, input, onRefund)).then(() => {});

    // 2. 매출: 발행 봉인이 있는 조합에서 시드 난수로 고른다(ALLOC_INFEASIBLE 조합도 거르지 않는다).
    const rand = mulberry32(opts.seed);
    const vcIds = (await db.pool.query("SELECT rs.vc_id FROM rights_snapshot rs JOIN issue_seal s ON s.snapshot_id = rs.snapshot_id ORDER BY rs.vc_id"))
      .rows.map((r) => r.vc_id as string);
    if (vcIds.length === 0) throw new Error("no issued combinations — run runScenario first");
    const span = Date.parse(PERIOD_END) - Date.parse(PERIOD_START);
    const purchases = Array.from({ length: opts.purchases }, (_, i) => ({
      eventId: `ev_p_${String(i).padStart(6, "0")}`,
      vcId: vcIds[Math.floor(rand() * vcIds.length)]!,
      amount: BigInt(1000 + Math.floor(rand() * 49001)),
      occurredAt: new Date(Date.parse(PERIOD_START) + Math.floor((i * span) / opts.purchases)).toISOString(),
      integrity: rand() < 0.01 ? "FLAGGED" as const : "CLEAR" as const,
    }));
    const t0 = performance.now();
    await inParallel(purchases, INGEST_CONCURRENCY, (p) => ingest({
      eventId: p.eventId, sourceSystem: "app", sourceEventId: p.eventId, eventType: "PURCHASE", vcId: p.vcId,
      amountKrw: p.amount.toString(), currency: "KRW", integrity: p.integrity, occurredAt: p.occurredAt,
    }));

    // 3. 배치 전 환불: 구매의 5%, 원 금액의 1~100%(약 30%는 전액).
    const pre = shuffled(rand, purchases).slice(0, Math.max(1, Math.round(opts.purchases * 0.05))).map((p, k) => ({
      p, k, amount: rand() < 0.3 ? p.amount : partOf(rand, p.amount),
    }));
    await inParallel(pre, INGEST_CONCURRENCY, ({ p, k, amount }) => ingest({
      eventId: `ev_rf_${String(k).padStart(6, "0")}`, sourceSystem: "app", sourceEventId: `ev_rf_${String(k).padStart(6, "0")}`, eventType: "REFUND",
      relatedEventId: p.eventId, amountKrw: amount.toString(), currency: "KRW", occurredAt: new Date(Date.parse(p.occurredAt) + 1).toISOString(),
    }));
    await jobs.drainIdle(DRAIN_MS);
    const ingestMs = performance.now() - t0;

    // 4. 배치 생성과 정산·검증 처리.
    const t1 = performance.now();
    await createBatch(d, u.ops, { batchId: BATCH, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    const batchMs = performance.now() - t1;
    const t2 = performance.now();
    await jobs.drainIdle(DRAIN_MS);
    const settleMs = performance.now() - t2;

    // 5. run 상태·검증 불일치.
    const statuses = (await db.pool.query("SELECT status, count(*)::int AS n FROM settlement_run WHERE batch_id = $1 GROUP BY status", [BATCH])).rows;
    const byStatus = Object.fromEntries(statuses.map((r) => [r.status as string, r.n as number]));
    const runs = statuses.reduce((a, r) => a + (r.n as number), 0);
    const verified = byStatus.VERIFIED ?? 0;
    const failedRuns = byStatus.FAILED ?? 0;
    const failedReasons: Record<string, number> = {};
    for (const r of (await db.pool.query(
      `SELECT c.code, count(DISTINCT r.run_id)::int AS n FROM settlement_run r, jsonb_array_elements(r.diagnostics) x, LATERAL (SELECT x->>'code' AS code) c
        WHERE r.batch_id = $1 AND r.status = 'FAILED' GROUP BY c.code ORDER BY c.code`, [BATCH],
    )).rows) failedReasons[r.code as string] = r.n as number;
    const verifyMismatches = (await db.pool.query(
      `SELECT count(*)::int AS n FROM settlement_run r WHERE r.batch_id = $1 AND r.status = 'VOIDED'
          AND EXISTS (SELECT 1 FROM audit_log a WHERE a.action_name = 'RUN_VERIFY_MISMATCH' AND a.entity_type = 'settlement_run' AND a.entity_id = r.run_id)`, [BATCH],
    )).rows[0].n as number;

    // 6. 보존식(확정 전, 살아 있는 run의 이벤트별): 풀 합 = 순매출, 권리 풀 = 배분 라인 + 보류.
    const conservationBad = (await db.pool.query(
      `WITH ev AS (
         SELECT x.run_id, x.event_id, x.net_amount_krw AS net FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id
          WHERE r.batch_id = $1 AND r.status IN ('CALCULATED','VERIFIED')),
       pool AS (SELECT run_id, event_id, SUM(amount_krw) AS total, SUM(amount_krw) FILTER (WHERE bucket = 'rights') AS rights
                  FROM pool_line WHERE line_seq = 1 GROUP BY run_id, event_id),
       lines AS (SELECT run_id, event_id, SUM(amount_krw) AS s FROM allocation_line WHERE line_seq = 1 GROUP BY run_id, event_id),
       held AS (SELECT run_id, event_id, SUM(amount_krw) AS s FROM unallocated_holding WHERE line_seq = 1 GROUP BY run_id, event_id)
       SELECT count(*)::int AS n FROM ev
         LEFT JOIN pool p USING (run_id, event_id) LEFT JOIN lines l USING (run_id, event_id) LEFT JOIN held h USING (run_id, event_id)
        WHERE COALESCE(p.total, 0) <> ev.net OR p.rights IS NULL OR p.rights <> COALESCE(l.s, 0) + COALESCE(h.s, 0)`, [BATCH],
    )).rows[0].n as number;
    const checkedEvents = (await db.pool.query(
      "SELECT count(*)::int AS n FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id WHERE r.batch_id = $1 AND r.status IN ('CALCULATED','VERIFIED')", [BATCH],
    )).rows[0].n as number;
    const conservationOk = conservationBad === 0 && checkedEvents > 0;

    // 7. 확정(생성자 usr_ops와 다른 usr_settle).
    await confirmBatch(d, u.settle, BATCH);

    // 8. 확정 후 환불: 확정된 이벤트의 3%. 절반은 남은 순액 전부를 두 번에 나눠, 나머지는 한 번 부분 환불.
    const confirmed = (await db.pool.query(
      `SELECT x.event_id, x.net_amount_krw::text AS net FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id
        WHERE r.batch_id = $1 AND r.status = 'CONFIRMED' AND x.active ORDER BY x.event_id`, [BATCH],
    )).rows.map((r) => ({ eventId: r.event_id as string, net: BigInt(r.net) }));
    const chosen = shuffled(rand, confirmed).slice(0, Math.max(2, Math.round(confirmed.length * 0.03)));
    const plans = chosen.map((e, k) => {
      const full = k % 2 === 0;
      const parts = !full ? [e.net < 2n ? e.net : partOf(rand, e.net)] : e.net < 2n ? [e.net] : (() => { const a = partOf(rand, e.net); return [a, e.net - a]; })();
      return { eventId: e.eventId, full: full || parts[0] === e.net, parts, k };
    });
    const t3 = performance.now();
    let refundsPost = 0;
    await inParallel(plans, INGEST_CONCURRENCY, async (plan) => {
      for (const [j, amount] of plan.parts.entries()) {
        const id = `ev_rp_${String(plan.k).padStart(6, "0")}_${j + 1}`;
        await ingest({ eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "REFUND", relatedEventId: plan.eventId, amountKrw: amount.toString(), currency: "KRW", occurredAt: "2026-04-15T00:00:00.000Z" });
        refundsPost++;
      }
    });
    await jobs.drainIdle(DRAIN_MS);
    const reverseMs = performance.now() - t3;
    const reversals = (await db.pool.query("SELECT count(*)::int AS n FROM reversal_run r JOIN settlement_run s ON s.run_id = r.original_run_id WHERE s.batch_id = $1", [BATCH])).rows[0].n as number;
    const reversalRejected = (await db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action_name = 'REVERSAL_REJECTED'")).rows[0].n as number;

    // 9. 전액 환불된 이벤트: 확정 run의 풀·배분·보류 순합이 모두 0.
    const fullIds = plans.filter((p) => p.full).map((p) => p.eventId);
    const netNonZero = (await db.pool.query(
      `WITH ev AS (SELECT x.run_id, x.event_id FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id
                    WHERE r.batch_id = $1 AND r.status = 'CONFIRMED' AND x.event_id = ANY($2))
       SELECT count(*)::int AS n FROM ev
        WHERE (SELECT COALESCE(SUM(amount_krw), 0) FROM pool_line p WHERE p.run_id = ev.run_id AND p.event_id = ev.event_id) <> 0
           OR (SELECT COALESCE(SUM(amount_krw), 0) FROM allocation_line l WHERE l.run_id = ev.run_id AND l.event_id = ev.event_id) <> 0
           OR (SELECT COALESCE(SUM(amount_krw), 0) FROM unallocated_holding h WHERE h.run_id = ev.run_id AND h.event_id = ev.event_id) <> 0
           OR NOT EXISTS (SELECT 1 FROM reversal_run v WHERE v.original_run_id = ev.run_id AND v.event_id = ev.event_id)`,
      [BATCH, fullIds],
    )).rows[0].n as number;
    const fullFound = (await db.pool.query(
      "SELECT count(*)::int AS n FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id WHERE r.batch_id = $1 AND r.status = 'CONFIRMED' AND x.event_id = ANY($2)",
      [BATCH, fullIds],
    )).rows[0].n as number;
    const reversalNetZeroOk = fullIds.length > 0 && fullFound === fullIds.length && netNonZero === 0;
    const failedJobs = (await db.pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = ANY($1) AND state = 'failed'", [[...JOB_NAMES]])).rows[0].n as number;

    return {
      purchases: purchases.length, refundsPre: pre.length, refundsPost, runs, verified, failedRuns, failedReasons,
      ingestMs, batchMs, settleMs, reverseMs, conservationOk, verifyMismatches, reversals, reversalNetZeroOk, reversalRejected, failedJobs,
    };
  } finally {
    await jobs.stop();
  }
}
