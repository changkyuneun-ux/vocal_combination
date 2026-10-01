/** rights-core `GET /settlement/invariants` 응답(src/settlement/invariants.ts, src/payout/reconcile.ts). */
export type InvariantReport = {
  unreflectedRefunds: { refundEventId: string; originalEventId: string; runId: string; rejected: boolean }[];
  unreflectedRevisions: { newEventId: string; oldEventId: string; runId: string; remaining: string; rejected: boolean }[];
  ledger: {
    entriesUnbalanced: number;
    receivableMatchesSettlement: boolean;
    rightsConserved: boolean;
    unpostedConfirmedRuns: string[];
    unpostedReversals: string[];
    poolMismatches: { kind: "RUN" | "REVERSAL"; id: string; expected: string; actual: string }[];
    receivable: string; settledReceivable: string; rightsBalance: string; rightsPooled: string;
  };
  stuckRuns: { runId: string; status: string; since: string }[];
  payouts: {
    stuck: { instructionId: string; since: string }[];
    resultConflicts: { instructionId: string }[];
    clearingMatchesOpen: boolean;
    cashMatchesPaid: boolean;
    withholdingMatches: boolean;
    unprocessedWebhooks: number;
    amounts: { clearing: string; openNet: string; cash: string; paidNet: string; withholding: string; withheld: string };
  };
};

export type Violation = { key: string; label: string; detail: string };

/**
 * 위반 항목 목록. 비어 있어야 하는 목록·0이어야 하는 수·true여야 하는 불리언이 어긋난 것만 담는다.
 * unpostedConfirmedRuns(post-batch 대기)는 실패가 아니라 따로 보고되므로 위반에 넣지 않는다.
 */
export function violations(r: InvariantReport): Violation[] {
  const out: Violation[] = [];
  const list = (key: string, label: string, xs: unknown[], fmt: (x: any) => string) => {
    if (xs.length > 0) out.push({ key, label, detail: `${xs.length}건: ${xs.map(fmt).join(", ")}` });
  };
  const flag = (key: string, label: string, ok: boolean, detail: string) => {
    if (!ok) out.push({ key, label, detail });
  };
  list("unreflectedRefunds", "반영되지 않은 환불", r.unreflectedRefunds, (x) => `${x.refundEventId}(run ${x.runId}${x.rejected ? ", 거부됨" : ""})`);
  list("unreflectedRevisions", "반영되지 않은 대체", r.unreflectedRevisions, (x) => `${x.newEventId}(남은 ${x.remaining}원, run ${x.runId}${x.rejected ? ", 거부됨" : ""})`);
  if (r.ledger.entriesUnbalanced !== 0) out.push({ key: "entriesUnbalanced", label: "균형이 맞지 않는 분개", detail: `${r.ledger.entriesUnbalanced}건` });
  flag("receivableMatchesSettlement", "RECEIVABLE ≠ 정산 합", r.ledger.receivableMatchesSettlement, `원장 ${r.ledger.receivable} / 정산 ${r.ledger.settledReceivable}`);
  flag("rightsConserved", "권리 풀 보존 위반", r.ledger.rightsConserved, `원장 ${r.ledger.rightsBalance} / 풀 ${r.ledger.rightsPooled}`);
  list("unpostedReversals", "분개되지 않은 역분개", r.ledger.unpostedReversals, (x) => String(x));
  list("poolMismatches", "풀 합 불일치", r.ledger.poolMismatches, (x) => `${x.kind} ${x.id}(기대 ${x.expected}, 실제 ${x.actual})`);
  list("stuckRuns", "오래 멈춘 run", r.stuckRuns, (x) => `${x.runId}(${x.status}, ${x.since})`);
  list("payoutStuck", "멈춘 지급 지시", r.payouts.stuck, (x) => `${x.instructionId}(${x.since})`);
  list("payoutResultConflicts", "지급 결과 충돌", r.payouts.resultConflicts, (x) => x.instructionId);
  flag("clearingMatchesOpen", "PSP_CLEARING ≠ 열린 지시 실지급액", r.payouts.clearingMatchesOpen, `원장 ${r.payouts.amounts.clearing} / 지시 ${r.payouts.amounts.openNet}`);
  flag("cashMatchesPaid", "CASH ≠ PAID 실지급액", r.payouts.cashMatchesPaid, `원장 ${r.payouts.amounts.cash} / 지시 ${r.payouts.amounts.paidNet}`);
  flag("withholdingMatches", "WITHHOLDING_TAX ≠ 원천세 합", r.payouts.withholdingMatches, `원장 ${r.payouts.amounts.withholding} / 지시 ${r.payouts.amounts.withheld}`);
  if (r.payouts.unprocessedWebhooks !== 0) out.push({ key: "unprocessedWebhooks", label: "오래된 미처리 webhook", detail: `${r.payouts.unprocessedWebhooks}건` });
  return out;
}

export const allOk = (r: InvariantReport): boolean => violations(r).length === 0;
