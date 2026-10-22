import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { InjectOptions } from "fastify";
import { freshDb } from "../helpers.ts";
import { seedSong, seedUsers, T0, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { buildServer } from "../../src/http/server.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { viaChannel } from "../http/channel-app.ts";

// 녹음·스템 등록 때 권리 주장 함께 만들기(결정 ID2·ID3, SL3).
const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  await seedUsers(tx, fixedClock(T0, 0));
});
const app = viaChannel(buildServer({ db, ctx, clock, jobs: recordingJobs() }));
after(async () => { await app.close(); await drop(); cleanup(); });
const editor = "usr_rights";

async function http(method: InjectOptions["method"], url: string, payload: object, actor: string, expect = 201) {
  const r = await app.inject({ method, url, headers: { "x-actor": actor }, payload });
  assert.equal(r.statusCode, expect, `${method} ${url}: ${r.body}`);
  return r.json();
}

test("registering a stem with withClaims creates voice, ownership and performance claims and asks the member", async () => {
  await http("POST", "/stems", { stemId: "st_new", slotId: "slt_1", recordingId: "rcd_nova", performerPartyId: "pty_member_b", rightsBearing: true, withClaims: true }, editor);
  assert.equal((await db.pool.query("SELECT facts_scope_id FROM voice WHERE voice_id = 'voc_member_b'")).rows[0]?.facts_scope_id, "fsc_nova");
  const claims = (await db.pool.query(
    "SELECT claim_id, edge, source_id, target_id, status FROM right_claim WHERE claim_id IN ('c_perf_st_new', 'c_own_voc_member_b') ORDER BY claim_id")).rows;
  assert.deepEqual(claims.map((c) => [c.claim_id, c.edge, c.source_id, c.target_id, c.status]), [
    ["c_own_voc_member_b", "OWNED_BY", "voc_member_b", "pty_member_b", "ASSERTED"],
    ["c_perf_st_new", "PERFORMED_BY", "st_new", "voc_member_b", "ASSERTED"],
  ]);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM confirmation_request WHERE record_id = 'c_perf_st_new'")).rows[0].n, 1);
  // 같은 멤버의 두 번째 스템은 있는 보이스를 쓴다
  await http("POST", "/stems", { stemId: "st_new2", slotId: "slt_2", recordingId: "rcd_nova", performerPartyId: "pty_member_b", rightsBearing: true, withClaims: true }, editor);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM right_claim WHERE edge = 'OWNED_BY' AND source_id = 'voc_member_b'")).rows[0].n, 1);
  // 권리 부담이 없는 스템은 주장을 만들지 않는다
  await http("POST", "/stems", { stemId: "st_mr2", slotId: "slt_mr", recordingId: "rcd_nova", rightsBearing: false, withClaims: true }, editor);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM right_claim WHERE source_id = 'st_mr2'")).rows[0].n, 0);
});

test("registering a recording with masterClaim records the master right (platform editor → verified)", async () => {
  await http("POST", "/recordings", { recordingId: "rcd_nova_v2", workId: "wrk_nova", masterOwnerPartyId: "pty_label", versionTitle: "v2", masterClaim: {} }, editor);
  const c = (await db.pool.query("SELECT edge, source_id, target_id, share_bps, status FROM right_claim WHERE claim_id = 'c_master_rcd_nova_v2'")).rows[0];
  assert.deepEqual([c.edge, c.source_id, c.target_id, c.share_bps, c.status], ["CONTROLLED_BY", "rcd_nova_v2", "pty_label", 10000, "VERIFIED"]);
  // 없으면 주장을 만들지 않는다(기존 동작)
  await http("POST", "/recordings", { recordingId: "rcd_nova_v3", workId: "wrk_nova", masterOwnerPartyId: "pty_label", versionTitle: "v3" }, editor);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM right_claim WHERE source_id = 'rcd_nova_v3'")).rows[0].n, 0);
});
