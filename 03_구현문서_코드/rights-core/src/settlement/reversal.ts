import { audit } from "../platform/audit.ts";
import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { reverseEvent } from "../engine-bridge/reverse.ts";
import { postConfirmedRun, postReversal } from "./posting.ts";
import type { SettleDeps } from "./service.ts";

const SETTLER = "sys_settler";

/**
 * 확정 run 이벤트 하나의 역분개를 쓴다(통합 설계 10.2-9·11.2-11): vcrl reverse(이전 역분개 전부를 priors로) → reversal_run·역분개 행 →
 * 원 run의 SETTLEMENT 분개 보장 → REVERSAL 분개. 호출자는 원 run 이벤트 행을 FOR UPDATE로 잠갔고, 식별 이벤트로 멱등 검사를 끝냈다.
 * 식별 이벤트(identEventId)는 환불이면 환불 id, CORRECTION이면 새 revision id다(reversal_run.refund_event_id, reversal_id = rev_<id>).
 */
export async function writeReversal(
  d: SettleDeps, tx: Tx, input: { runId: string; eventId: string; identEventId: string; reason: "REFUND" | "CORRECTION"; amount: bigint },
): Promise<string> {
  const { runId, eventId } = input;
  const reversalId = `rev_${input.identEventId}`;
  const r = await reverseEvent(d.ctx, tx, { originalRunId: runId, eventId, refundEventId: input.identEventId, reason: input.reason, amount: input.amount, reversalId });
  await tx.query(
    "INSERT INTO reversal_run (reversal_id, original_run_id, event_id, sequence, refund_event_id, result_digest, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [reversalId, runId, eventId, r.sequence, input.identEventId, r.resultDigest, d.clock.now()],
  );
  const seq = r.sequence + 1;
  for (const p of r.pool) {
    await tx.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw, reversal_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [runId, eventId, p.bucket, seq, p.amount.toString(), reversalId]);
  }
  for (const l of r.lines) {
    const orig = (await tx.query(
      "SELECT line_id FROM allocation_line WHERE run_id = $1 AND event_id = $2 AND party_id = $3 AND role = $4 AND bucket = $5 AND line_seq = $6 AND line_kind = 'SETTLE'",
      [runId, eventId, l.party, l.role, l.bucket, l.reversesLineSeq],
    )).rows[0];
    if (orig === undefined) throw notFound("original allocation line", `${runId}/${eventId}/${l.party}/${l.role}/${l.bucket}/${l.reversesLineSeq}`);
    await tx.query(
      `INSERT INTO allocation_line (run_id, event_id, party_id, role, bucket, line_seq, line_kind, amount_krw, reversal_of_line_id, reversal_id)
       VALUES ($1,$2,$3,$4,$5,$6,'REVERSAL',$7,$8,$9)`,
      [runId, eventId, l.party, l.role, l.bucket, l.lineSeq, l.amount.toString(), orig.line_id, reversalId],
    );
  }
  for (const h of r.holdings) {
    await tx.query("INSERT INTO unallocated_holding (run_id, event_id, bucket, reason, line_seq, amount_krw, reversal_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [runId, eventId, h.bucket, h.reason, seq, h.amount.toString(), reversalId]);
  }
  // 반대 부호 분개(통합 설계 11.2-4): 역분개 행과 같은 트랜잭션. post-batch보다 먼저 올 수 있으므로
  // 원 run의 SETTLEMENT 분개를 먼저 보장한다(멱등) — REVERSAL은 항상 SETTLEMENT 뒤에 쓰인다.
  await postConfirmedRun(tx, d.clock, runId);
  await postReversal(tx, d.clock, reversalId);
  await audit(tx, d.clock, {
    actor: SETTLER, action: "EVENT_REVERSED", entityType: "reversal_run", entityId: reversalId,
    after: { sequence: r.sequence, amount: input.amount.toString(), reason: input.reason },
  });
  return reversalId;
}
