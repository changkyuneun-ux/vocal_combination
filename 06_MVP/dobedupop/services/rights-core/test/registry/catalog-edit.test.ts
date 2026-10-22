import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { InjectOptions } from "fastify";
import { freshDb } from "../helpers.ts";
import { SCOPE, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as reg from "../../src/registry/service.ts";
import { sealFacts } from "../../src/engine-bridge/facts.ts";
import { buildServer } from "../../src/http/server.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { viaChannel } from "../http/channel-app.ts";

// IR 생성 전 카탈로그 수정·삭제(결정 ID1): 첫 facts 봉인 전에는 고치고 지울 수 있고, 봉인 뒤에는 잠긴다.
const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
await db.tx(async (tx) => {
  const c0 = fixedClock(T0, 0);
  await seedSong(tx, c0);
  await seedUsers(tx, c0);
  await reg.registerSlot(tx, c0, { slotId: "s_ch", recordingId: "rcd_nova", startMs: 0, endMs: 18000, sortOrder: 4, sectionLabel: "Chorus",
    parts: [{ partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 0, endMs: 9000, originalPartyId: "pty_member_a" },
      { partNo: 2, kind: "VOCAL", role: "LEAD", startMs: 9000, endMs: 18000, originalPartyId: "pty_member_b" }] });
  await reg.registerStem(tx, c0, { stemId: "st_ch_1_a", slotId: "s_ch", partNo: 1, recordingId: "rcd_nova", performerPartyId: "pty_member_a", rightsBearing: true });
  await reg.registerStem(tx, c0, { stemId: "st_ch_2_a", slotId: "s_ch", partNo: 2, recordingId: "rcd_nova", performerPartyId: "pty_member_a", rightsBearing: true });
});
const app = viaChannel(buildServer({ db, ctx, clock, jobs: recordingJobs() }));
after(async () => { await app.close(); await drop(); cleanup(); });
const editor = "usr_rights";

async function http(method: InjectOptions["method"], url: string, payload: object | undefined, actor: string, expect = method === "DELETE" ? 204 : method === "POST" ? 201 : 200) {
  const opts: InjectOptions = { method, url, headers: { "x-actor": actor } };
  if (payload !== undefined) opts.payload = payload;
  const r = await app.inject(opts);
  assert.equal(r.statusCode, expect, `${method} ${url}: ${r.body}`);
  return r.body === "" ? {} : r.json();
}

test("before the first facts seal, catalog rows can be edited and deleted; after it they are locked", async () => {
  // 확인 대상 실연 주장(ASSERTED → 멤버에게 확인 요청)
  await http("POST", "/claims", { claimId: "c_perf_ch2a", factsScopeId: SCOPE, sourceId: "st_ch_2_a", edge: "PERFORMED_BY", targetId: "vo_a", shareBps: 10000, performerRole: "FEATURED", status: "ASSERTED", validFrom: T0 }, editor);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM confirmation_request WHERE record_id = 'c_perf_ch2a'")).rows[0].n, 1);

  const slot = await http("PUT", "/slots/s_ch", { startMs: 0, endMs: 20000, sortOrder: 4, sectionLabel: "Chorus 1" }, editor);
  assert.equal(slot.section_label, "Chorus 1");
  await http("PUT", "/slot-parts/s_ch/2", { kind: "VOCAL", role: "LEAD", startMs: 10000, endMs: 20000, originalPartyId: "pty_member_b" }, editor);
  // 슬롯을 줄여 파트가 밖에 남으면 거부
  assert.equal((await http("PUT", "/slots/s_ch", { endMs: 15000 }, editor, 422)).code, "PART_OUTSIDE_SLOT");
  await http("PUT", "/stems/st_ch_1_a", { rightsBearing: false }, editor);
  await http("PUT", "/works/wrk_nova", { title: "Nova (Remaster)" }, editor);
  // 스템이 있는 파트는 지울 수 없다
  assert.equal((await http("DELETE", "/slot-parts/s_ch/2", undefined, editor, 409)).code, "CATALOG_IN_USE");
  await http("DELETE", "/stems/st_ch_2_a", undefined, editor);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM right_claim WHERE source_id = 'st_ch_2_a'")).rows[0].n, 0);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM confirmation_request WHERE record_id = 'c_perf_ch2a'")).rows[0].n, 0);
  await http("DELETE", "/slot-parts/s_ch/2", undefined, editor);
  assert.equal((await http("DELETE", "/stems/st_nope", undefined, editor, 404)).code, "NOT_FOUND");
  assert.ok((await db.pool.query("SELECT 1 FROM audit_log WHERE action_name = 'CATALOG_DELETE' AND entity_id = 'st_ch_2_a'")).rows.length === 1);

  await db.tx((tx) => sealFacts(ctx, tx, SCOPE, clock.now())); // facts 봉인(IR 생성)
  const r = await http("PUT", "/slots/s_ch", { startMs: 0, endMs: 21000, sortOrder: 4 }, editor, 409);
  assert.equal(r.code, "CATALOG_SEALED");
  assert.equal((await http("DELETE", "/voices/vo_b", undefined, editor, 409)).code, "CATALOG_SEALED");
  // DB 트리거도 막는다(서비스를 거치지 않은 쓰기)
  await assert.rejects(db.pool.query("UPDATE work SET title = 'x' WHERE work_id = 'wrk_nova'"), /CATALOG_SEALED/);
  await assert.rejects(db.pool.query("DELETE FROM right_claim WHERE claim_id = 'c_master'"), /CATALOG_SEALED/);
});

test("edits need rights.edit", async () => {
  assert.equal((await http("PUT", "/works/wrk_nova", { title: "y" }, "usr_editor", 403)).code, "ROLE_REQUIRED");
});
