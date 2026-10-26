import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { sealFacts } from "../../src/engine-bridge/facts.ts";
import * as reg from "../../src/registry/service.ts";
import { SCOPE } from "../fixtures.ts";
import { settlementWorld } from "../settlement-fixtures.ts";

// 보이스는 곡 단위(2026-10-26, Butter 따라 해 보기 막힌 곳 1·2): 같은 멤버로 두 번째 곡을 만들어도 보이스 id가 겹치지 않고,
// 실연 주장은 그 곡의 보이스에 걸린다. 기존 곡(fsc_nova의 vo_a)은 그대로 쓰고 봉인된 digest는 바뀌지 않는다.
const w = await settlementWorld();
const app = buildServer({ db: w.db, ctx: w.ctx, clock: fixedClock("2026-03-01T00:00:00.000Z", 1000), jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await reg.registerWork(tx, c0, { workId: "wrk_two", title: "Two" });
  await reg.createScope(tx, c0, { factsScopeId: "fsc_two", workId: "wrk_two" });
  await reg.registerRecording(tx, c0, { recordingId: "rcd_two", workId: "wrk_two", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
  await reg.registerSlot(tx, c0, { slotId: "slt_two_1", recordingId: "rcd_two", startMs: 0, endMs: 20000, sortOrder: 1,
    parts: [{ partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 0, endMs: 20000, originalPartyId: "pty_member_a" }] });
  await createUser(tx, c0, { userId: "usr_ma", displayName: "member a", roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: "pty_member_a" });
});
const json = async (method: "GET" | "POST", url: string, status: number, payload?: object, actor = "usr_rights"): Promise<any> => {
  const r = await app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.body === "" ? {} : r.json();
};
const perfTarget = async (stemId: string) => (await w.db.pool.query("SELECT target_id FROM right_claim WHERE source_id = $1 AND edge = 'PERFORMED_BY' AND superseded_at IS NULL", [stemId])).rows[0]?.target_id;

test("a second song with the same member gets its own voice (voc_<song>_<member>); later stems reuse it", async () => {
  const policy = (await w.db.pool.query("SELECT facts_digest, facts_known_at FROM policy_version WHERE policy_id = 'pol_nova' AND status = 'ACTIVE'")).rows[0];
  await json("POST", "/ops/stems", 201, { stemId: "stm_two_a", slotId: "slt_two_1", partNo: 1, recordingId: "rcd_two", performerPartyId: "pty_member_a", rightsBearing: true, withClaims: true });
  assert.equal(await perfTarget("stm_two_a"), "voc_two_member_a");
  const v = (await w.db.pool.query("SELECT facts_scope_id FROM voice WHERE voice_id = 'voc_two_member_a'")).rows[0];
  assert.equal(v.facts_scope_id, "fsc_two");
  assert.equal((await w.db.pool.query("SELECT target_id, status FROM right_claim WHERE source_id = 'voc_two_member_a' AND edge = 'OWNED_BY'")).rows[0].target_id, "pty_member_a");
  await json("POST", "/ops/stems", 201, { stemId: "stm_two_a2", slotId: "slt_two_1", partNo: 1, recordingId: "rcd_two", performerPartyId: "pty_member_a", rightsBearing: true, withClaims: true });
  assert.equal(await perfTarget("stm_two_a2"), "voc_two_member_a");
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM voice WHERE facts_scope_id = 'fsc_two'")).rows[0].n, 1);
  // 기존 곡은 그 곡의 기존 보이스(vo_a)를 그대로 쓴다(봉인 뒤 새 스템도 다음 IR로)
  await json("POST", "/ops/stems", 201, { stemId: "stm_nova_a_extra", slotId: "slt_1", partNo: 1, recordingId: "rcd_nova", performerPartyId: "pty_member_a", rightsBearing: true, withClaims: true });
  assert.equal(await perfTarget("stm_nova_a_extra"), "vo_a");
  // 보이스 id를 정해 주면 그것을 쓴다(기존 곡 시드 — Dynamite의 voc_<멤버>)
  await json("POST", "/ops/stems", 201, { stemId: "stm_two_b", slotId: "slt_two_1", partNo: 1, recordingId: "rcd_two", performerPartyId: "pty_member_b", rightsBearing: true, withClaims: true, voiceId: "voc_legacy_b" });
  assert.equal(await perfTarget("stm_two_b"), "voc_legacy_b");
  // 봉인된 facts digest는 그대로
  assert.equal((await w.db.tx((tx) => sealFacts(w.ctx, tx, SCOPE, (policy.facts_known_at as Date).toISOString()))).digest, policy.facts_digest);
});

test("the performer app lists the member's voices per song", async () => {
  const mine = await json("GET", "/performer/voices", 200, undefined, "usr_ma");
  assert.deepEqual(mine.map((v: any) => [v.title, v.voiceId]).sort(), [["Nova", "vo_a"], ["Two", "voc_two_member_a"]]);
});
