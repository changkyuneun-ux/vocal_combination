import type { Tx } from "../platform/db.ts";

export type PayoutReconciliation = {
  /**
   * 멈춘 지시: PENDING은 전송 표식(없으면 생성 시각)이 cutoffs.pending보다, SUBMITTED는 전송 표식이 cutoffs.submitted보다 이른 것,
   * 또는 PAYOUT_STUCK 감사가 있는 열린 지시. since = 전송 표식(없으면 생성 시각).
   */
  stuck: { instructionId: string; since: string }[];
  /** PAYOUT_RESULT_CONFLICT 감사가 있는 지시(예: FAILED로 끝난 뒤 PAID 결과 — 이중 지급 위험, 운영자 확인). */
  resultConflicts: { instructionId: string }[];
  /** −PSP_CLEARING 잔액 = Σ 실지급액(PAYOUT 분개가 있는 PENDING·SUBMITTED 지시). */
  clearingMatchesOpen: boolean;
  /** −CASH 잔액 = Σ 실지급액(PAID 지시). */
  cashMatchesPaid: boolean;
  /** −WITHHOLDING_TAX 잔액 = Σ 원천세(PAYOUT 분개가 있고 FAILED가 아닌 지시). */
  withholdingMatches: boolean;
  /** 처리되지 않은(processed_at NULL) webhook 중 받은 시각이 기준 시각보다 이른 것의 수. */
  unprocessedWebhooks: number;
  /** 비교한 양쪽 값(진단용, 원). */
  amounts: { clearing: string; openNet: string; cash: string; paidNet: string; withholding: string; withheld: string };
};

/**
 * 지급 대사(통합 설계 11.2-10 (d)): 지급 지시와 PSP_CLEARING·CASH·WITHHOLDING_TAX 계정을 대조하고, 멈춘 지시·결과 충돌·미처리 webhook을 찾는다.
 * 기준 시각(ms UTC ISO): pending은 PENDING 지시와 미처리 webhook, submitted는 SUBMITTED 지시(PSP 처리 대기라 더 길게 둔다).
 * 호출자 트랜잭션에서 읽는다(settlement/invariants가 자기 스냅샷 안에서 부른다).
 */
export async function reconcilePayouts(tx: Tx, cutoffs: { pending: string; submitted: string }): Promise<PayoutReconciliation> {
  const stuck = (await tx.query(
    `SELECT i.instruction_id, COALESCE(i.submit_attempted_at, i.created_at) AS since
       FROM payout_instruction i
      WHERE i.status IN ('PENDING','SUBMITTED')
        AND ((i.status = 'PENDING' AND COALESCE(i.submit_attempted_at, i.created_at) < $1)
             OR (i.status = 'SUBMITTED' AND i.submit_attempted_at < $2)
             OR EXISTS (SELECT 1 FROM audit_log a WHERE a.action_name = 'PAYOUT_STUCK' AND a.entity_type = 'payout_instruction' AND a.entity_id = i.instruction_id))
      ORDER BY 2, 1`, [cutoffs.pending, cutoffs.submitted])).rows.map((x) => ({ instructionId: x.instruction_id as string, since: (x.since as Date).toISOString() }));

  const conflicts = (await tx.query(
    `SELECT DISTINCT entity_id FROM audit_log WHERE action_name = 'PAYOUT_RESULT_CONFLICT' AND entity_type = 'payout_instruction' ORDER BY entity_id`))
    .rows.map((x) => ({ instructionId: x.entity_id as string }));

  const acct = (await tx.query(
    `SELECT COALESCE(-SUM(p.amount_krw) FILTER (WHERE a.kind = 'PSP_CLEARING'), 0)::text AS clearing,
            COALESCE(-SUM(p.amount_krw) FILTER (WHERE a.kind = 'CASH'), 0)::text AS cash,
            COALESCE(-SUM(p.amount_krw) FILTER (WHERE a.kind = 'WITHHOLDING_TAX'), 0)::text AS withholding
       FROM posting p JOIN ledger_account a USING (account_id) WHERE a.kind IN ('PSP_CLEARING','CASH','WITHHOLDING_TAX')`)).rows[0];
  const instr = (await tx.query(
    `SELECT COALESCE(SUM(net_krw) FILTER (WHERE status IN ('PENDING','SUBMITTED') AND entry_id IS NOT NULL), 0)::text AS open_net,
            COALESCE(SUM(net_krw) FILTER (WHERE status = 'PAID'), 0)::text AS paid_net,
            COALESCE(SUM(withholding_krw) FILTER (WHERE entry_id IS NOT NULL AND status <> 'FAILED'), 0)::text AS withheld
       FROM payout_instruction`)).rows[0];

  const unprocessed = (await tx.query(
    "SELECT count(*)::int AS n FROM psp_webhook_inbox WHERE processed_at IS NULL AND received_at < $1", [cutoffs.pending])).rows[0].n as number;

  return {
    stuck, resultConflicts: conflicts,
    clearingMatchesOpen: acct.clearing === instr.open_net,
    cashMatchesPaid: acct.cash === instr.paid_net,
    withholdingMatches: acct.withholding === instr.withheld,
    unprocessedWebhooks: unprocessed,
    amounts: { clearing: acct.clearing, openNet: instr.open_net, cash: acct.cash, paidNet: instr.paid_net, withholding: acct.withholding, withheld: instr.withheld },
  };
}
