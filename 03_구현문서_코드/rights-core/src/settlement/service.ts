import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Db, Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { Jobs } from "../platform/jobs.ts";
import { lockBatching } from "../platform/locks.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { attest } from "../engine-bridge/attest.ts";
import { sealDocument } from "../engine-bridge/seal-store.ts";
import { openDisputeInScope } from "../issuance/service.ts";
import type { RefundHook } from "../revenue/service.ts";

export type SettleDeps = { db: Db; ctx: BridgeCtx; clock: Clock; jobs: Jobs };
export type BatchView = {
  batchId: string; status: "OPEN" | "CONFIRMED"; runs: { runId: string; status: string; events: number }[];
  progress: "CALCULATING" | "VERIFYING" | "READY" | "CONFIRMED" | "EMPTY"; skipped: { eventId: string; reason: string }[];
};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function releaseRunEvents(tx: Tx, runId: string): Promise<void> {
  await tx.query("UPDATE settlement_run_event SET active = false WHERE run_id = $1 AND active", [runId]);
}

/**
 * 배치 생성(통합 설계 10.2-3): 기간 안의 미배정 구매·재판매를 순액으로 발행 봉인별로 묶어 run을 만들고 settle-run을 보낸다.
 * 순액 0·발행 봉인 없음·해제되지 않은 격리(ENGINE_FAILED, 11.2-1)·열린 분쟁은 건너뛰고 사유를 남긴다(다음 배치의 후보로 남는다).
 */
export async function createBatch(d: SettleDeps, actor: Actor, input: { batchId: string; periodStart: string; periodEnd: string }) {
  requireRole(actor, "SPACE_OPS");
  for (const t of [input.periodStart, input.periodEnd]) {
    if (!INSTANT.test(t) || new Date(t).toISOString() !== t) throw invalid("INVALID_INSTANT", `${t} must be ms UTC ISO`);
  }
  if (input.periodStart >= input.periodEnd) throw invalid("INVALID_PERIOD", `periodStart ${input.periodStart} must be before periodEnd ${input.periodEnd}`);
  return d.db.tx(async (tx) => {
    // 첫 문장: 동시에 기록 중인 환불이 커밋되기를 기다리고, 이 배치가 커밋될 때까지 새 환불 기록을 막는다.
    await lockBatching(tx, "EXCLUSIVE");
    const now = d.clock.now();
    await tx.query("INSERT INTO settlement_batch (batch_id, period_start, period_end, executed_by, created_at) VALUES ($1,$2,$3,$4,$5)",
      [input.batchId, input.periodStart, input.periodEnd, actor.userId, now]);
    const candidates = (await tx.query(
      `SELECT e.event_id, e.event_type, e.integrity_status, e.net_amount_krw::text AS amount,
              COALESCE((SELECT SUM(r.net_amount_krw) FROM revenue_event r WHERE r.related_event_id = e.event_id), 0)::text AS refunded,
              ARRAY(SELECT r.event_id FROM revenue_event r WHERE r.related_event_id = e.event_id ORDER BY r.event_id)::text[] AS refund_ids,
              s.snapshot_id, rs.pack_id, p.facts_scope_id,
              EXISTS (SELECT 1 FROM quarantine q WHERE q.snapshot_id = s.snapshot_id AND q.released_at IS NULL) AS quarantined
         FROM revenue_event e
         LEFT JOIN rights_snapshot rs ON rs.vc_id = e.vc_id
         LEFT JOIN issue_seal s ON s.snapshot_id = rs.snapshot_id
         LEFT JOIN vocal_pack p ON p.pack_id = rs.pack_id
        WHERE e.event_type IN ('PURCHASE','RESALE') AND e.occurred_at >= $1 AND e.occurred_at < $2
          AND NOT EXISTS (SELECT 1 FROM settlement_run_event x WHERE x.event_id = e.event_id AND x.active)
        ORDER BY e.event_id`,
      [input.periodStart, input.periodEnd],
    )).rows;
    const skipped: { eventId: string; reason: string }[] = [];
    const groups = new Map<string, { eventId: string; net: bigint; refunded: bigint; refundIds: string[] }[]>();
    const disputed = new Map<string, boolean>();
    for (const c of candidates) {
      const net = BigInt(c.amount) - BigInt(c.refunded);
      let reason: string | undefined;
      if (net === 0n) reason = "FULLY_REFUNDED";
      else if (c.snapshot_id === null) reason = "NO_ISSUE_SEAL";
      else if (c.quarantined) reason = "ENGINE_FAILED";
      else {
        if (!disputed.has(c.facts_scope_id)) disputed.set(c.facts_scope_id, await openDisputeInScope(tx, c.facts_scope_id));
        if (disputed.get(c.facts_scope_id)) reason = "FACTS_DISPUTE_OPEN";
      }
      if (reason !== undefined) {
        skipped.push({ eventId: c.event_id, reason });
        await tx.query("INSERT INTO settlement_batch_skip (batch_id, event_id, reason) VALUES ($1,$2,$3)", [input.batchId, c.event_id, reason]);
        continue;
      }
      const g = groups.get(c.snapshot_id) ?? [];
      g.push({ eventId: c.event_id, net, refunded: BigInt(c.refunded), refundIds: c.refund_ids as string[] });
      groups.set(c.snapshot_id, g);
    }
    const runs: string[] = [];
    for (const snapshotId of [...groups.keys()].sort()) {
      const runId = `run_${input.batchId}_${snapshotId}`;
      await tx.query("INSERT INTO settlement_run (run_id, batch_id, snapshot_id, created_at) VALUES ($1,$2,$3,$4)", [runId, input.batchId, snapshotId, now]);
      for (const e of groups.get(snapshotId)!) {
        await tx.query("INSERT INTO settlement_run_event (run_id, event_id, net_amount_krw, refunds_included_krw) VALUES ($1,$2,$3,$4)",
          [runId, e.eventId, e.net.toString(), e.refunded.toString()]);
        for (const refundId of e.refundIds) {
          await tx.query("INSERT INTO settlement_run_event_refund (run_id, event_id, refund_event_id) VALUES ($1,$2,$3)", [runId, e.eventId, refundId]);
        }
      }
      await d.jobs.send(tx, "settle-run", { runId });
      runs.push(runId);
    }
    await audit(tx, d.clock, { actor: actor.userId, action: "BATCH_CREATED", entityType: "settlement_batch", entityId: input.batchId, after: { runs: runs.length, skipped: skipped.length } });
    return { batchId: input.batchId, runs, skipped };
  });
}

export async function batchView(tx: Tx, batchId: string): Promise<BatchView> {
  const b = (await tx.query("SELECT status FROM settlement_batch WHERE batch_id = $1", [batchId])).rows[0];
  if (b === undefined) throw notFound("batch", batchId);
  const runs = (await tx.query(
    `SELECT r.run_id, r.status, (SELECT count(*) FROM settlement_run_event e WHERE e.run_id = r.run_id)::int AS events
       FROM settlement_run r WHERE r.batch_id = $1 ORDER BY r.run_id`, [batchId],
  )).rows.map((r) => ({ runId: r.run_id as string, status: r.status as string, events: r.events as number }));
  const skipped = (await tx.query("SELECT event_id, reason FROM settlement_batch_skip WHERE batch_id = $1 ORDER BY event_id", [batchId]))
    .rows.map((r) => ({ eventId: r.event_id as string, reason: r.reason as string }));
  const live = runs.filter((r) => r.status !== "FAILED" && r.status !== "VOIDED");
  const progress: BatchView["progress"] = b.status === "CONFIRMED" ? "CONFIRMED"
    : live.length === 0 ? "EMPTY"
    : live.some((r) => r.status === "PENDING") ? "CALCULATING"
    : live.some((r) => r.status === "CALCULATED") ? "VERIFYING" : "READY";
  return { batchId, status: b.status, runs, progress, skipped };
}

/** 배치 확정(통합 설계 10.2-7): 살아 있는 run이 모두 VERIFIED일 때 SPACE_SETTLE(생성자와 다른 사람)이 매니페스트에 서명한다. */
export async function confirmBatch(d: SettleDeps, actor: Actor, batchId: string): Promise<{ manifestDigest: string }> {
  requireRole(actor, "SPACE_SETTLE");
  return d.db.tx(async (tx) => {
    const b = (await tx.query("SELECT status, executed_by FROM settlement_batch WHERE batch_id = $1 FOR UPDATE", [batchId])).rows[0];
    if (b === undefined) throw notFound("batch", batchId);
    if (b.status !== "OPEN") throw conflict("INVALID_STATE", `batch ${batchId} is ${b.status}`);
    if (b.executed_by === actor.userId) throw new DomainError("SOD_VIOLATION", 403, `${actor.userId} created batch ${batchId}`);
    const runs = (await tx.query(
      "SELECT run_id, status, result_digest FROM settlement_run WHERE batch_id = $1 AND status NOT IN ('FAILED','VOIDED') ORDER BY run_id FOR UPDATE", [batchId],
    )).rows;
    if (runs.length === 0) throw conflict("BATCH_EMPTY", `batch ${batchId} has no live runs`);
    const notReady = runs.filter((r) => r.status !== "VERIFIED");
    if (notReady.length > 0) throw conflict("BATCH_NOT_READY", `runs not verified: ${notReady.map((r) => `${r.run_id}:${r.status}`).join(",")}`);
    const manifest = { format: "rc-batch-manifest/1", batch_id: batchId, results: runs.map((r) => r.result_digest as string).sort() };
    const sealed = await sealDocument(d.ctx, tx, { kind: "manifest", value: manifest, docId: batchId, format: "rc-batch-manifest/1" });
    await attest(d.ctx, tx, d.clock, { userId: actor.userId, role: "SPACE_SETTLE", digest: sealed.digest });
    await tx.query("UPDATE settlement_run SET status = 'CONFIRMED' WHERE batch_id = $1 AND status = 'VERIFIED'", [batchId]);
    await tx.query("UPDATE settlement_batch SET status = 'CONFIRMED', confirmed_by = $2, confirmed_at = $3, batch_manifest_digest = $4 WHERE batch_id = $1",
      [batchId, actor.userId, d.clock.now(), sealed.digest]);
    await audit(tx, d.clock, { actor: actor.userId, action: "BATCH_CONFIRMED", entityType: "settlement_batch", entityId: batchId, after: { manifest: sealed.digest } });
    // 원장 반영(통합 설계 11.2-4): 확정과 같은 트랜잭션에서 작업을 넣는다.
    await d.jobs.send(tx, "post-batch", { batchId });
    return { manifestDigest: sealed.digest };
  });
}

/** 환불이 기록된 트랜잭션에서 refund-recorded 작업을 보낸다(revenue는 settlement를 모른다). */
export function refundHook(jobs: Jobs): RefundHook {
  return (tx, refundEventId) => jobs.send(tx, "refund-recorded", { refundEventId });
}
