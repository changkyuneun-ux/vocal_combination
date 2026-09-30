import { audit } from "../platform/audit.ts";
import type { JobHandler, JobName } from "../platform/jobs.ts";
import { attest } from "../engine-bridge/attest.ts";
import { evaluateRun, verifyRun, type RunEvent } from "../engine-bridge/settle.ts";
import { reverseEvent } from "../engine-bridge/reverse.ts";
import { refundedTotal, revenueRow } from "../revenue/service.ts";
import { releaseRunEvents, type SettleDeps } from "./service.ts";

const SETTLER = "sys_settler";
const VERIFIER = "sys_verifier";

/** settle-run(통합 설계 10.2-5): run을 잠그고 PENDING일 때만 평가·봉인·기록한다. 재시도 안전. */
export async function settleRun(d: SettleDeps, data: { runId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    const run = (await tx.query("SELECT run_id, snapshot_id, status FROM settlement_run WHERE run_id = $1 FOR UPDATE", [data.runId])).rows[0];
    if (run === undefined || run.status !== "PENDING") return;
    const rows = (await tx.query(
      `SELECT x.event_id, x.net_amount_krw::text AS net, e.event_type, e.integrity_status
         FROM settlement_run_event x JOIN revenue_event e ON e.event_id = x.event_id WHERE x.run_id = $1 AND x.active ORDER BY x.event_id`,
      [data.runId],
    )).rows;
    const events: RunEvent[] = rows.map((r) => ({
      eventId: r.event_id, type: r.event_type === "RESALE" ? "RESALE" : "PRIMARY", amount: BigInt(r.net), integrity: r.integrity_status,
    }));
    const r = await evaluateRun(d.ctx, tx, { runId: data.runId, snapshotId: run.snapshot_id, events });
    if (!r.ok) {
      await tx.query("UPDATE settlement_run SET status = 'FAILED', diagnostics = $2 WHERE run_id = $1", [data.runId, JSON.stringify(r.diagnostics)]);
      await releaseRunEvents(tx, data.runId);
      await audit(tx, d.clock, { actor: SETTLER, action: "RUN_FAILED", entityType: "settlement_run", entityId: data.runId, after: { codes: r.diagnostics.map((x) => x.code) } });
      return;
    }
    for (const p of r.rows.pool) {
      await tx.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw) VALUES ($1,$2,$3,1,$4)", [data.runId, p.eventId, p.bucket, p.amount.toString()]);
    }
    for (const l of r.rows.lines) {
      await tx.query(
        "INSERT INTO allocation_line (run_id, event_id, party_id, role, bucket, line_seq, line_kind, amount_krw) VALUES ($1,$2,$3,$4,$5,$6,'SETTLE',$7)",
        [data.runId, l.eventId, l.party, l.role, l.bucket, l.lineSeq, l.amount.toString()],
      );
    }
    for (const h of r.rows.holdings) {
      await tx.query("INSERT INTO unallocated_holding (run_id, event_id, bucket, reason, line_seq, amount_krw) VALUES ($1,$2,$3,$4,1,$5)",
        [data.runId, h.eventId, h.bucket, h.reason, h.amount.toString()]);
    }
    await tx.query("UPDATE settlement_run SET status = 'CALCULATED', events_digest = $2, result_digest = $3 WHERE run_id = $1", [data.runId, r.eventsDigest, r.resultDigest]);
    await attest(d.ctx, tx, d.clock, { userId: SETTLER, role: "SPACE_OPS", digest: r.resultDigest });
    await d.jobs.send(tx, "verify-run", { runId: data.runId });
  });
}

/** verify-run(통합 설계 10.2-6): CALCULATED run을 독립 재계산으로 검증한다. 불일치면 VOIDED·경보·이벤트 해제. */
export async function verifyRunJob(d: SettleDeps, data: { runId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    const run = (await tx.query("SELECT * FROM settlement_run WHERE run_id = $1 FOR UPDATE", [data.runId])).rows[0];
    if (run === undefined || run.status !== "CALCULATED") return;
    const diags = await verifyRun(d.ctx, tx, { runId: data.runId, snapshotId: run.snapshot_id, eventsDigest: run.events_digest, resultDigest: run.result_digest });
    if (diags.length === 0) {
      await attest(d.ctx, tx, d.clock, { userId: VERIFIER, role: "PLATFORM", digest: run.result_digest });
      await tx.query("UPDATE settlement_run SET status = 'VERIFIED', verified_by = $2, verified_at = $3 WHERE run_id = $1", [data.runId, VERIFIER, d.clock.now()]);
      return;
    }
    await tx.query("UPDATE settlement_run SET status = 'VOIDED', diagnostics = $2 WHERE run_id = $1", [data.runId, JSON.stringify(diags)]);
    await releaseRunEvents(tx, data.runId);
    await audit(tx, d.clock, { actor: VERIFIER, action: "RUN_VERIFY_MISMATCH", entityType: "settlement_run", entityId: data.runId, after: { codes: diags.map((x) => x.code) } });
  });
}

/**
 * refund-recorded(통합 설계 10.2-8): 원 이벤트가 살아 있는 run에 있으면 그 run을 잠근다.
 * 이미 이 환불까지 반영했으면 끝, 확정 전이면 VOIDED·이벤트 해제(다음 배치가 새 순액으로 평가), 확정이면 reverse-event.
 */
export async function refundRecorded(d: SettleDeps, data: { refundEventId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    const refund = await revenueRow(tx, data.refundEventId);
    const original = refund.relatedEventId!;
    const live = (await tx.query(
      "SELECT r.run_id, r.status, x.refunds_included_krw::text AS inc FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id WHERE x.event_id = $1 AND x.active",
      [original],
    )).rows[0];
    if (live === undefined) return;
    const run = (await tx.query("SELECT status FROM settlement_run WHERE run_id = $1 FOR UPDATE", [live.run_id])).rows[0];
    if (BigInt(live.inc) >= (await refundedTotal(tx, original))) return;
    if (run.status === "CONFIRMED") {
      await d.jobs.send(tx, "reverse-event", { refundEventId: data.refundEventId });
      return;
    }
    if (run.status === "FAILED" || run.status === "VOIDED") return;
    await tx.query("UPDATE settlement_run SET status = 'VOIDED', diagnostics = $2 WHERE run_id = $1", [live.run_id, JSON.stringify([{ code: "REFUND_BEFORE_CONFIRMATION", path: "$", message: data.refundEventId }])]);
    await releaseRunEvents(tx, live.run_id);
    await audit(tx, d.clock, { actor: SETTLER, action: "RUN_VOIDED_BY_REFUND", entityType: "settlement_run", entityId: live.run_id, after: { refund: data.refundEventId } });
  });
}

/** reverse-event(통합 설계 10.2-9): 환불 id로 멱등, 원 이벤트 행을 잠가 직렬화, 이전 역분개를 빠짐없이 넘긴다. */
export async function reverseEventJob(d: SettleDeps, data: { refundEventId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    const refund = await revenueRow(tx, data.refundEventId);
    const original = refund.relatedEventId!;
    const x = (await tx.query(
      "SELECT x.run_id FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id WHERE x.event_id = $1 AND x.active AND r.status = 'CONFIRMED' FOR UPDATE OF x",
      [original],
    )).rows[0];
    if (x === undefined) return;
    const done = await tx.query("SELECT 1 FROM reversal_run WHERE refund_event_id = $1", [data.refundEventId]);
    if ((done.rowCount ?? 0) > 0) return;
    const reversalId = `rev_${data.refundEventId}`;
    const r = await reverseEvent(d.ctx, tx, { originalRunId: x.run_id, eventId: original, refundEventId: data.refundEventId, amount: BigInt(refund.amountKrw), reversalId });
    await tx.query(
      "INSERT INTO reversal_run (reversal_id, original_run_id, event_id, sequence, refund_event_id, result_digest, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [reversalId, x.run_id, original, r.sequence, data.refundEventId, r.resultDigest, d.clock.now()],
    );
    const seq = r.sequence + 1;
    for (const p of r.pool) {
      await tx.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw, reversal_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [x.run_id, original, p.bucket, seq, p.amount.toString(), reversalId]);
    }
    for (const l of r.lines) {
      const orig = (await tx.query(
        "SELECT line_id FROM allocation_line WHERE run_id = $1 AND event_id = $2 AND party_id = $3 AND role = $4 AND bucket = $5 AND line_seq = $6",
        [x.run_id, original, l.party, l.role, l.bucket, l.reversesLineSeq],
      )).rows[0];
      await tx.query(
        `INSERT INTO allocation_line (run_id, event_id, party_id, role, bucket, line_seq, line_kind, amount_krw, reversal_of_line_id, reversal_id)
         VALUES ($1,$2,$3,$4,$5,$6,'REVERSAL',$7,$8,$9)`,
        [x.run_id, original, l.party, l.role, l.bucket, l.lineSeq, l.amount.toString(), orig.line_id, reversalId],
      );
    }
    for (const h of r.holdings) {
      await tx.query("INSERT INTO unallocated_holding (run_id, event_id, bucket, reason, line_seq, amount_krw, reversal_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [x.run_id, original, h.bucket, h.reason, seq, h.amount.toString(), reversalId]);
    }
    await audit(tx, d.clock, { actor: SETTLER, action: "EVENT_REVERSED", entityType: "reversal_run", entityId: reversalId, after: { sequence: r.sequence, amount: refund.amountKrw } });
  });
}

export function jobHandlers(d: SettleDeps): Partial<Record<JobName, JobHandler>> {
  return {
    "settle-run": (data) => settleRun(d, { runId: data.runId! }),
    "verify-run": (data) => verifyRunJob(d, { runId: data.runId! }),
    "refund-recorded": (data) => refundRecorded(d, { refundEventId: data.refundEventId! }),
    "reverse-event": (data) => reverseEventJob(d, { refundEventId: data.refundEventId! }),
  };
}
