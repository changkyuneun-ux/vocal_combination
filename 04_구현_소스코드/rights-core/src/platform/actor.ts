import { generateKeyPairSync } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";
import { DomainError } from "./errors.ts";

export type Role = "RIGHTS_EDITOR" | "EDITOR" | "WORK_APPROVER" | "ACTIVATOR" | "ISSUER" | "SPACE_OPS" | "SPACE_SETTLE" | "SYSTEM" | "PERFORMER" | "COMPLIANCE" | "LEGAL";
/**
 * scope: platform = 플랫폼 운영 테넌트 사용자(전체 조회), tenant = 그 외 테넌트 사용자(자기 테넌트 소유·참여 데이터만),
 * party = 소속 없는 개인(개인 기본 테넌트) 사용자(자기 파티의 참여 데이터만). partyId는 본인 파티(실연자·팬 계정)다.
 * 범위는 요청 트랜잭션에 설정되고 RLS가 적용한다(migrations/0017_tenancy.sql, 0018_consent.sql).
 */
export type Actor = { userId: string; roles: ReadonlySet<Role>; tenantId: string; tenantType: string; scope: "platform" | "tenant" | "party"; partyId?: string; partyType?: string };

export const PLATFORM_TENANT = "tnt_platform";

/** 사용자와 역할을 만들고 개발용 Ed25519 키를 발급한다(운영은 KMS — 통합 설계 6.4). */
export async function createUser(tx: Tx, clock: Clock, u: { userId: string; displayName: string; roles: Role[]; tenantId?: string; partyId?: string }): Promise<void> {
  await tx.query("INSERT INTO user_account (user_id, display_name, created_at, tenant_id, party_id) VALUES ($1,$2,$3,$4,$5)",
    [u.userId, u.displayName, clock.now(), u.tenantId ?? PLATFORM_TENANT, u.partyId ?? null]);
  for (const r of u.roles) await tx.query("INSERT INTO portal_role (user_id, role) VALUES ($1,$2)", [u.userId, r]);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await tx.query("INSERT INTO dev_signing_key (user_id, key_version, public_pem, private_pem) VALUES ($1,'dev-1',$2,$3)", [
    u.userId, publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ]);
}

export const SYSTEM_IDENTITIES = ["sys_ingest", "sys_settler", "sys_verifier"] as const;

/**
 * 시스템 신원(수익 수집·정산 실행·정산 검증)을 없으면 만든다(역할 SYSTEM, 개발 서명 키). 여러 번 호출해도 같다.
 * 동시 호출은 트랜잭션 advisory lock으로 직렬화한다. 서버 시작 시 호출은 Task 6에서 main.ts에 연결한다.
 */
export async function ensureSystemIdentities(tx: Tx, clock: Clock): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('rc.system_identities'))");
  const existing = new Set((await tx.query("SELECT user_id FROM user_account WHERE user_id = ANY($1)", [[...SYSTEM_IDENTITIES]])).rows.map((r) => r.user_id as string));
  for (const id of SYSTEM_IDENTITIES) {
    if (!existing.has(id)) await createUser(tx, clock, { userId: id, displayName: id, roles: ["SYSTEM"] });
  }
}

export async function loadActor(tx: Tx, userId: string): Promise<Actor> {
  const u = (await tx.query(
    `SELECT u.tenant_id, u.party_id, t.tenant_type, t.status, p.party_type
       FROM user_account u JOIN tenant t ON t.tenant_id = u.tenant_id LEFT JOIN party p ON p.party_id = u.party_id WHERE u.user_id = $1`, [userId],
  )).rows[0];
  if (u === undefined) throw new DomainError("UNKNOWN_ACTOR", 401, `unknown actor: ${userId}`);
  if (u.status !== "ACTIVE") throw new DomainError("TENANT_INACTIVE", 403, `tenant ${u.tenant_id} is ${u.status}`);
  const roles = (await tx.query("SELECT role FROM portal_role WHERE user_id = $1", [userId])).rows.map((r) => r.role as Role);
  const scope = u.tenant_type === "PLATFORM_OPS" ? "platform" : u.tenant_type === "PLATFORM_DEFAULT" ? "party" : "tenant";
  if (scope === "party" && u.party_id === null) throw new DomainError("PARTY_REQUIRED", 403, `${userId} has no party in the individual tenant`);
  return {
    userId, roles: new Set(roles), tenantId: u.tenant_id as string, tenantType: u.tenant_type as string, scope,
    ...(u.party_id === null ? {} : { partyId: u.party_id as string, partyType: u.party_type as string }),
  };
}

/** 요청 트랜잭션의 조회 범위를 행위자 기준으로 좁힌다. 이후 같은 트랜잭션의 모든 쿼리에 RLS가 적용된다. */
export async function applyActorScope(tx: Tx, actor: Actor): Promise<void> {
  await tx.query("SELECT set_config('rc.scope', $1, true), set_config('rc.tenant_id', $2, true), set_config('rc.party_id', $3, true), set_config('rc.user_id', $4, true)",
    [actor.scope, actor.tenantId, actor.partyId ?? "", actor.userId]);
}

/**
 * 곡 전체를 봐야 하는 내부 계산(facts 봉인·발행 입력)을 잠시 system 범위로 실행한다. 끝나면 원래 범위로 돌린다.
 * 결과 IR은 봉인되어 digest로만 노출되므로, 계산 중 다른 테넌트 행을 읽어도 요청자에게 행이 반환되지는 않는다.
 */
export async function withSystemScope<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const prev = (await tx.query("SELECT current_setting('rc.scope', true) AS s, current_setting('rc.tenant_id', true) AS t")).rows[0];
  await tx.query("SELECT set_config('rc.scope', 'system', true)");
  try {
    return await fn();
  } finally {
    await tx.query("SELECT set_config('rc.scope', $1, true), set_config('rc.tenant_id', $2, true)", [prev.s ?? "", prev.t ?? ""]);
  }
}

export function requireRole(actor: Actor, role: Role): void {
  if (!actor.roles.has(role)) throw new DomainError("ROLE_REQUIRED", 403, `${actor.userId} lacks role ${role}`);
}

/** 역할 중 하나라도 있으면 통과한다. 하나도 없으면 403 ROLE_REQUIRED. */
export function requireAnyRole(actor: Actor, roles: readonly Role[]): void {
  if (!roles.some((r) => actor.roles.has(r))) throw new DomainError("ROLE_REQUIRED", 403, `${actor.userId} lacks any of roles ${roles.join(", ")}`);
}
