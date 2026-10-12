import { reverse, type AllocationDocument, type AllocationResult, type ReversalResult } from "vcrl/allocation";
import type { Tx } from "../platform/db.ts";
import { DomainError, invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadSealed, sealDocument } from "./seal-store.ts";

export type ReversalRows = {
  sequence: number; resultDigest: string;
  pool: { bucket: string; amount: bigint }[];
  lines: { party: string; role: string; bucket: string; lineSeq: number; reversesLineSeq: number; amount: bigint }[];
  holdings: { bucket: string; reason: "RIGHTS_DISPUTE" | "FRAUD_REVIEW" | "LICENSE_UNVERIFIED"; amount: bigint }[];
};

/**
 * 원 run의 봉인 결과와 그 이벤트의 이전 역분개 봉인(순서대로)으로 vcrl reverse를 호출하고 결과를 봉인한다(통합 설계 10.2-9).
 * reason: 환불은 REFUND(식별 이벤트 = 환불), source_revision 대체는 CORRECTION(식별 이벤트 = 새 revision, 11.2-11).
 */
export async function reverseEvent(
  ctx: BridgeCtx, tx: Tx, input: { originalRunId: string; eventId: string; refundEventId: string; reason: "REFUND" | "CORRECTION"; amount: bigint; reversalId: string },
): Promise<ReversalRows> {
  const run = (await tx.query(
    "SELECT r.result_digest, s.policy_digest FROM settlement_run r JOIN issue_seal s ON s.snapshot_id = r.snapshot_id WHERE r.run_id = $1",
    [input.originalRunId],
  )).rows[0];
  if (run === undefined || run.result_digest === null) throw notFound("settled run", input.originalRunId);
  const original = (await loadSealed(ctx, tx, run.result_digest)) as AllocationResult;
  const policy = (await loadSealed(ctx, tx, run.policy_digest)) as AllocationDocument;
  const priorRows = (await tx.query(
    "SELECT result_digest FROM reversal_run WHERE original_run_id = $1 AND event_id = $2 ORDER BY sequence", [input.originalRunId, input.eventId],
  )).rows;
  const priors: ReversalResult[] = [];
  for (const p of priorRows) priors.push((await loadSealed(ctx, tx, p.result_digest)) as ReversalResult);
  const r = reverse({
    original, policy, eventId: input.eventId, priors, runId: input.reversalId,
    refund: { id: input.refundEventId, reason: input.reason, amount: input.amount.toString() },
  });
  if (!r.ok) {
    if (r.errors.some((e) => e.code === "REV_EXCEEDS_REMAINING")) {
      throw input.reason === "REFUND"
        ? invalid("REFUND_EXCEEDS_SETTLED", "refund exceeds the settled amount", r.errors)
        : invalid("CORRECTION_EXCEEDS_SETTLED", "correction exceeds the remaining settled amount", r.errors);
    }
    throw new DomainError("REVERSAL_FAILED", 500, `reversal of ${input.eventId} failed`, r.errors);
  }
  const sealed = await sealDocument(ctx, tx, { kind: "reversal_result", value: r.value, docId: input.reversalId, format: r.value.format });
  return {
    sequence: Number(r.value.sequence), resultDigest: sealed.digest,
    pool: r.value.pool_lines.map((p) => ({ bucket: p.bucket, amount: BigInt(p.amount) })),
    lines: r.value.lines.map((l) => ({ party: l.party, role: l.role, bucket: l.bucket, lineSeq: Number(l.line_seq), reversesLineSeq: Number(l.reverses_line_seq), amount: BigInt(l.amount) })),
    holdings: r.value.holdings.map((h) => ({ bucket: h.bucket, reason: h.reason, amount: BigInt(h.amount) })),
  };
}
