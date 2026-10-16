import { audit } from "../platform/audit.ts";
import type { JobHandler, JobName } from "../platform/jobs.ts";
import { attest } from "../engine-bridge/attest.ts";
import { evaluateRun, verifyRun, type RunEvent } from "../engine-bridge/settle.ts";
import { revenueRow } from "../revenue/service.ts";
import type { Tx } from "../platform/db.ts";
import { lockBatching } from "../platform/locks.ts";
import { DomainError } from "../platform/errors.ts";
import { postBatch } from "./posting.ts";
import { quarantineSeal } from "./quarantine.ts";
import { writeReversal } from "./reversal.ts";
import { revisionRecorded } from "./revision.ts";
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
      eventId: r.event_id, type: r.event_type === "RESALE" ? "RESALE" : r.event_type === "TRAFFIC" ? "TRAFFIC" : "PRIMARY", amount: BigInt(r.net), integrity: r.integrity_status,
    }));
    const r = await evaluateRun(d.ctx, tx, { runId: data.runId, snapshotId: run.snapshot_id, events });
    if (!r.ok) {
      await tx.query("UPDATE settlement_run SET status = 'FAILED', diagnostics = $2 WHERE run_id = $1", [data.runId, JSON.stringify(r.diagnostics)]);
      await releaseRunEvents(tx, data.runId);
      // 격리(통합 설계 11.2-1): 봉인된 입력에 대한 엔진 진단은 결정적이므로 해제 전까지 이 봉인의 이벤트는 배치가 건너뛴다.
      await quarantineSeal(tx, d.clock, { snapshotId: run.snapshot_id, runId: data.runId, diagnostics: r.diagnostics });
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
 * 이 환불 id가 run의 순액에 포함돼 있으면 끝(합계 비교가 아니라 id로 판단 — 지연된 작업이 이중 반영하지 않도록),
 * 확정 전이면 VOIDED·이벤트 해제(다음 배치가 새 순액으로 평가), 확정이면 reverse-event.
 */
export async function refundRecorded(d: SettleDeps, data: { refundEventId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    // 진행 중인 배치 생성이 커밋될 때까지 기다린 뒤 살아 있는 run을 찾는다.
    await lockBatching(tx, "SHARED");
    const refund = await revenueRow(tx, data.refundEventId);
    const original = refund.relatedEventId!;
    const live = (await tx.query(
      "SELECT x.run_id FROM settlement_run_event x WHERE x.event_id = $1 AND x.active",
      [original],
    )).rows[0];
    if (live === undefined) return;
    const run = (await tx.query("SELECT status FROM settlement_run WHERE run_id = $1 FOR UPDATE", [live.run_id])).rows[0];
    if (await includedInNet(tx, live.run_id, original, data.refundEventId)) return;
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
  try {
    await reverseInTx(d, data);
  } catch (e) {
    // 정산액 초과는 (id 기반 포함 판단 이후에는) 버그 신호다. 결정적이라 재시도해도 같으므로, 역분개는 쓰지 않고
    // 운영자가 보도록 별도 트랜잭션으로 한 번만 감사에 남긴 뒤 작업을 끝낸다.
    if (!(e instanceof DomainError && e.code === "REFUND_EXCEEDS_SETTLED")) throw e;
    await d.db.tx(async (tx) => {
      const seen = await tx.query("SELECT 1 FROM audit_log WHERE action_name = 'REVERSAL_REJECTED' AND entity_type = 'revenue_event' AND entity_id = $1", [data.refundEventId]);
      if ((seen.rowCount ?? 0) > 0) return;
      await audit(tx, d.clock, {
        actor: SETTLER, action: "REVERSAL_REJECTED", entityType: "revenue_event", entityId: data.refundEventId, after: { code: e.code, diagnostics: e.diagnostics },
      });
    });
  }
}

/** 환불 id가 run 이벤트의 순액에 이미 포함됐는지(배치 생성 시 기록한 id 목록). */
async function includedInNet(tx: Tx, runId: string, eventId: string, refundEventId: string): Promise<boolean> {
  const r = await tx.query("SELECT 1 FROM settlement_run_event_refund WHERE run_id = $1 AND event_id = $2 AND refund_event_id = $3", [runId, eventId, refundEventId]);
  return (r.rowCount ?? 0) > 0;
}

async function reverseInTx(d: SettleDeps, data: { refundEventId: string }): Promise<void> {
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
    if (await includedInNet(tx, x.run_id, original, data.refundEventId)) return;
    await writeReversal(d, tx, { runId: x.run_id, eventId: original, identEventId: data.refundEventId, reason: "REFUND", amount: BigInt(refund.amountKrw) });
  });
}

export function jobHandlers(d: SettleDeps): Partial<Record<JobName, JobHandler>> {
  return {
    "settle-run": (data) => settleRun(d, { runId: data.runId! }),
    "verify-run": (data) => verifyRunJob(d, { runId: data.runId! }),
    "refund-recorded": (data) => refundRecorded(d, { refundEventId: data.refundEventId! }),
    "revision-recorded": (data) => revisionRecorded(d, { newEventId: data.newEventId! }),
    "reverse-event": (data) => reverseEventJob(d, { refundEventId: data.refundEventId! }),
    "post-batch": (data) => postBatch(d, { batchId: data.batchId! }),
  };
}
