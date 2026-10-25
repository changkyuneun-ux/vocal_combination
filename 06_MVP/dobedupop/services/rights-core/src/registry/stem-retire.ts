import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, notFound } from "../platform/errors.ts";
import { requirePermission } from "../platform/permissions.ts";
import { invalidateStem } from "../decisions/cache.ts";

/**
 * 스템 쓰지 않음(0047, 시안 Song-Stems-Panel): 지우지 않고 새 발행에서 뺀다. IR 전·뒤 모두 된다 —
 * 스템 행은 그대로라 봉인된 facts digest와 이미 발행된 조합(배정·렌더)은 바뀌지 않는다. 되돌리지 않는다(다시 쓰려면 새로 추가).
 */
export async function retireStem(tx: Tx, clock: Clock, actor: Actor, stemId: string, reason?: unknown) {
  requirePermission(actor, "rights.edit");
  if ((await tx.query("SELECT 1 FROM stem WHERE stem_id = $1", [stemId])).rowCount === 0) throw notFound("stem", stemId);
  if ((await tx.query("SELECT 1 FROM stem_retirement WHERE stem_id = $1", [stemId])).rowCount !== 0) throw conflict("ALREADY_RETIRED", `stem ${stemId} is already retired`);
  const at = clock.now();
  const r = (await tx.query("INSERT INTO stem_retirement (stem_id, retired_by, retired_at, reason) VALUES ($1,$2,$3,$4) RETURNING *",
    [stemId, actor.userId, at, typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null])).rows[0];
  await invalidateStem(tx, stemId);
  await audit(tx, clock, { actor: actor.userId, action: "STEM_RETIRED", entityType: "stem", entityId: stemId, after: { reason: r.reason } });
  return { stemId, retiredAt: iso(r.retired_at)!, retiredBy: r.retired_by as string, reason: r.reason as string | null };
}
