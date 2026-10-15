import type { BridgeCtx } from "../engine-bridge/context.ts";
import { simulateEvents, withoutMandateRouting } from "../engine-bridge/simulate.ts";
import { withSystemScope } from "../platform/actor.ts";
import { iso, type Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";

type RevenueEvent = Parameters<typeof simulateEvents>[2]["events"][number];

export type Contribution = {
  vcId: string; snapshotId: string; batchId: string; periodStart: string; periodEnd: string; events: number;
  contributionKrw: string; heldEvents: number;
};

/**
 * 멤버별 기여분(다음 작업 16): 소속사에 실연 권리를 위임한 멤버가 "위임 전 내 몫"을 보는 참고값이다.
 * 확정된 정산 run마다 그 run의 매출 이벤트를 같은 발행 봉인으로 다시 평가하되 정책에서 위임 라우팅만 뺀다(엔진 시뮬레이션).
 * 봉인·원장에 쓰지 않으며 실제 지급은 위임받은 쪽이 받는다.
 * - 금액: 정산 때의 순액에서 확정 뒤 환불(역분개)을 뺀 값. 0 이하가 된 이벤트는 뺀다.
 * - 이상거래 보류(FRAUD_REVIEW)가 풀리지 않은 이벤트는 엔진이 권리자 풀을 보류하므로 기여분이 0이다(heldEvents로 센다).
 * - 기간: 정산 배치의 기간 시작이 [from, to)에 드는 run.
 */
export async function myContributions(ctx: BridgeCtx, tx: Tx, partyId: string, from: string, to: string): Promise<{ total: string; items: Contribution[] }> {
  if (!(Date.parse(from) < Date.parse(to))) throw new DomainError("BAD_REQUEST", 400, "from must be before to");
  return withSystemScope(tx, async () => {
    const runs = (await tx.query(
      `SELECT r.run_id, r.snapshot_id, s.vc_id, b.batch_id, b.period_start, b.period_end
         FROM settlement_run r JOIN settlement_batch b ON b.batch_id = r.batch_id JOIN rights_snapshot s ON s.snapshot_id = r.snapshot_id
        WHERE r.status = 'CONFIRMED' AND b.period_start >= $2 AND b.period_start < $3
          AND EXISTS (SELECT 1 FROM snapshot_stem_assignment a WHERE a.snapshot_id = r.snapshot_id AND a.party_id = $1 AND a.rights_bearing)
        ORDER BY b.period_start, s.vc_id`, [partyId, from, to],
    )).rows;
    const items: Contribution[] = [];
    let total = 0n;
    for (const run of runs) {
      const evs = (await tx.query(
        `SELECT x.event_id, x.net_amount_krw::text AS net, e.event_type, e.integrity_status,
                COALESCE((SELECT sum(f.net_amount_krw) FROM reversal_run v JOIN revenue_event f ON f.event_id = v.refund_event_id
                           WHERE v.original_run_id = x.run_id AND v.event_id = x.event_id), 0)::text AS refunded,
                EXISTS (SELECT 1 FROM unallocated_holding h WHERE h.run_id = x.run_id AND h.event_id = x.event_id AND h.reason = 'FRAUD_REVIEW' AND h.line_seq = 1
                         AND NOT EXISTS (SELECT 1 FROM hold_release hr WHERE hr.holding_id = h.holding_id)) AS held
           FROM settlement_run_event x JOIN revenue_event e ON e.event_id = x.event_id
          WHERE x.run_id = $1 AND x.active ORDER BY x.event_id`, [run.run_id],
      )).rows;
      const events: RevenueEvent[] = [];
      let held = 0;
      for (const e of evs) {
        const amount = BigInt(e.net) - BigInt(e.refunded);
        if (amount <= 0n) continue;
        if (e.held) held++;
        // 보류가 풀린 이벤트는 권리자 풀이 배분됐으므로 CLEAR로 본다.
        events.push({ id: e.event_id, type: e.event_type === "RESALE" ? "RESALE" : e.event_type === "TRAFFIC" ? "TRAFFIC" : "PRIMARY",
          amount: amount.toString(), currency: "KRW", integrity: e.held ? "FLAGGED" : "CLEAR" });
      }
      if (events.length === 0) continue;
      const r = await simulateEvents(ctx, tx, { snapshotId: run.snapshot_id, runId: `contrib_${run.run_id}`, events, variant: withoutMandateRouting });
      if (!r.ok) throw new DomainError("CONTRIBUTION_FAILED", 500, `contribution of ${run.run_id} could not be computed: ${r.errors.map((x) => x.code).join(", ")}`);
      const mine = r.value.lines.filter((l) => l.party === partyId && l.role.startsWith("PERFORMER")).reduce((a, l) => a + BigInt(l.amount), 0n);
      total += mine;
      items.push({
        vcId: run.vc_id, snapshotId: run.snapshot_id, batchId: run.batch_id, periodStart: iso(run.period_start)!, periodEnd: iso(run.period_end)!,
        events: events.length, contributionKrw: mine.toString(), heldEvents: held,
      });
    }
    return { total: total.toString(), items };
  });
}
