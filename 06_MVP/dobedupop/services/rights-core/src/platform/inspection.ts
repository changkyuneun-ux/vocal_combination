import type { Actor } from "./actor.ts";
import { requireRole } from "./actor.ts";
import { audit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import { iso, type Tx } from "./db.ts";
import { conflict, DomainError, notFound } from "./errors.ts";
import { requirePermission } from "./permissions.ts";

/**
 * 플랫폼 조회의 단계별 통제(다음 작업 7, migrations/0019_inspection.sql).
 * 1 열람 기록 · 2 개인정보 마스킹 해제(사유 필수) · 3 break-glass(테넌트 소유 데이터 쓰기, 대상 테넌트·사유·최대 60분).
 */

export type Panel = "PARTY" | "RIGHTS_IMAGE" | "PACK" | "SETTLEMENT_TRACE" | "SOURCE_DOCUMENT";
export type BreakGlass = { breakGlassId: number; userId: string; targetTenantId: string; reason: string; startedAt: string; expiresAt: string; endedAt?: string };

const BG_MAX_MINUTES = 60;

function toBreakGlass(r: any): BreakGlass {
  return {
    breakGlassId: Number(r.break_glass_id), userId: r.user_id, targetTenantId: r.target_tenant_id, reason: r.reason,
    startedAt: iso(r.started_at)!, expiresAt: iso(r.expires_at)!, ...(r.ended_at !== null && { endedAt: iso(r.ended_at)! }),
  };
}

/**
 * 지금 유효한(끝내지 않았고 만료 전인) 이 사용자의 break-glass. 여러 개면 가장 늦게 만료되는 것.
 * now는 끝내지 않은 break-glass가 있을 때만 읽는다(요청마다 시계를 읽지 않는다 — 가상 시계·고정 시계의 시각을 소모하지 않게).
 */
export async function activeBreakGlass(tx: Tx, userId: string, now: () => string): Promise<BreakGlass | undefined> {
  const r = (await tx.query("SELECT * FROM break_glass WHERE user_id = $1 AND ended_at IS NULL ORDER BY expires_at DESC LIMIT 1", [userId])).rows[0];
  if (r === undefined || iso(r.expires_at)! <= now()) return undefined;
  return toBreakGlass(r);
}

/** 이 트랜잭션에서 대상 테넌트 소유 데이터에 쓸 수 있게 한다(RLS rc_can_write가 rc.break_glass_tenant를 본다). */
export async function applyBreakGlass(tx: Tx, bg: BreakGlass): Promise<void> {
  await tx.query("SELECT set_config('rc.break_glass_tenant', $1, true)", [bg.targetTenantId]);
}

/** break-glass 시작: 플랫폼 운영(SPACE_OPS)만, 대상 테넌트·사유 필수, 1~60분. 같은 사용자는 동시에 하나만. */
export async function startBreakGlass(tx: Tx, clock: Clock, actor: Actor, input: { targetTenantId?: string; reason?: string; minutes?: number }): Promise<BreakGlass> {
  requireRole(actor, "SPACE_OPS");
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "break-glass is for platform operators");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (typeof input.targetTenantId !== "string" || reason === "") throw new DomainError("BAD_REQUEST", 400, "targetTenantId and reason are required");
  const minutes = input.minutes ?? 30;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > BG_MAX_MINUTES) throw new DomainError("BAD_REQUEST", 400, `minutes must be 1..${BG_MAX_MINUTES}`);
  const tenant = (await tx.query("SELECT tenant_type FROM tenant WHERE tenant_id = $1", [input.targetTenantId])).rows[0];
  if (tenant === undefined) throw notFound("tenant", input.targetTenantId);
  if (tenant.tenant_type === "PLATFORM_OPS") throw new DomainError("BAD_REQUEST", 400, "break-glass targets a rights-holder tenant");
  const now = clock.now();
  if (await activeBreakGlass(tx, actor.userId, () => now)) throw conflict("BREAK_GLASS_ACTIVE", `${actor.userId} already has an active break-glass`);
  const expires = new Date(Date.parse(now) + minutes * 60_000).toISOString();
  const r = (await tx.query(
    "INSERT INTO break_glass (user_id, target_tenant_id, reason, started_at, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [actor.userId, input.targetTenantId, reason, now, expires],
  )).rows[0];
  const bg = toBreakGlass(r);
  await audit(tx, clock, { actor: actor.userId, action: "BREAK_GLASS_START", entityType: "break_glass", entityId: String(bg.breakGlassId), after: { targetTenantId: bg.targetTenantId, reason, expiresAt: expires } });
  return bg;
}

export async function endBreakGlass(tx: Tx, clock: Clock, actor: Actor, breakGlassId: number): Promise<BreakGlass> {
  const r = (await tx.query("SELECT * FROM break_glass WHERE break_glass_id = $1 FOR UPDATE", [breakGlassId])).rows[0];
  if (r === undefined || r.user_id !== actor.userId) throw notFound("break-glass", String(breakGlassId));
  if (r.ended_at !== null) throw conflict("BREAK_GLASS_ENDED", `break-glass ${breakGlassId} already ended`);
  const now = clock.now();
  const ended = (await tx.query("UPDATE break_glass SET ended_at = GREATEST($2::timestamptz, started_at) WHERE break_glass_id = $1 RETURNING *", [breakGlassId, now])).rows[0];
  await audit(tx, clock, { actor: actor.userId, action: "BREAK_GLASS_END", entityType: "break_glass", entityId: String(breakGlassId) });
  return toBreakGlass(ended);
}

export async function listBreakGlass(tx: Tx): Promise<BreakGlass[]> {
  return (await tx.query("SELECT * FROM break_glass ORDER BY break_glass_id DESC LIMIT 200")).rows.map(toBreakGlass);
}

/** 열람 기록 한 건. 같은 트랜잭션에서 남기므로 응답이 나가면 기록도 남아 있다. */
export async function recordInspection(
  tx: Tx, clock: Clock, actor: Actor,
  e: { targetTenantId: string; nodeType: string; nodeId: string; panel: Panel; ip: string; piiUnmasked?: boolean; reason?: string; breakGlassId?: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO inspection_audit_log (occurred_at, actor_user_id, target_tenant_id, node_type, node_id, panel, pii_unmasked, reason, break_glass_id, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [clock.now(), actor.userId, e.targetTenantId, e.nodeType, e.nodeId, e.panel, e.piiUnmasked ?? false, e.reason ?? null, e.breakGlassId ?? null, e.ip],
  );
}

/**
 * 운영 채널에서 열람을 기록하는 상세 경로와, 그 레코드를 소유한 테넌트를 찾는 법. 목록·집계는 기록하지 않는다.
 * 플랫폼 자기 데이터(소유 테넌트가 플랫폼)면 기록하지 않는다.
 */
const INSPECTED: Record<string, { nodeType: string; panel: Panel; param: string; owner: string }> = {
  "/scopes/:id": { nodeType: "facts_scope", panel: "RIGHTS_IMAGE", param: "id", owner: "SELECT owner_tenant_id FROM facts_scope WHERE facts_scope_id = $1" },
  "/scopes/:id/summary": { nodeType: "facts_scope", panel: "RIGHTS_IMAGE", param: "id", owner: "SELECT owner_tenant_id FROM facts_scope WHERE facts_scope_id = $1" },
  "/scopes/:id/facts": { nodeType: "facts_scope", panel: "RIGHTS_IMAGE", param: "id", owner: "SELECT owner_tenant_id FROM facts_scope WHERE facts_scope_id = $1" },
  "/policies/:policyId/versions": { nodeType: "policy", panel: "RIGHTS_IMAGE", param: "policyId", owner: "SELECT owner_tenant_id FROM policy_version WHERE policy_id = $1 LIMIT 1" },
  "/policies/:policyId/versions/:version": { nodeType: "policy", panel: "RIGHTS_IMAGE", param: "policyId", owner: "SELECT owner_tenant_id FROM policy_version WHERE policy_id = $1 LIMIT 1" },
  "/packs/:id": { nodeType: "vocal_pack", panel: "PACK", param: "id", owner: "SELECT owner_tenant_id FROM vocal_pack WHERE pack_id = $1" },
  "/issues/:snapshotId/audit": { nodeType: "rights_snapshot", panel: "PACK", param: "snapshotId", owner: "SELECT p.owner_tenant_id FROM rights_snapshot s JOIN vocal_pack p ON p.pack_id = s.pack_id WHERE s.snapshot_id = $1" },
  "/documents/:id": { nodeType: "source_document", panel: "SOURCE_DOCUMENT", param: "id", owner: "SELECT owner_tenant_id FROM source_document WHERE document_id = $1 LIMIT 1" },
  "/documents/:id/versions/:v/file": { nodeType: "source_document", panel: "SOURCE_DOCUMENT", param: "id", owner: "SELECT owner_tenant_id FROM source_document WHERE document_id = $1 LIMIT 1" },
  "/consents/:id": { nodeType: "consent_agreement", panel: "RIGHTS_IMAGE", param: "id", owner: "SELECT owner_tenant_id FROM consent_agreement WHERE consent_id = $1" },
  "/parties/:id/statements": { nodeType: "party", panel: "SETTLEMENT_TRACE", param: "id", owner: "SELECT tenant_id FROM party WHERE party_id = $1" },
  "/parties/:id/payout-profile": { nodeType: "party", panel: "PARTY", param: "id", owner: "SELECT tenant_id FROM party WHERE party_id = $1" },
  "/payouts/:id": { nodeType: "payout_instruction", panel: "PARTY", param: "id", owner: "SELECT p.tenant_id FROM payout_instruction i JOIN party p ON p.party_id = i.party_id WHERE i.instruction_id = $1" },
};

/** 운영 채널 GET이 위 상세 경로면 열람을 기록한다(withActor가 처리기 뒤, 같은 트랜잭션에서 부른다). */
export async function inspectRoute(
  tx: Tx, clock: Clock, actor: Actor, route: string, params: Record<string, string>, ip: string, breakGlassId?: number,
): Promise<void> {
  const spec = INSPECTED[route];
  if (spec === undefined) return;
  const nodeId = params[spec.param];
  if (nodeId === undefined) return;
  const owner = (await tx.query(spec.owner, [nodeId])).rows[0];
  const tenant = owner === undefined ? undefined : (Object.values(owner)[0] as string);
  if (tenant === undefined || tenant === actor.tenantId) return;
  await recordInspection(tx, clock, actor, { targetTenantId: tenant, nodeType: spec.nodeType, nodeId, panel: spec.panel, ip, ...(breakGlassId !== undefined && { breakGlassId }) });
}

/** 계좌 토큰 마스킹: 끝 4자만 남긴다. */
export function maskRef(ref: string | null): string | null {
  if (ref === null) return null;
  return ref.length <= 4 ? "****" : `****${ref.slice(-4)}`;
}

/**
 * 2단계 마스킹 해제: 요청이 unmask=1이면 사유(reason)를 받아 열람 기록(pii_unmasked)을 남기고 원문을 돌려준다.
 * 해제할 수 있는 권한은 inspection.unmask(정산 담당). 기록은 응답과 같은 트랜잭션이라 기록 없이 원문이 나가지 않는다.
 */
export async function unmaskRequested(
  tx: Tx, clock: Clock, actor: Actor, query: Record<string, unknown>, target: { partyId: string; nodeType: string; nodeId: string; ip: string },
): Promise<boolean> {
  if (query.unmask !== "1" && query.unmask !== "true") return false;
  requirePermission(actor, "inspection.unmask");
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  if (reason === "") throw new DomainError("REASON_REQUIRED", 400, "unmasking needs a reason");
  const tenant = (await tx.query("SELECT tenant_id FROM party WHERE party_id = $1", [target.partyId])).rows[0]?.tenant_id as string | undefined;
  if (tenant === undefined) throw notFound("party", target.partyId);
  await recordInspection(tx, clock, actor, { targetTenantId: tenant, nodeType: target.nodeType, nodeId: target.nodeId, panel: "PARTY", ip: target.ip, piiUnmasked: true, reason });
  return true;
}

export async function listInspections(tx: Tx, f: { tenant?: string; limit?: number }) {
  const p: unknown[] = [];
  let where = "";
  if (f.tenant !== undefined) { p.push(f.tenant); where = "WHERE target_tenant_id = $1"; }
  p.push(Math.min(f.limit ?? 100, 500));
  return (await tx.query(`SELECT * FROM inspection_audit_log ${where} ORDER BY inspection_id DESC LIMIT $${p.length}`, p)).rows.map((r) => ({
    inspectionId: Number(r.inspection_id), occurredAt: iso(r.occurred_at)!, actor: r.actor_user_id as string, targetTenantId: r.target_tenant_id as string,
    nodeType: r.node_type as string, nodeId: r.node_id as string, panel: r.panel as string, piiUnmasked: r.pii_unmasked as boolean,
    ...(r.reason !== null && { reason: r.reason as string }), ...(r.break_glass_id !== null && { breakGlassId: Number(r.break_glass_id) }),
  }));
}
