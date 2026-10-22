import { requireAnyRole, type Actor } from "./actor.ts";
import { audit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import { iso, type Tx } from "./db.ts";
import { DomainError, invalid, notFound } from "./errors.ts";
import type { Permission } from "./permissions.ts";

/**
 * 위임 대행(테넌트 정책 TR5·TN6, 데이터모델 v2.8 tenant.ops_delegation·audit_log.acting_on_behalf_of).
 * 권리 테넌트 관리자가 맡긴 업무만 플랫폼 온보딩(ONBOARDING)이 권리자 포털에서 그 테넌트 권한으로 대행한다. 대행하는 동안
 * 요청 범위는 그 테넌트로 좁혀지고(다른 테넌트 데이터는 보이지 않는다), 감사 로그에 대상 테넌트가 남는다.
 * 정책 편집·승인·활성화·발행은 위임할 수 없다(플랫폼은 권리를 결정하지 않는다).
 */
export const DELEGABLE = ["RIGHTS_ENTRY"] as const;
export type DelegableTask = (typeof DELEGABLE)[number];

/** 플랫폼 행위자를 그 테넌트의 대행자로 바꾼다. 위임이 없거나 활성·확인됨이 아니면 거부한다. */
export async function delegatedActor(tx: Tx, actor: Actor, tenantId: string): Promise<Actor> {
  if (actor.scope !== "platform") throw new DomainError("DELEGATION_FORBIDDEN", 403, "only platform operators act on behalf of a tenant");
  requireAnyRole(actor, ["ONBOARDING"]);
  const t = (await tx.query("SELECT tenant_type, org_class, status, ops_delegation FROM tenant WHERE tenant_id = $1", [tenantId])).rows[0];
  if (t === undefined) throw notFound("tenant", tenantId);
  if (t.org_class !== "RIGHTS") throw invalid("BAD_REQUEST", "delegation is for rights tenants");
  if (t.status !== "ACTIVE" && t.status !== "VERIFIED") throw new DomainError("TENANT_INACTIVE", 403, `tenant ${tenantId} is ${t.status}`);
  const tasks = (t.ops_delegation as string[]).filter((x): x is DelegableTask => (DELEGABLE as readonly string[]).includes(x));
  if (tasks.length === 0) throw new DomainError("NOT_DELEGATED", 403, `${tenantId} has not delegated any work to the platform`);
  const perms = new Set((await tx.query("SELECT perm_id FROM delegable_task_permission WHERE task = ANY($1)", [tasks])).rows.map((r) => r.perm_id as Permission));
  // roles는 화면 표시용(위임 업무 RIGHTS_ENTRY = 권리 편집). 검사는 permissions로 한다.
  return {
    userId: actor.userId, roles: new Set(["RIGHTS_EDITOR"]), permissions: perms, tenantId, tenantType: t.tenant_type, orgClass: "RIGHTS", tenantStatus: t.status,
    scope: "tenant", actingOnBehalfOf: tenantId,
  };
}

/** 위임 업무 정하기: 그 테넌트의 조직 관리자만(자기 조직). 빈 목록이면 위임을 거둔다. */
export async function setDelegation(tx: Tx, clock: Clock, actor: Actor, tenantId: string, tasks: unknown) {
  if (actor.actingOnBehalfOf !== undefined) throw new DomainError("DELEGATION_FORBIDDEN", 403, "a delegate cannot change the delegation");
  if (actor.scope === "platform" || actor.tenantId !== tenantId || !actor.roles.has("TENANT_ADMIN")) {
    throw new DomainError("ROLE_REQUIRED", 403, "only the tenant's administrator delegates work to the platform");
  }
  if (!Array.isArray(tasks) || !tasks.every((x) => (DELEGABLE as readonly string[]).includes(x))) throw invalid("BAD_REQUEST", `tasks must be among ${DELEGABLE.join(", ")}`);
  const next = [...new Set(tasks as string[])].sort();
  const before = (await tx.query("SELECT ops_delegation FROM tenant WHERE tenant_id = $1", [tenantId])).rows[0]?.ops_delegation as string[];
  await tx.query("UPDATE tenant SET ops_delegation = $2 WHERE tenant_id = $1", [tenantId, next]);
  await audit(tx, clock, { actor: actor.userId, action: "DELEGATION_SET", entityType: "tenant", entityId: tenantId, after: { before, tasks: next } });
  return { tenantId, tasks: next };
}

export async function getDelegation(tx: Tx, tenantId: string) {
  const t = (await tx.query("SELECT ops_delegation FROM tenant WHERE tenant_id = $1", [tenantId])).rows[0];
  if (t === undefined) throw notFound("tenant", tenantId);
  return { tenantId, tasks: t.ops_delegation as string[], available: [...DELEGABLE] };
}

/** 대행 기록: 그 테넌트를 대신해 한 일(감사 로그). 시스템 범위에서 부른다. */
export async function delegationLog(tx: Tx, tenantId: string, limit = 200) {
  return (await tx.query(
    "SELECT audit_id, occurred_at, actor_user_id, action_name, entity_type, entity_id FROM audit_log WHERE acting_on_behalf_of = $1 ORDER BY audit_id DESC LIMIT $2", [tenantId, limit],
  )).rows.map((r) => ({ auditId: Number(r.audit_id), occurredAt: iso(r.occurred_at)!, actor: r.actor_user_id as string, action: r.action_name as string, entityType: r.entity_type as string, entityId: r.entity_id as string }));
}
