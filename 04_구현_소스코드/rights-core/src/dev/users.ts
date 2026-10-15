import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { createUser, ensureSystemIdentities, type Role } from "../platform/actor.ts";

/** 개발 사용자(통합 설계 12.2-2). 백오피스의 사용자 전환 목록이다. */
/** 개발용 권리자 테넌트(권리자 포털 확인용). 플랫폼 운영 테넌트 밖이라 포털에서 자기 테넌트 데이터만 보인다. */
export const DEV_TENANT = { tenantId: "tnt_dev_label", tenantType: "LABEL", name: "개발 레이블" } as const;
/** 개발용 파트너 테넌트(연동 허브 파트너 채널 확인용). */
export const DEV_PARTNER = { tenantId: "tnt_dev_partner", tenantType: "B2B_PARTNER", name: "개발 유통 파트너" } as const;

export const DEV_USERS: readonly { userId: string; displayName: string; roles: Role[]; tenantId?: string }[] = [
  { userId: "usr_editor", displayName: "편집자", roles: ["RIGHTS_EDITOR", "EDITOR"] },
  { userId: "usr_approver", displayName: "승인자", roles: ["WORK_APPROVER"] },
  { userId: "usr_activator", displayName: "활성화 담당", roles: ["ACTIVATOR"] },
  { userId: "usr_issuer", displayName: "발행 담당", roles: ["ISSUER"] },
  { userId: "usr_ops", displayName: "정산 운영", roles: ["SPACE_OPS"] },
  { userId: "usr_settle", displayName: "정산 담당", roles: ["SPACE_SETTLE"] },
  { userId: "usr_settle2", displayName: "정산 담당 2", roles: ["SPACE_SETTLE"] },
  { userId: "usr_compliance", displayName: "컴플라이언스", roles: ["COMPLIANCE"] },
  { userId: "usr_label", displayName: "레이블 담당(포털)", roles: ["RIGHTS_EDITOR", "EDITOR"], tenantId: DEV_TENANT.tenantId },
  { userId: "usr_partner", displayName: "유통 파트너(연동)", roles: [], tenantId: DEV_PARTNER.tenantId },
];

/** 없는 개발 사용자만 만들고 시스템 신원도 보장한다(멱등, advisory lock으로 동시 호출을 직렬화). */
export async function ensureDevUsers(tx: Tx, clock: Clock): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('rc.dev_users'))");
  for (const t of [DEV_TENANT, DEV_PARTNER]) {
    await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id) DO NOTHING",
      [t.tenantId, t.tenantType, t.name, clock.now()]);
  }
  const existing = new Set((await tx.query("SELECT user_id FROM user_account WHERE user_id = ANY($1)", [DEV_USERS.map((u) => u.userId)])).rows.map((r) => r.user_id as string));
  for (const u of DEV_USERS) if (!existing.has(u.userId)) await createUser(tx, clock, { ...u, roles: [...u.roles] });
  await ensureSystemIdentities(tx, clock);
}
