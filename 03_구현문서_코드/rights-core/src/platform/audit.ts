import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";

/** 모든 봉인·서명·상태 전이는 감사 로그에 남긴다(통합 설계 6.6). */
export async function audit(tx: Tx, clock: Clock, e: { actor: string; action: string; entityType: string; entityId: string; after?: unknown }): Promise<void> {
  await tx.query(
    "INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id, after_json) VALUES ($1,$2,$3,$4,$5,$6)",
    [clock.now(), e.actor, e.action, e.entityType, e.entityId, e.after === undefined ? null : JSON.stringify(e.after)],
  );
}
