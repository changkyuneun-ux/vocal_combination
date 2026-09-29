import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, notFound } from "../platform/errors.ts";
import type { Declared } from "../engine-bridge/activation.ts";

export async function createPack(tx: Tx, clock: Clock, actor: Actor, p: { packId: string; packCode: string; title: string; factsScopeId: string }): Promise<void> {
  requireRole(actor, "RIGHTS_EDITOR");
  await tx.query("INSERT INTO vocal_pack (pack_id, pack_code, title, facts_scope_id, created_at) VALUES ($1,$2,$3,$4,$5)",
    [p.packId, p.packCode, p.title, p.factsScopeId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "PACK_CREATED", entityType: "vocal_pack", entityId: p.packId });
}

export type PackLock = "NONE" | "SHARE" | "UPDATE";

/** 팩 행을 읽는다. 청구권자를 바꾸는 쪽은 UPDATE, 청구권자를 읽고 판정하는 쪽은 SHARE로 잠근다. */
export async function packRow(tx: Tx, packId: string, lock: PackLock = "NONE"): Promise<{ packId: string; factsScopeId: string; status: string }> {
  const suffix = lock === "UPDATE" ? " FOR UPDATE" : lock === "SHARE" ? " FOR SHARE" : "";
  const r = (await tx.query(`SELECT pack_id, facts_scope_id, status FROM vocal_pack WHERE pack_id = $1${suffix}`, [packId])).rows[0];
  if (r === undefined) throw notFound("pack", packId);
  return { packId: r.pack_id, factsScopeId: r.facts_scope_id, status: r.status };
}

/** 선언 청구권자 교체. 활성 팩은 바꿀 수 없다(일시정지 또는 초안에서만). */
export async function setPackClaimants(tx: Tx, clock: Clock, actor: Actor, packId: string, entries: Declared[]): Promise<void> {
  requireRole(actor, "RIGHTS_EDITOR");
  const pack = await packRow(tx, packId, "UPDATE");
  if (pack.status === "ACTIVE") throw conflict("INVALID_STATE", `pack ${packId} is ACTIVE`);
  await tx.query("DELETE FROM pack_claimant WHERE pack_id = $1", [packId]);
  for (const e of entries) {
    await tx.query("INSERT INTO pack_claimant (pack_id, party_id, claimant_role) VALUES ($1,$2,$3)", [packId, e.party, e.role]);
  }
  await audit(tx, clock, { actor: actor.userId, action: "PACK_CLAIMANTS_SET", entityType: "vocal_pack", entityId: packId, after: entries });
}

export async function declaredClaimants(tx: Tx, packId: string): Promise<Declared[]> {
  const r = await tx.query("SELECT claimant_role, party_id FROM pack_claimant WHERE pack_id = $1 ORDER BY claimant_role, party_id", [packId]);
  return r.rows.map((x) => ({ role: x.claimant_role, party: x.party_id }));
}
