import { audit } from "../platform/audit.ts";
import type { JobHandler, JobName } from "../platform/jobs.ts";
import { attest } from "../engine-bridge/attest.ts";
import { evaluateRun, verifyRun, type RunEvent } from "../engine-bridge/settle.ts";
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

export function jobHandlers(d: SettleDeps): Partial<Record<JobName, JobHandler>> {
  return {
    "settle-run": (data) => settleRun(d, { runId: data.runId! }),
    "verify-run": (data) => verifyRunJob(d, { runId: data.runId! }),
  };
}
