import type { Clock } from "../platform/clock.ts";
import type { Db, Tx } from "../platform/db.ts";
import { invalid } from "../platform/errors.ts";
import { reconcilePayouts, type PayoutReconciliation } from "../payout/reconcile.ts";

export type InvariantReport = {
  /** rejected: REVERSAL_REJECTED 감사가 있다(역분개가 거부됨 — 작업 유실과 구분). */
  unreflectedRefunds: { refundEventId: string; originalEventId: string; runId: string; rejected: boolean }[];
  /**
   * 반영되지 않은 대체(11.2-11): 이전 revision이 살아 있는 CONFIRMED run에 남은 정산액 > 0으로 있는데 새 revision id의 CORRECTION 역분개가 없다.
   * rejected: CORRECTION_REJECTED 감사가 있다(역분개가 거부됨 — 작업 유실·대기와 구분).
   */
  unreflectedRevisions: { newEventId: string; oldEventId: string; runId: string; remaining: string; rejected: boolean }[];
  ledger: {
    entriesUnbalanced: number; receivableMatchesSettlement: boolean; rightsConserved: boolean;
    /** CONFIRMED인데 아직 SETTLEMENT 분개(run:<id>)가 없는 run(post-batch 대기). 실패가 아니라 따로 보고한다. */
    unpostedConfirmedRuns: string[];
    /** REVERSAL 분개(rev:<id>)가 없는 역분개. 역분개와 분개는 한 트랜잭션에서 쓰이므로 비어 있어야 한다. */
    unpostedReversals: string[];
    /**
     * 정산 행 자체의 풀 합 검사(RECEIVABLE 대조의 독립 근거): 분개된 run마다 Σ run 이벤트 순액 = Σ 풀 라인(line_seq = 1),
     * 분개된 역분개마다 Σ 풀 라인 = −(식별 환불 이벤트 금액), CORRECTION(식별 이벤트가 새 revision)이면 −(남은 정산액 전액). 어긋난 것만 나열한다.
     */
    poolMismatches: { kind: "RUN" | "REVERSAL"; id: string; expected: string; actual: string }[];
    /** 비교한 양쪽 값(진단용): RECEIVABLE 잔액과 정산 쪽 합, 권리 쪽 계정 전기 합과 −(권리 풀 라인 합). */
    receivable: string; settledReceivable: string; rightsBalance: string; rightsPooled: string;
  };
  stuckRuns: { runId: string; status: string; since: string }[];
  /** 지급 대사(src/payout/reconcile.ts). 정상 흐름에서 stuck·resultConflicts는 비고, 대조 셋은 true, unprocessedWebhooks는 0이다. */
  payouts: PayoutReconciliation;
};

export const DEFAULT_STUCK_AFTER_MINUTES = 60;

/** run의 권리 풀 버킷(발행 봉인의 정책 tier1.rights). */
const RUN_RIGHTS = `SELECT r.run_id, d.content->'body'->'tier1'->>'rights' AS rights
  FROM settlement_run r JOIN issue_seal s ON s.snapshot_id = r.snapshot_id JOIN sealed_document d ON d.digest = s.policy_digest`;

/**
 * 정산·원장 점검(통합 설계 11.2-10). 원장은 보류 해제·지급 뒤 정산 행의 거울이 아니므로 모든 정상 상태에서 성립하는 식으로 본다.
 * (a) 반영되지 않은 환불: 원 이벤트가 살아 있는 CONFIRMED run에 있는데 그 run 이벤트의 포함 환불에도, 역분개에도 없는 환불.
 *     반영되지 않은 대체: 이전 revision이 살아 있는 CONFIRMED run에 남은 정산액 > 0으로 있는데 새 revision의 CORRECTION 역분개가 없다.
 * (b) 원장:
 *   - entriesUnbalanced: 전기 합 ≠ 0인 분개 수(0이어야 한다 — 트리거의 rc.bal_last 우회도 여기서 잡힌다).
 *   - receivableMatchesSettlement: RECEIVABLE 잔액 = Σ(분개된 run의 run 이벤트 순액) + Σ(분개된 역분개의 풀 라인 합, 음수).
 *     분개된 run = run:<id> 분개가 있는 run, 분개된 역분개 = rev:<id> 분개가 있는 역분개. 분개 전 CONFIRMED run은 unpostedConfirmedRuns.
 *   - rightsConserved: 권리 쪽 계정(PARTY_PAYABLE·HOLD·WITHHOLDING_TAX·PSP_CLEARING·CASH) 전기 합
 *     = −(분개된 run의 권리 버킷 풀 라인(line_seq = 1) 합 + 분개된 역분개의 권리 버킷 풀 라인 합). 권리 풀로 들어온 돈은
 *     해제·지급·실패·정산으로 이 계정들 사이에서만 움직인다. 양쪽을 원장과 정산 행에서 따로 계산한다.
 * (c) 오래 멈춘 run: PENDING·CALCULATED 중 created_at이 now − stuckAfterMinutes(기본 60)보다 이른 것.
 * (d) 지급 대사(reconcilePayouts, 같은 기준 시각): 멈춘 지시(열린 지시의 전송 표식이 기준보다 이르거나 PAYOUT_STUCK), 결과 충돌(PAYOUT_RESULT_CONFLICT),
 *     −PSP_CLEARING = Σ 열린 지시 실지급액, −CASH = Σ PAID 실지급액, −WITHHOLDING_TAX = Σ FAILED가 아닌 분개된 지시의 원천세, 오래된 미처리 webhook 수.
 * 여러 쿼리가 한 시점을 보도록 invariants는 자기 REPEATABLE READ READ ONLY 트랜잭션을 연다.
 */
export async function invariants(db: Db, clock: Clock, opts: { stuckAfterMinutes?: number } = {}): Promise<InvariantReport> {
  const cutoff = stuckCutoff(clock, opts);
  const client = await db.pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const r = await invariantsAt(client, cutoff);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch((re: Error) => { broken = re; });
    throw e;
  } finally {
    client.release(broken);
  }
}

/**
 * 호출자 트랜잭션에서 점검한다(호출자가 스냅샷 일관성을 책임진다 — REPEATABLE READ 권장). 테스트는 롤백할 트랜잭션 안의
 * 인위적 상태를 이것으로 본다.
 */
export async function invariantsInTx(tx: Tx, clock: Clock, opts: { stuckAfterMinutes?: number } = {}): Promise<InvariantReport> {
  return invariantsAt(tx, stuckCutoff(clock, opts));
}

function stuckCutoff(clock: Clock, opts: { stuckAfterMinutes?: number }): string {
  const minutes = opts.stuckAfterMinutes ?? DEFAULT_STUCK_AFTER_MINUTES;
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw invalid("INVALID_THRESHOLD", "stuckAfterMinutes must be a positive integer");
  return new Date(Date.parse(clock.now()) - minutes * 60_000).toISOString();
}

async function invariantsAt(tx: Tx, cutoff: string): Promise<InvariantReport> {
  const unreflected = (await tx.query(
    `SELECT r.event_id AS refund, r.related_event_id AS original, x.run_id,
            EXISTS (SELECT 1 FROM audit_log a WHERE a.action_name = 'REVERSAL_REJECTED' AND a.entity_type = 'revenue_event' AND a.entity_id = r.event_id) AS rejected
       FROM revenue_event r
       JOIN settlement_run_event x ON x.event_id = r.related_event_id AND x.active
       JOIN settlement_run s ON s.run_id = x.run_id AND s.status = 'CONFIRMED'
      WHERE r.event_type = 'REFUND'
        AND NOT EXISTS (SELECT 1 FROM settlement_run_event_refund f WHERE f.run_id = x.run_id AND f.event_id = x.event_id AND f.refund_event_id = r.event_id)
        AND NOT EXISTS (SELECT 1 FROM reversal_run v WHERE v.refund_event_id = r.event_id)
      ORDER BY r.event_id`)).rows.map((x) => ({ refundEventId: x.refund as string, originalEventId: x.original as string, runId: x.run_id as string, rejected: x.rejected as boolean }));

  const unreflectedRev = (await tx.query(
    `SELECT t.* FROM (
       SELECT sp.new_event_id, sp.old_event_id, x.run_id,
              x.net_amount_krw + COALESCE((SELECT SUM(pl.amount_krw) FROM pool_line pl
                WHERE pl.run_id = x.run_id AND pl.event_id = x.event_id AND pl.reversal_id IS NOT NULL), 0) AS remaining,
              EXISTS (SELECT 1 FROM audit_log a WHERE a.action_name = 'CORRECTION_REJECTED' AND a.entity_type = 'revenue_event' AND a.entity_id = sp.new_event_id) AS rejected
         FROM revenue_supersede sp
         JOIN settlement_run_event x ON x.event_id = sp.old_event_id AND x.active
         JOIN settlement_run s ON s.run_id = x.run_id AND s.status = 'CONFIRMED'
        WHERE NOT EXISTS (SELECT 1 FROM reversal_run v WHERE v.refund_event_id = sp.new_event_id)
     ) t WHERE t.remaining > 0 ORDER BY t.new_event_id`)).rows.map((x) => ({
    newEventId: x.new_event_id as string, oldEventId: x.old_event_id as string, runId: x.run_id as string, remaining: String(x.remaining), rejected: x.rejected as boolean,
  }));

  const unbalanced = (await tx.query(
    "SELECT count(*)::int AS n FROM (SELECT entry_id FROM posting GROUP BY entry_id HAVING SUM(amount_krw) <> 0) t")).rows[0].n as number;

  const unposted = (await tx.query(
    `SELECT run_id FROM settlement_run r WHERE r.status = 'CONFIRMED'
        AND NOT EXISTS (SELECT 1 FROM journal_entry j WHERE j.source_ref = 'run:' || r.run_id) ORDER BY run_id`)).rows.map((x) => x.run_id as string);

  const unpostedRev = (await tx.query(
    `SELECT reversal_id FROM reversal_run v
      WHERE NOT EXISTS (SELECT 1 FROM journal_entry j WHERE j.source_ref = 'rev:' || v.reversal_id) ORDER BY reversal_id`)).rows.map((x) => x.reversal_id as string);

  // 역분개의 기대 풀 합은 사유별로 다르다. 식별 이벤트가 환불이면(REFUND) 환불 금액의 음수다(reverse-event는 환불 금액 그대로
  // 역분개하고, 초과면 거부한다). 식별 이벤트가 새 revision이면(CORRECTION, 11.2-11) 이전 revision의 남은 정산액 전액이므로
  // −(원 run 이벤트 순액 + 그 이벤트의 앞선(sequence가 작은) 역분개 풀 합)이다.
  const mismatches = (await tx.query(
    `WITH posted_run AS (
       SELECT r.run_id FROM settlement_run r WHERE EXISTS (SELECT 1 FROM journal_entry j WHERE j.source_ref = 'run:' || r.run_id)
     )
     SELECT 'RUN' AS kind, p.run_id AS id, n.net::text AS expected, COALESCE(l.pool, 0)::text AS actual
       FROM posted_run p
       JOIN (SELECT run_id, SUM(net_amount_krw) AS net FROM settlement_run_event GROUP BY run_id) n USING (run_id)
       LEFT JOIN (SELECT run_id, SUM(amount_krw) AS pool FROM pool_line WHERE line_seq = 1 GROUP BY run_id) l USING (run_id)
      WHERE n.net <> COALESCE(l.pool, 0)
     UNION ALL
     SELECT 'REVERSAL', t.reversal_id, t.expected::text, t.actual::text FROM (
       SELECT v.reversal_id, COALESCE(l.pool, 0) AS actual,
              CASE WHEN e.event_type = 'REFUND' THEN -e.net_amount_krw
                   ELSE -(x.net_amount_krw + COALESCE((SELECT SUM(pl.amount_krw) FROM pool_line pl JOIN reversal_run pv ON pv.reversal_id = pl.reversal_id
                            WHERE pv.original_run_id = v.original_run_id AND pv.event_id = v.event_id AND pv.sequence < v.sequence), 0)) END AS expected
         FROM reversal_run v JOIN revenue_event e ON e.event_id = v.refund_event_id
         JOIN settlement_run_event x ON x.run_id = v.original_run_id AND x.event_id = v.event_id
         LEFT JOIN (SELECT reversal_id, SUM(amount_krw) AS pool FROM pool_line WHERE reversal_id IS NOT NULL GROUP BY reversal_id) l USING (reversal_id)
        WHERE EXISTS (SELECT 1 FROM journal_entry j WHERE j.source_ref = 'rev:' || v.reversal_id)
     ) t WHERE t.expected <> t.actual
     ORDER BY 1, 2`)).rows.map((x) => ({ kind: x.kind as "RUN" | "REVERSAL", id: x.id as string, expected: x.expected as string, actual: x.actual as string }));

  const ledgerSide = (await tx.query(
    `SELECT COALESCE(SUM(p.amount_krw) FILTER (WHERE a.kind = 'RECEIVABLE'), 0)::text AS receivable,
            COALESCE(SUM(p.amount_krw) FILTER (WHERE a.kind IN ('PARTY_PAYABLE','HOLD','WITHHOLDING_TAX','PSP_CLEARING','CASH')), 0)::text AS rights
       FROM posting p JOIN ledger_account a USING (account_id)`)).rows[0];

  const settlementSide = (await tx.query(
    `WITH posted_run AS (
       SELECT r.run_id FROM settlement_run r WHERE EXISTS (SELECT 1 FROM journal_entry j WHERE j.source_ref = 'run:' || r.run_id)
     ), posted_rev AS (
       SELECT v.reversal_id, v.original_run_id AS run_id FROM reversal_run v WHERE EXISTS (SELECT 1 FROM journal_entry j WHERE j.source_ref = 'rev:' || v.reversal_id)
     ), run_rights AS (${RUN_RIGHTS} WHERE r.run_id IN (SELECT run_id FROM posted_run UNION SELECT run_id FROM posted_rev))
     SELECT
       ((SELECT COALESCE(SUM(x.net_amount_krw), 0) FROM settlement_run_event x JOIN posted_run USING (run_id))
        + (SELECT COALESCE(SUM(l.amount_krw), 0) FROM pool_line l JOIN posted_rev USING (reversal_id)))::text AS receivable,
       (-((SELECT COALESCE(SUM(l.amount_krw), 0) FROM pool_line l JOIN posted_run USING (run_id) JOIN run_rights rr USING (run_id)
            WHERE l.line_seq = 1 AND l.bucket = rr.rights)
        + (SELECT COALESCE(SUM(l.amount_krw), 0) FROM pool_line l JOIN posted_rev v USING (reversal_id) JOIN run_rights rr ON rr.run_id = v.run_id
            WHERE l.bucket = rr.rights)))::text AS rights`)).rows[0];

  const stuck = (await tx.query(
    `SELECT run_id, status, created_at FROM settlement_run WHERE status IN ('PENDING','CALCULATED') AND created_at < $1 ORDER BY created_at, run_id`,
    [cutoff])).rows.map((x) => ({ runId: x.run_id as string, status: x.status as string, since: (x.created_at as Date).toISOString() }));

  return {
    unreflectedRefunds: unreflected,
    unreflectedRevisions: unreflectedRev,
    ledger: {
      entriesUnbalanced: unbalanced,
      receivableMatchesSettlement: ledgerSide.receivable === settlementSide.receivable,
      rightsConserved: ledgerSide.rights === settlementSide.rights,
      unpostedConfirmedRuns: unposted,
      unpostedReversals: unpostedRev,
      poolMismatches: mismatches,
      receivable: ledgerSide.receivable, settledReceivable: settlementSide.receivable,
      rightsBalance: ledgerSide.rights, rightsPooled: settlementSide.rights,
    },
    stuckRuns: stuck,
    payouts: await reconcilePayouts(tx, cutoff),
  };
}
