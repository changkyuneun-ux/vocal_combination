import { generateKeyPairSync } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";
import { DomainError } from "./errors.ts";

export type Role = "RIGHTS_EDITOR" | "EDITOR" | "WORK_APPROVER" | "ACTIVATOR" | "ISSUER" | "SPACE_OPS" | "SPACE_SETTLE" | "SYSTEM" | "PERFORMER" | "COMPLIANCE" | "LEGAL"
  | "TENANT_ADMIN" | "ONBOARDING" | "TRUST_OFFICER" | "PARTNER_INTEGRATION";
/** 참여 구분(테넌트 정책 2절, 결정 TD1): 권리 테넌트·참여 기관·개인·플랫폼 운영. */
export type OrgClass = "RIGHTS" | "PARTICIPANT" | "INDIVIDUAL" | "PLATFORM";
export type TenantStatus = "APPLIED" | "VERIFIED" | "ACTIVE" | "SUSPENDED" | "TERMINATED";
/**
 * scope: platform = 플랫폼 운영 테넌트 사용자(전체 조회), tenant = 그 외 테넌트 사용자(자기 테넌트 소유·참여 데이터만),
 * party = 소속 없는 개인(개인 기본 테넌트) 사용자(자기 파티의 참여 데이터만). partyId는 본인 파티(실연자·팬 계정)다.
 * 범위는 요청 트랜잭션에 설정되고 RLS가 적용한다(migrations/0017_tenancy.sql, 0018_consent.sql).
 * tenantId는 지금 일하는 소속이고(결정 TD9 — 한 계정 여러 소속), roles는 그 소속에서의 역할이다. readOnly는 신청·정지 상태 조직의
 * 관리자 로그인(열람만, 결정 TD7)이다.
 */
export type Actor = {
  userId: string; roles: ReadonlySet<Role>; tenantId: string; tenantType: string; orgClass: OrgClass; tenantStatus: TenantStatus;
  scope: "platform" | "tenant" | "party"; partyId?: string; partyType?: string; readOnly?: boolean;
  /** 위임 대행(TN6): 플랫폼 온보딩이 이 테넌트 권한으로 일하는 중. tenantId도 이 테넌트다. */
  actingOnBehalfOf?: string;
};

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

/**
 * 행위자를 읽는다. tenantId를 주면 그 소속으로(소속이 없으면 403 MEMBERSHIP_REQUIRED), 안 주면 기본 소속으로 읽는다.
 * 조직 상태(결정 TD7): 해지는 로그인 불가, 신청·정지는 조직 관리자만 열람으로 들어온다(readOnly), 확인됨·활성은 정상.
 */
export async function loadActor(tx: Tx, userId: string, tenantId?: string): Promise<Actor> {
  const u = (await tx.query(
    "SELECT u.tenant_id, u.party_id, p.party_type FROM user_account u LEFT JOIN party p ON p.party_id = u.party_id WHERE u.user_id = $1", [userId],
  )).rows[0];
  if (u === undefined) throw new DomainError("UNKNOWN_ACTOR", 401, `unknown actor: ${userId}`);
  const tid = tenantId ?? (u.tenant_id as string);
  const t = (await tx.query(
    `SELECT t.tenant_type, t.org_class, t.status FROM user_membership m JOIN tenant t ON t.tenant_id = m.tenant_id WHERE m.user_id = $1 AND m.tenant_id = $2`, [userId, tid],
  )).rows[0];
  if (t === undefined) throw new DomainError("MEMBERSHIP_REQUIRED", 403, `${userId} is not a member of ${tid}`);
  const roles = new Set((await tx.query("SELECT role FROM portal_role WHERE user_id = $1 AND tenant_id = $2", [userId, tid])).rows.map((r) => r.role as Role));
  const status = t.status as TenantStatus;
  if (status === "TERMINATED") throw new DomainError("TENANT_INACTIVE", 403, `tenant ${tid} is TERMINATED`);
  const readOnly = status === "APPLIED" || status === "SUSPENDED";
  if (readOnly && !roles.has("TENANT_ADMIN")) throw new DomainError("TENANT_INACTIVE", 403, `tenant ${tid} is ${status}; only its administrator can sign in`);
  const orgClass = t.org_class as OrgClass;
  const scope = orgClass === "PLATFORM" ? "platform" : orgClass === "INDIVIDUAL" ? "party" : "tenant";
  if (scope === "party" && u.party_id === null) throw new DomainError("PARTY_REQUIRED", 403, `${userId} has no party in the individual tenant`);
  return {
    userId, roles, tenantId: tid, tenantType: t.tenant_type as string, orgClass, tenantStatus: status, scope,
    ...(u.party_id === null ? {} : { partyId: u.party_id as string, partyType: u.party_type as string }),
    ...(readOnly && { readOnly: true }),
  };
}

/** 계정의 소속 목록(기본 소속 먼저). */
export async function listMemberships(tx: Tx, userId: string): Promise<{ tenantId: string; name: string; tenantType: string; orgClass: OrgClass; status: TenantStatus; home: boolean; roles: Role[] }[]> {
  return (await tx.query(
    `SELECT m.tenant_id, t.name, t.tenant_type, t.org_class, t.status, m.tenant_id = u.tenant_id AS home,
            COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM user_membership m JOIN user_account u ON u.user_id = m.user_id JOIN tenant t ON t.tenant_id = m.tenant_id
       LEFT JOIN portal_role r ON r.user_id = m.user_id AND r.tenant_id = m.tenant_id
      WHERE m.user_id = $1 GROUP BY m.tenant_id, t.name, t.tenant_type, t.org_class, t.status, u.tenant_id ORDER BY (m.tenant_id = u.tenant_id) DESC, m.tenant_id`, [userId],
  )).rows.map((r) => ({ tenantId: r.tenant_id, name: r.name, tenantType: r.tenant_type, orgClass: r.org_class, status: r.status, home: r.home, roles: r.roles }));
}

/** 요청 트랜잭션의 조회 범위를 행위자 기준으로 좁힌다. 이후 같은 트랜잭션의 모든 쿼리에 RLS가 적용된다. */
export async function applyActorScope(tx: Tx, actor: Actor): Promise<void> {
  await tx.query("SELECT set_config('rc.scope', $1, true), set_config('rc.tenant_id', $2, true), set_config('rc.party_id', $3, true), set_config('rc.user_id', $4, true), set_config('rc.on_behalf_of', $5, true)",
    [actor.scope, actor.tenantId, actor.partyId ?? "", actor.userId, actor.actingOnBehalfOf ?? ""]);
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
