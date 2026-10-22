import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { ensureDevUsers, DEV_TENANT, DEV_PARTNER } from "../../src/dev/users.ts";
import { loadActor } from "../../src/platform/actor.ts";
import { hasPermission, ALL_PERMISSIONS, PERMISSIONS } from "../../src/platform/permissions.ts";
import { allowed } from "../../src/http/channels.ts";
import { ensureSuperAdmin } from "../../src/platform/super-admin.ts";
import { setRoles, setDisabled } from "../../src/platform/auth.ts";

// 총괄(총괄 운영과 권한 구조 RS4): 한 계정, 소속 셋. 권리 결정은 권리 테넌트 소속일 때만(TR5), 채널은 소속의 참여 구분대로.
const { db, drop } = await freshDb();
after(drop);
const clock = fixedClock("2026-01-01T00:00:00.000Z", 0);
await db.tx((tx) => ensureDevUsers(tx, clock));
await db.tx((tx) => ensureSuperAdmin(tx, clock, { userId: "usr_admin", displayName: "총괄", tenantIds: [DEV_TENANT.tenantId, DEV_PARTNER.tenantId] }));
await db.tx((tx) => ensureSuperAdmin(tx, clock, { userId: "usr_admin", displayName: "총괄", tenantIds: [DEV_TENANT.tenantId, DEV_PARTNER.tenantId] })); // 멱등

const of = (cls: string) => ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].assignable && (PERMISSIONS[p].orgClasses as readonly string[]).includes(cls)).sort();

test("ALL roles hold every assignable permission of their org class", async () => {
  for (const [role, cls] of [["PLATFORM_ALL", "PLATFORM"], ["RIGHTS_ALL", "RIGHTS"], ["PARTICIPANT_ALL", "PARTICIPANT"]] as const) {
    const got = (await db.pool.query("SELECT perm_id FROM role_permission WHERE role_id = $1 ORDER BY perm_id", [role])).rows.map((r) => r.perm_id);
    assert.deepEqual(got, of(cls), role);
  }
});

test("the super admin works by membership: platform intervenes, the rights tenant decides", async () => {
  const platform = await db.tx((tx) => loadActor(tx, "usr_admin"));
  assert.ok(hasPermission(platform, "settlement.confirm") && hasPermission(platform, "tenant.onboard"));
  assert.ok(!hasPermission(platform, "policy.approve"), "the platform does not decide rights (TR5)");
  assert.ok(allowed("ops", platform) && !allowed("partner", platform));
  const label = await db.tx((tx) => loadActor(tx, "usr_admin", DEV_TENANT.tenantId));
  assert.ok(hasPermission(label, "policy.edit") && hasPermission(label, "policy.approve") && hasPermission(label, "policy.activate") && hasPermission(label, "account.manage"));
  assert.ok(!hasPermission(label, "settlement.confirm"));
  assert.ok(allowed("portal", label) && !allowed("ops", label), "the rights membership cannot use the ops channel");
  const partner = await db.tx((tx) => loadActor(tx, "usr_admin", DEV_PARTNER.tenantId));
  assert.ok(hasPermission(partner, "asset.propose") && allowed("partner", partner) && !allowed("portal", partner));
});

test("the last super admin cannot lose the role or be locked", async () => {
  const ops = await db.tx((tx) => loadActor(tx, "usr_ops"));
  await assert.rejects(db.tx((tx) => setRoles(tx, clock, ops, "usr_admin", ["SPACE_OPS"], "tnt_platform")), { code: "LAST_SUPER_ADMIN", status: 409 });
  await assert.rejects(db.tx((tx) => setDisabled(tx, clock, ops, "usr_admin", true)), { code: "LAST_SUPER_ADMIN", status: 409 });
});
