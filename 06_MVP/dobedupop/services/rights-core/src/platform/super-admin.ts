import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";
import { createUser, PLATFORM_TENANT, withSystemScope, type OrgClass, type Role } from "./actor.ts";
import { invalid } from "./errors.ts";
import { audit } from "./audit.ts";

const SUPER: Partial<Record<OrgClass, Role>> = { RIGHTS: "RIGHTS_ALL", PARTICIPANT: "PARTICIPANT_ALL" };

/**
 * 총괄 계정(결정 RD1): 플랫폼 기본 소속에 PLATFORM_ALL, 각 조직(권리 테넌트·참여 기관) 소속에 그 구분의 총괄 역할. 여러 번 불러도 같다.
 * 데모·MVP 운영 시드가 부른다. 로그인은 운영과 같다(비밀번호 + TOTP, 결정 RD7).
 */
export async function ensureSuperAdmin(tx: Tx, clock: Clock, a: { userId: string; displayName: string; tenantIds: readonly string[] }): Promise<void> {
  await withSystemScope(tx, async () => {
    if ((await tx.query("SELECT 1 FROM user_account WHERE user_id = $1", [a.userId])).rowCount === 0) {
      await createUser(tx, clock, { userId: a.userId, displayName: a.displayName, roles: ["PLATFORM_ALL"], tenantId: PLATFORM_TENANT });
      await audit(tx, clock, { actor: a.userId, action: "SUPER_ADMIN_CREATE", entityType: "user_account", entityId: a.userId });
    }
    for (const tenantId of a.tenantIds) {
      const t = (await tx.query("SELECT org_class FROM tenant WHERE tenant_id = $1", [tenantId])).rows[0];
      const role = t === undefined ? undefined : SUPER[t.org_class as OrgClass];
      if (role === undefined) throw invalid("BAD_REQUEST", `${tenantId} is not a rights tenant or participant organization`);
      await tx.query("INSERT INTO user_membership (user_id, tenant_id, added_by, added_at) VALUES ($1,$2,$1,$3) ON CONFLICT DO NOTHING", [a.userId, tenantId, clock.now()]);
      await tx.query("INSERT INTO portal_role (user_id, tenant_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [a.userId, tenantId, role]);
    }
  });
}
