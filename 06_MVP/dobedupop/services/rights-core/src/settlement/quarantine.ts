import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, notFound, type Diagnostic } from "../platform/errors.ts";
import type { SettleDeps } from "./service.ts";
import { requirePermission } from "../platform/permissions.ts";

/**
 * 격리(통합 설계 11.2-1): 엔진 진단으로 FAILED가 된 run의 발행 봉인을 격리한다. settleRun의 FAILED 전이와 같은 트랜잭션에서 부른다.
 * 해제되지 않은 격리가 이미 있으면 아무것도 쓰지 않는다(부분 UNIQUE quarantine_active).
 */
export async function quarantineSeal(tx: Tx, clock: Clock, input: { snapshotId: string; runId: string; diagnostics: readonly Diagnostic[] }): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO quarantine (snapshot_id, reason, diagnostics, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (snapshot_id) WHERE released_at IS NULL DO NOTHING`,
    [input.snapshotId, `run ${input.runId} FAILED`, JSON.stringify(input.diagnostics), clock.now()],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 격리 해제(settlement.operate): 해제 기록과 감사. 이후 배치에서 그 봉인의 이벤트가 다시 후보가 된다. */
export async function releaseQuarantine(d: SettleDeps, actor: Actor, snapshotId: string): Promise<{ snapshotId: string; releasedBy: string; releasedAt: string }> {
  requirePermission(actor, "settlement.operate");
  return d.db.tx(async (tx) => {
    const row = (await tx.query(
      "SELECT quarantine_id FROM quarantine WHERE snapshot_id = $1 AND released_at IS NULL FOR UPDATE", [snapshotId],
    )).rows[0];
    if (row === undefined) {
      const any = await tx.query("SELECT 1 FROM quarantine WHERE snapshot_id = $1 LIMIT 1", [snapshotId]);
      if ((any.rowCount ?? 0) === 0) throw notFound("quarantine", snapshotId);
      throw conflict("NOT_QUARANTINED", `issue seal ${snapshotId} has no unreleased quarantine`);
    }
    const releasedAt = d.clock.now();
    await tx.query("UPDATE quarantine SET released_by = $2, released_at = $3 WHERE quarantine_id = $1", [row.quarantine_id, actor.userId, releasedAt]);
    await audit(tx, d.clock, { actor: actor.userId, action: "QUARANTINE_RELEASED", entityType: "issue_seal", entityId: snapshotId, after: { quarantineId: String(row.quarantine_id) } });
    return { snapshotId, releasedBy: actor.userId, releasedAt };
  });
}
