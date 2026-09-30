import { evaluate, type RevenueEvent } from "vcrl/allocation";
import type { Tx } from "../platform/db.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import { splitByWeights } from "../ledger/split.ts";
import type { BridgeCtx } from "./context.ts";
import { loadSealed } from "./seal-store.ts";
import { sealInputs } from "./settle.ts";

export type FraudReleaseSuggestion = { holdingId: string; heldKrw: string; remainingKrw: string; allocation: Record<string, string> };

/**
 * FRAUD_REVIEW 보류의 해제 배분 제안(통합 설계 11.2-5, 제안일 뿐 적용은 운영자).
 * run의 발행 봉인 입력과 봉인된 events에서 그 이벤트만 integrity CLEAR로 바꿔 evaluate하고 그 이벤트의 라인을 권리자별로 합친다.
 * 이벤트별 배분은 서로 독립이므로 그 이벤트 하나만 평가한다. 역분개로 줄어든 보류는 남은 금액으로 비례 축소한다(최대 잔여법).
 */
export async function suggestFraudRelease(ctx: BridgeCtx, tx: Tx, holdingId: string): Promise<FraudReleaseSuggestion> {
  if (!/^\d{1,18}$/.test(holdingId)) throw notFound("hold", holdingId);
  const h = (await tx.query(
    `SELECT h.run_id, h.event_id, h.bucket, h.reason, h.line_seq, h.amount_krw::text AS held, r.snapshot_id, r.events_digest,
            (h.amount_krw + COALESCE((SELECT SUM(x.amount_krw) FROM unallocated_holding x
               WHERE x.run_id = h.run_id AND x.event_id = h.event_id AND x.bucket = h.bucket AND x.reason = h.reason AND x.line_seq > 1), 0))::text AS remaining
       FROM unallocated_holding h JOIN settlement_run r USING (run_id) WHERE h.holding_id = $1`, [holdingId])).rows[0];
  if (h === undefined || h.line_seq !== 1) throw notFound("hold", holdingId);
  if (h.reason !== "FRAUD_REVIEW") throw new DomainError("NO_SUGGESTION", 404, `hold ${holdingId} is ${h.reason}; only FRAUD_REVIEW has a suggestion`);
  if (h.events_digest === null) throw notFound("sealed run events", h.run_id);
  const s = await sealInputs(ctx, tx, h.snapshot_id);
  const sealed = (await loadSealed(ctx, tx, h.events_digest)) as readonly RevenueEvent[];
  const ev = sealed.find((e) => e.id === h.event_id);
  if (ev === undefined) throw notFound("sealed event", h.event_id);
  const r = evaluate({ policy: s.policy, facts: s.facts, projection: s.projection, snapshot: s.snapshot, events: [{ ...ev, integrity: "CLEAR" }], runId: h.run_id });
  if (!r.ok) throw new DomainError("SUGGESTION_FAILED", 500, `re-evaluation of ${h.event_id} failed`, r.errors);
  const byParty = new Map<string, bigint>();
  for (const l of r.value.lines) if (l.event_id === h.event_id) byParty.set(l.party, (byParty.get(l.party) ?? 0n) + BigInt(l.amount));
  const remaining = BigInt(h.remaining);
  const allocation: Record<string, string> = {};
  if (remaining > 0n && byParty.size > 0) {
    const parts = splitByWeights(remaining, [...byParty].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, weight]) => ({ key, weight })));
    for (const [k, v] of parts) if (v !== 0n) allocation[k] = v.toString();
  }
  return { holdingId, heldKrw: h.held, remainingKrw: remaining.toString(), allocation };
}
