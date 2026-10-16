import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser, withSystemScope } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { invalidateStem } from "../../src/decisions/cache.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";

// 팬 앱 조합 API와 판정 캐시(다음 작업 12): 판정은 실제 발행과 같고 아무것도 남기지 않으며, 바뀐 것에 의존하는 판정만 무효화된다.
const w = await settlementWorld();
const clock = fixedClock("2026-02-10T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await registerParty(tx, c0, { partyId: "pty_fan_1", partyType: "FAN", displayName: "fan 1", tenantId: "tnt_platform_default" });
  await createUser(tx, c0, { userId: "usr_fan_1", displayName: "fan 1", roles: [], tenantId: "tnt_platform_default", partyId: "pty_fan_1" });
});

const fan = async (method: "GET" | "POST", url: string, status: number, payload?: object): Promise<any> => {
  const r = await app.inject({ method, url: `/fan${url}`, headers: { "x-actor": "usr_fan_1" }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const mix = (a: string, b: string) => [{ slotId: "slt_1", stemId: `stm_${a}1` }, { slotId: "slt_2", stemId: `stm_${b}2` }, { slotId: "slt_mr", stemId: "stm_mr" }];
const check = (a: string, b: string) => fan("POST", "/combinations/check", 200, { packId: "pak_nova", assignments: mix(a, b) });
const count = (sql: string) => w.db.tx((tx) => withSystemScope(tx, async () => Number((await tx.query(sql)).rows[0].n)));

test("pack detail shows each slot's stems and whether they can be used now", async () => {
  const p = await fan("GET", "/packs/pak_nova", 200);
  assert.deepEqual(p.slots.map((s: any) => s.slotId), ["slt_1", "slt_2", "slt_mr"]);
  assert.ok(p.slots.every((s: any) => s.stems.every((x: any) => x.available === true && x.audio === "NONE")));
  await fan("GET", "/packs/pak_missing", 404);
});

test("a check is the real issuance gate run and rolled back: no snapshot, seal or notification is left behind", async () => {
  const before = await count("SELECT (SELECT count(*) FROM rights_snapshot) + (SELECT count(*) FROM issue_seal) + (SELECT count(*) FROM notification) AS n");
  const r = await check("a", "b");
  assert.equal(r.issuable, true, JSON.stringify(r));
  assert.equal(r.cached, false);
  assert.deepEqual(r.members, { pty_member_a: 5000, pty_member_b: 5000 });
  assert.equal(await count("SELECT (SELECT count(*) FROM rights_snapshot) + (SELECT count(*) FROM issue_seal) + (SELECT count(*) FROM notification) AS n"), before);
  const again = await check("a", "b");
  assert.equal(again.cached, true);
  assert.equal(again.issuable, true);
  // 같은 배치를 순서만 바꿔 보내도 같은 키다.
  const reordered = await fan("POST", "/combinations/check", 200, { packId: "pak_nova", assignments: [...mix("a", "b")].reverse() });
  assert.equal(reordered.cached, true);
});

test("a gate rejection is a decision too (200, issuable=false) and matches what issuing returns", async () => {
  const r = await check("a", "x");
  assert.equal(r.issuable, false);
  assert.equal(r.code, "INVALID_ISSUE");
  const issued = await app.inject({ method: "POST", url: "/fan/combinations", headers: { "x-actor": "usr_fan_1" }, payload: { packId: "pak_nova", vcId: "vc_dc_bad", assignments: mix("a", "x") } });
  assert.equal(issued.statusCode, 422);
  assert.equal(issued.json().code, r.code);
});

test("revoking member b's consent drops only decisions that use b's voice; other decisions stay cached", async () => {
  // a만 부르는 배치는 정책의 상한 때문에 정산할 수 없다(실제 게이트 판정). b와 무관한 판정의 예로 쓴다.
  const aa = await check("a", "a");
  assert.equal(aa.issuable, false);
  assert.equal(aa.code, "ISSUE_NOT_SETTLEABLE");
  assert.equal((await check("a", "a")).cached, true);
  assert.equal((await check("a", "b")).cached, true);
  assert.equal((await fan("POST", "/combinations", 201, { packId: "pak_nova", vcId: "vc_dc_ab", assignments: mix("a", "b") })).snapshotId, "snp_vc_dc_ab");
  const consentId = await w.db.tx((tx) => withSystemScope(tx, async () =>
    (await tx.query("SELECT consent_id FROM consent_agreement WHERE facts_scope_id = $1 AND right_type = 'PERFORMER' AND asset_id = 'vo_b'", [SCOPE])).rows[0].consent_id as string));
  const rv = await app.inject({ method: "POST", url: `/ops/consents/${consentId}/revoke`, headers: { "x-actor": "usr_ops" }, payload: { reason: "member b withdraws" } });
  assert.equal(rv.statusCode, 200, rv.body);

  const aa2 = await check("a", "a");
  assert.equal(aa2.cached, true, "decision without b's voice is untouched");
  assert.equal(aa2.code, "ISSUE_NOT_SETTLEABLE");
  const ab = await check("a", "b");
  assert.equal(ab.cached, false, "b's decisions were invalidated");
  assert.equal(ab.issuable, false);
  assert.equal(ab.code, "ISSUE_NOT_LICENSED");
  assert.ok(ab.diagnostics.some((d: any) => d.path.includes("vo_b")), JSON.stringify(ab.diagnostics));
  // 판정은 실제 발행과 같다.
  const denied = await app.inject({ method: "POST", url: "/fan/combinations", headers: { "x-actor": "usr_fan_1" }, payload: { packId: "pak_nova", vcId: "vc_dc_ab2", assignments: mix("a", "b") } });
  assert.equal(denied.json().code, "ISSUE_NOT_LICENSED");
});

test("a stem audio change drops only decisions that use that stem", async () => {
  assert.equal((await check("a", "a")).cached, true);
  assert.equal((await check("a", "b")).cached, true);
  await w.db.tx((tx) => invalidateStem(tx, "stm_b2"));
  assert.equal((await check("a", "a")).cached, true);
  assert.equal((await check("a", "b")).cached, false);
});

test("pack state changes drop the whole song's decisions; ⑧ shows cache size and hits", async () => {
  const sig = (await app.inject({ method: "GET", url: "/ops/pipeline/signals", headers: { "x-actor": "usr_ops" } })).json();
  const issuance = sig.stages.find((s: any) => s.stage === "issuance").signals;
  assert.ok(issuance.find((s: any) => s.key === "decision-cache").value >= 2);
  assert.ok(issuance.find((s: any) => s.key === "decision-cache-hits").value >= 1);
  const { invalidatePack } = await import("../../src/decisions/cache.ts");
  await w.db.tx((tx) => invalidatePack(tx, "pak_nova"));
  assert.equal(await count("SELECT count(*) AS n FROM decision_cache"), 0);
  assert.equal((await check("a", "a")).cached, false);
});

test("my combinations list what this fan issued with render status", async () => {
  const mine = await fan("GET", "/combinations", 200);
  assert.deepEqual(mine.map((c: any) => c.vcId), ["vc_dc_ab"]);
  assert.equal(mine[0].render, "NONE");
  assert.equal(mine[0].assignments.length, 3);
});

test("fan channel only: the check is not on the ops channel", async () => {
  const r = await app.inject({ method: "POST", url: "/ops/combinations/check", headers: { "x-actor": "usr_ops" }, payload: { packId: "pak_nova", assignments: mix("a", "a") } });
  assert.equal(r.statusCode, 404);
});
