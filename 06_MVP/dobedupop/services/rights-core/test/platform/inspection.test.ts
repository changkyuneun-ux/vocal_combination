import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../src/platform/actor.ts";
import type { Clock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { settlementWorld } from "../settlement-fixtures.ts";

// 플랫폼 조회의 단계별 통제(다음 작업 7): 1 열람 기록, 2 마스킹 해제(read-money 테스트), 3 break-glass.
const w = await settlementWorld();
let now = Date.parse("2026-02-10T00:00:00.000Z");
const clock: Clock = { now: () => new Date(now).toISOString() };
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });

await w.db.tx(async (tx) => {
  const c0 = { now: () => "2026-01-01T00:00:00.000Z" };
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_lbl','LABEL','label',$1), ('tnt_other','LABEL','other',$1)", ["2026-01-01T00:00:00.000Z"]);
  await createUser(tx, c0, { userId: "usr_lbl", displayName: "label", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_other", displayName: "other", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_other" });
  await createUser(tx, c0, { userId: "usr_ops_editor", displayName: "ops editor", roles: ["SPACE_OPS", "RIGHTS_EDITOR"] });
});

const call = (method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url} as ${actor}: ${r.body}`);
  return r.json();
};
const inspections = async () => (await w.db.pool.query("SELECT actor_user_id, target_tenant_id, node_type, node_id, panel FROM inspection_audit_log ORDER BY inspection_id")).rows;

// 레이블이 자기 곡을 등록한다(소유 테넌트 tnt_lbl).
await json("POST", "/portal/works", "usr_lbl", 201, { workId: "wrk_lbl", title: "L" });
await json("POST", "/portal/scopes", "usr_lbl", 201, { factsScopeId: "fsc_lbl", workId: "wrk_lbl" });

test("level 1: an operator opening another tenant's record is logged; lists and platform-owned records are not", async () => {
  await json("GET", "/ops/works", "usr_rights", 200);
  await json("GET", "/ops/scopes/fsc_nova", "usr_rights", 200);
  assert.deepEqual(await inspections(), []);
  await json("GET", "/ops/scopes/fsc_lbl", "usr_rights", 200);
  assert.deepEqual(await inspections(), [{ actor_user_id: "usr_rights", target_tenant_id: "tnt_lbl", node_type: "facts_scope", node_id: "fsc_lbl", panel: "RIGHTS_IMAGE" }]);
});

test("transparency: a tenant sees who inspected its data; other tenants see nothing", async () => {
  const mine = await json("GET", "/portal/inspections", "usr_lbl", 200);
  assert.deepEqual(mine.map((i: any) => [i.actor, i.nodeId]), [["usr_rights", "fsc_lbl"]]);
  assert.deepEqual(await json("GET", "/portal/inspections", "usr_other", 200), []);
});

test("level 3: the platform cannot change a tenant's rights data without break-glass", async () => {
  const r = await json("POST", "/ops/recordings", "usr_ops_editor", 403, { recordingId: "rcd_by_ops", workId: "wrk_lbl", masterOwnerPartyId: "pty_label", versionTitle: "x" });
  assert.equal(r.code, "TENANT_FORBIDDEN");
});

test("break-glass: SPACE_OPS with a target tenant, a reason and at most 60 minutes; writes become the tenant's and are visible to it", async () => {
  await json("POST", "/ops/break-glass", "usr_rights", 403, { targetTenantId: "tnt_lbl", reason: "x" });
  await json("POST", "/ops/break-glass", "usr_ops_editor", 400, { targetTenantId: "tnt_lbl", reason: " " });
  await json("POST", "/ops/break-glass", "usr_ops_editor", 400, { targetTenantId: "tnt_lbl", reason: "x", minutes: 61 });
  const bg = await json("POST", "/ops/break-glass", "usr_ops_editor", 201, { targetTenantId: "tnt_lbl", reason: "레이블 요청 #12: 녹음 등록 대행", minutes: 10 });
  await json("POST", "/ops/break-glass", "usr_ops_editor", 409, { targetTenantId: "tnt_lbl", reason: "again" });
  await json("POST", "/ops/recordings", "usr_ops_editor", 201, { recordingId: "rcd_by_ops", workId: "wrk_lbl", masterOwnerPartyId: "pty_label", versionTitle: "x" });
  const owner = (await w.db.pool.query("SELECT owner_tenant_id FROM recording_version WHERE recording_id = 'rcd_by_ops'")).rows[0].owner_tenant_id;
  assert.equal(owner, "tnt_lbl", "a row created under break-glass belongs to the target tenant");
  // 다른 테넌트에는 여전히 쓸 수 없다.
  await json("POST", "/portal/works", "usr_other", 201, { workId: "wrk_other", title: "O" });
  await json("POST", "/ops/recordings", "usr_ops_editor", 403, { recordingId: "rcd_other", workId: "wrk_other", masterOwnerPartyId: "pty_label", versionTitle: "x" });
  // 레이블은 자기 테넌트를 대상으로 한 break-glass를 본다.
  assert.deepEqual((await json("GET", "/portal/break-glass", "usr_lbl", 200)).map((b: any) => b.breakGlassId), [bg.breakGlassId]);
  assert.deepEqual(await json("GET", "/portal/break-glass", "usr_other", 200), []);
  await json("POST", `/ops/break-glass/${bg.breakGlassId}/end`, "usr_ops_editor", 200);
  await json("POST", "/ops/recordings", "usr_ops_editor", 403, { recordingId: "rcd_after_end", workId: "wrk_lbl", masterOwnerPartyId: "pty_label", versionTitle: "x" });
});

test("break-glass expires by itself", async () => {
  await json("POST", "/ops/break-glass", "usr_ops_editor", 201, { targetTenantId: "tnt_lbl", reason: "짧은 대행", minutes: 1 });
  await json("POST", "/ops/recordings", "usr_ops_editor", 201, { recordingId: "rcd_in_window", workId: "wrk_lbl", masterOwnerPartyId: "pty_label", versionTitle: "x" });
  now += 61_000;
  await json("POST", "/ops/recordings", "usr_ops_editor", 403, { recordingId: "rcd_late", workId: "wrk_lbl", masterOwnerPartyId: "pty_label", versionTitle: "x" });
  const audit = (await w.db.pool.query("SELECT action_name FROM audit_log WHERE entity_type = 'break_glass' ORDER BY audit_id")).rows.map((r) => r.action_name);
  assert.deepEqual(audit, ["BREAK_GLASS_START", "BREAK_GLASS_END", "BREAK_GLASS_START"]);
});

test("the inspection log is append-only", async () => {
  await assert.rejects(w.db.pool.query("DELETE FROM inspection_audit_log"), /append-only|permission denied/);
});
