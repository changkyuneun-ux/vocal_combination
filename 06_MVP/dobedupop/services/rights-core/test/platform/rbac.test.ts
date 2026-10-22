import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { freshDb } from "../helpers.ts";
import { PERMISSIONS, ALL_PERMISSIONS } from "../../src/platform/permissions.ts";

// 기능–권한–역할(총괄 운영과 권한 구조 RS1): 코드의 권한 목록과 DB가 같고, 지금 역할은 legacy 역할로 같은 권한을 갖는다.
const { db, adminUrl, drop } = await freshDb();
import { ensureDevUsers } from "../../src/dev/users.ts";
import { fixedClock } from "../../src/platform/clock.ts";
await db.tx((tx) => ensureDevUsers(tx, fixedClock("2026-01-01T00:00:00.000Z", 0)));
after(drop);

test("permission table matches the code catalog", async () => {
  const rows = (await db.pool.query("SELECT perm_id, area, kind, org_classes, assignable FROM permission ORDER BY perm_id")).rows;
  assert.deepEqual(rows.map((r) => r.perm_id), [...ALL_PERMISSIONS].sort());
  for (const r of rows) {
    const p = PERMISSIONS[r.perm_id as keyof typeof PERMISSIONS];
    assert.deepEqual({ area: r.area, kind: r.kind, orgClasses: [...r.org_classes].sort(), assignable: r.assignable },
      { area: p.area, kind: p.kind, orgClasses: [...p.orgClasses].sort(), assignable: p.assignable }, r.perm_id);
  }
});

test("legacy roles carry exactly the permissions of today's role checks", async () => {
  const rows = (await db.pool.query("SELECT rp.role_id, rp.perm_id FROM role_permission rp JOIN role r USING (role_id) WHERE r.legacy")).rows;
  const got = rows.map((r) => `${r.role_id}:${r.perm_id}`).sort();
  const want = ALL_PERMISSIONS.flatMap((p) => PERMISSIONS[p].legacy.map((role) => `${role}:${p}`)).sort();
  assert.deepEqual(got, want);
});

test("a role of one org class cannot take a permission of another, nor be given in another org", async () => {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query("INSERT INTO role (role_id, name, org_class) VALUES ('T_PLATFORM', '시험', 'PLATFORM')");
    await assert.rejects(c.query("INSERT INTO role_permission VALUES ('T_PLATFORM', 'policy.approve')"), /ROLE_CLASS_MISMATCH/);
    await assert.rejects(c.query("INSERT INTO role_permission VALUES ('T_PLATFORM', 'revenue.ingest')"), /PERMISSION_NOT_ASSIGNABLE/);
    await c.query("INSERT INTO role_permission VALUES ('T_PLATFORM', 'settlement.confirm')");
    await assert.rejects(c.query("INSERT INTO portal_role (user_id, tenant_id, role) SELECT user_id, tenant_id, 'T_PLATFORM' FROM user_membership m JOIN tenant t USING (tenant_id) WHERE t.org_class = 'RIGHTS' LIMIT 1"), /ROLE_CLASS_MISMATCH/);
    await assert.rejects(c.query("INSERT INTO portal_role (user_id, tenant_id, role) VALUES ('sys_ingest', 'tnt_platform', 'NO_SUCH_ROLE')"), /foreign key/);
  } finally {
    await c.end();
  }
});
