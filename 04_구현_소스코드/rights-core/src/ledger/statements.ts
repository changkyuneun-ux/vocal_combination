import type { Tx } from "../platform/db.ts";
import { invalid, notFound } from "../platform/errors.ts";
import { accountId } from "./accounts.ts";

export type Statement = {
  partyId: string; from: string; to: string; opening: string; settled: string; reversed: string; holdReleased: string;
  payoutGross: string; withholding: string; payoutNet: string; payoutFailedRestored: string;
  /**
   * 기간에 PAYOUT_FAILED 분개가 쓰인(실패한) 지시의 원천세·실지급액. withholdingRestored + netRestored = payoutFailedRestored.
   * 권리자에게 보이는 실제 원천세·실지급은 withholding − withholdingRestored, payoutNet − netRestored다.
   */
  withholdingRestored: string; netRestored: string;
  /** 위 분류에 들지 않는 분개 종류(ADJUSTMENT 등)의 전기(권리자 관점 부호) — 항등식이 구성상 성립하도록. */
  adjusted: string;
  closing: string;
};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const instant = (s: unknown): s is string => typeof s === "string" && INSTANT.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

/**
 * 권리자 명세(통합 설계 11.2-8): 기간 [from, to)(분개 occurred_at 기준). 모든 값은 PARTY_PAYABLE:<party> 전기를 분개 종류별로 합쳐
 * 권리자 관점 부호(수령 +)로 계산한다: settled = SETTLEMENT, reversed = REVERSAL, holdReleased = HOLD_RELEASE,
 * payoutGross = PAYOUT(부채 감소, 양수로 표시), payoutFailedRestored = PAYOUT_FAILED. opening·closing은 from·to 이전 부채 잔액.
 * 그 밖의 종류(ADJUSTMENT 등)는 adjusted. closing = opening + settled + reversed + holdReleased + adjusted − payoutGross + payoutFailedRestored.
 * withholding·payoutNet은 그 기간에 PAYOUT 분개가 쓰인 이 권리자의 지급 지시에서 합친다(실패한 지시 포함 — payoutGross와 같은 범위).
 * withholdingRestored·netRestored는 그 기간에 PAYOUT_FAILED 분개(settled_entry_id)가 쓰인 FAILED 지시에서 합친다(payoutFailedRestored와 같은 범위).
 * 실패를 뺀 원천세·실지급 = withholding − withholdingRestored, payoutNet − netRestored(항등식은 그대로다).
 */
export async function partyStatement(tx: Tx, partyId: string, from: string, to: string): Promise<Statement> {
  if (!instant(from) || !instant(to)) throw invalid("INVALID_INSTANT", `from ${String(from)} and to ${String(to)} must be ms UTC ISO`);
  if (from > to) throw invalid("INVALID_PERIOD", `from ${from} must not be after to ${to}`);
  const party = (await tx.query("SELECT 1 FROM party WHERE party_id = $1", [partyId])).rows[0];
  if (party === undefined) throw notFound("party", partyId);
  const r = (await tx.query(
    `SELECT COALESCE(-SUM(p.amount_krw) FILTER (WHERE j.occurred_at < $2), 0)::text AS opening,
            COALESCE(-SUM(p.amount_krw) FILTER (WHERE j.occurred_at < $3), 0)::text AS closing,
            COALESCE(-SUM(p.amount_krw) FILTER (WHERE j.occurred_at >= $2 AND j.occurred_at < $3 AND j.kind = 'SETTLEMENT'), 0)::text AS settled,
            COALESCE(-SUM(p.amount_krw) FILTER (WHERE j.occurred_at >= $2 AND j.occurred_at < $3 AND j.kind = 'REVERSAL'), 0)::text AS reversed,
            COALESCE(-SUM(p.amount_krw) FILTER (WHERE j.occurred_at >= $2 AND j.occurred_at < $3 AND j.kind = 'HOLD_RELEASE'), 0)::text AS released,
            COALESCE(SUM(p.amount_krw) FILTER (WHERE j.occurred_at >= $2 AND j.occurred_at < $3 AND j.kind = 'PAYOUT'), 0)::text AS gross,
            COALESCE(-SUM(p.amount_krw) FILTER (WHERE j.occurred_at >= $2 AND j.occurred_at < $3 AND j.kind = 'PAYOUT_FAILED'), 0)::text AS restored,
            COALESCE(-SUM(p.amount_krw) FILTER (WHERE j.occurred_at >= $2 AND j.occurred_at < $3
              AND j.kind NOT IN ('SETTLEMENT','REVERSAL','HOLD_RELEASE','PAYOUT','PAYOUT_FAILED')), 0)::text AS adjusted
       FROM posting p JOIN journal_entry j USING (entry_id) WHERE p.account_id = $1 AND j.occurred_at < $3`,
    [accountId({ kind: "PARTY_PAYABLE", partyId }), from, to])).rows[0];
  const pay = (await tx.query(
    `SELECT COALESCE(SUM(i.withholding_krw), 0)::text AS wh, COALESCE(SUM(i.net_krw), 0)::text AS net
       FROM payout_instruction i JOIN journal_entry j ON j.entry_id = i.entry_id
      WHERE i.party_id = $1 AND j.occurred_at >= $2 AND j.occurred_at < $3`, [partyId, from, to])).rows[0];
  const failed = (await tx.query(
    `SELECT COALESCE(SUM(i.withholding_krw), 0)::text AS wh, COALESCE(SUM(i.net_krw), 0)::text AS net
       FROM payout_instruction i JOIN journal_entry j ON j.entry_id = i.settled_entry_id
      WHERE i.party_id = $1 AND i.status = 'FAILED' AND j.occurred_at >= $2 AND j.occurred_at < $3`, [partyId, from, to])).rows[0];
  return {
    partyId, from, to, opening: r.opening, settled: r.settled, reversed: r.reversed, holdReleased: r.released,
    payoutGross: r.gross, withholding: pay.wh, payoutNet: pay.net, payoutFailedRestored: r.restored,
    withholdingRestored: failed.wh, netRestored: failed.net, adjusted: r.adjusted, closing: r.closing,
  };
}
