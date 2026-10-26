import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { freshDb } from "../helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";

// 컴파일 조건(2026-10-26, Butter 따라 해 보기 막힌 곳 8): 권리 테넌트의 곡은 곡 진행 ①~④가 끝나야 컴파일(IR 생성)한다.
// 플랫폼 소유 시험 곡(절차 도입 전 픽스처)은 이 검사 밖이다.
const { db, adminUrl, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
const users = await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_gate_label', 'LABEL', '게이트 레이블', $1)", [T0]);
  const u = await seedUsers(tx, fixedClock(T0, 0));
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova pack", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
  return u;
});
const setOwner = async (tenantId: string) => {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query("UPDATE facts_scope SET owner_tenant_id = $1 WHERE facts_scope_id = $2", [tenantId, SCOPE]); } finally { await c.end(); }
};
const compile = () => db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));

test("a rights tenant's song cannot be compiled until progress ①~④ is done (409 PROGRESS_INCOMPLETE, first open step named)", async () => {
  await setOwner("tnt_gate_label");
  await assert.rejects(compile(), (e: any) => {
    assert.equal(e.code, "PROGRESS_INCOMPLETE");
    assert.equal(e.status, 409);
    assert.match(e.message, /^① 원본 계약서가 끝나지 않았다/);
    assert.ok(e.diagnostics.some((d: any) => d.path === "$.progress.license" && d.message.startsWith("④ 이용 허락")), JSON.stringify(e.diagnostics));
    return true;
  });
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM policy_version WHERE policy_id = 'pol_nova'")).rows[0].n, 0);
});

test("a platform-owned fixture song (before the procedure) still compiles", async () => {
  await setOwner("tnt_platform");
  assert.equal((await compile()).version, 1);
});
