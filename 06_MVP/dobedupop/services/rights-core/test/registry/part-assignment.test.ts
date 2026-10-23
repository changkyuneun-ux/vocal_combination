import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { InjectOptions } from "fastify";
import { freshDb } from "../helpers.ts";
import { SCOPE, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { createUser } from "../../src/platform/actor.ts";
import * as reg from "../../src/registry/service.ts";
import { sealFacts } from "../../src/engine-bridge/facts.ts";
import { buildServer } from "../../src/http/server.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { viaChannel } from "../http/channel-app.ts";

// IR 생성 뒤 원곡 파트 담당 바로잡기(시안 Song-Locked-FixPerf): 봉인된 v1(slot_part)은 그대로, 새 버전으로 기록하고
// 바뀐 멤버들(새 담당·이전 담당)이 실연자 앱에서 확인한다. 다음 재고정부터 반영되고 이미 봉인된 facts·발행 조합은 그대로다.
const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
await db.tx(async (tx) => {
  const c0 = fixedClock(T0, 0);
  await seedSong(tx, c0);
  await seedUsers(tx, c0);
  await reg.registerSlot(tx, c0, { slotId: "s_ch", recordingId: "rcd_nova", startMs: 0, endMs: 18000, sortOrder: 4, sectionLabel: "Chorus",
    parts: [{ partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 0, endMs: 9000, originalPartyId: "pty_member_a" },
      { partNo: 2, kind: "VOCAL", role: "LEAD", startMs: 9000, endMs: 18000, originalPartyId: "pty_member_b" },
      { partNo: 3, kind: "INSTRUMENT", startMs: 0, endMs: 18000 }] });
  await reg.registerStem(tx, c0, { stemId: "st_ch_1_a", slotId: "s_ch", partNo: 1, recordingId: "rcd_nova", performerPartyId: "pty_member_a", rightsBearing: true });
  await reg.registerStem(tx, c0, { stemId: "st_ch_2_b", slotId: "s_ch", partNo: 2, recordingId: "rcd_nova", performerPartyId: "pty_member_b", rightsBearing: true });
  for (const m of ["a", "b"]) await createUser(tx, c0, { userId: `usr_m${m}`, displayName: `member ${m}`, roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: `pty_member_${m}` });
});
const app = viaChannel(buildServer({ db, ctx, clock, jobs: recordingJobs() }), (a) => (a?.startsWith("usr_m") ? "performer" : "ops"));
after(async () => { await app.close(); await drop(); cleanup(); });
const editor = "usr_rights";

async function http(method: InjectOptions["method"], url: string, payload: object | undefined, actor: string, expect = method === "POST" ? 201 : 200) {
  const opts: InjectOptions = { method, url, headers: { "x-actor": actor } };
  if (payload !== undefined) opts.payload = payload;
  const r = await app.inject(opts);
  assert.equal(r.statusCode, expect, `${method} ${url}: ${r.body}`);
  return r.body === "" ? {} : r.json();
}
const fix = (partNo: number, partyId: string, extra: object = {}) => ({ slotId: "s_ch", partNo, partyId, validFrom: "2026-03-01T00:00:00.000Z", ...extra });
const q = async (sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows;
const validation = async () => (await http("GET", `/scopes/${SCOPE}/validation`, undefined, editor)).issues as { rule: string; subjectId: string; message: string }[];

test("before the IR, part owners are fixed by catalog edit — the new-version path refuses", async () => {
  assert.equal((await http("POST", "/part-assignments", fix(2, "pty_member_a"), editor, 409)).code, "NOT_SEALED");
});

let sealedDigest = "", sealedAt = "";
test("after the IR: a new version keeps v1, asks both changed members, and only applies from the next reseal", async () => {
  const s = await db.tx((tx) => sealFacts(ctx, tx, SCOPE, clock.now()));
  sealedDigest = s.digest; sealedAt = s.knownAt;
  // 이 곡의 멤버만(보이스 소유자), 같은 값은 거부, 보컬 파트만
  assert.equal((await http("POST", "/part-assignments", fix(2, "pty_author_b"), editor, 422)).code, "NOT_SONG_MEMBER");
  assert.equal((await http("POST", "/part-assignments", fix(2, "pty_member_b"), editor, 409)).code, "NO_CHANGE");
  assert.equal((await http("POST", "/part-assignments", fix(3, "pty_member_a"), editor, 422)).code, "NOT_VOCAL_PART");
  assert.equal((await http("POST", "/part-assignments", { ...fix(9, "pty_member_a") }, editor, 404)).code, "NOT_FOUND");
  assert.equal((await http("POST", "/part-assignments", fix(2, "pty_member_a"), "usr_editor", 403)).code, "ROLE_REQUIRED");

  const out = await http("POST", "/part-assignments", fix(2, "pty_member_a"), editor);
  assert.equal(out.assignmentId, "pa_s_ch_2");
  assert.equal(out.version, 1);
  assert.equal(out.status, "ASSERTED");
  assert.equal(out.previousPartyId, "pty_member_b");
  assert.ok(Date.parse(out.recordedAt) > Date.parse(sealedAt), "recorded after the seal → next reseal");
  // v1(slot_part)은 그대로
  assert.equal((await q("SELECT original_party_id FROM slot_part WHERE slot_id = 's_ch' AND part_no = 2"))[0].original_party_id, "pty_member_b");
  // 바뀐 멤버 둘에게 확인 요청
  const reqs = await q("SELECT counterparty_id, status FROM confirmation_request WHERE record_type = 'PART' AND record_id = 'pa_s_ch_2' ORDER BY counterparty_id");
  assert.deepEqual(reqs.map((r) => [r.counterparty_id, r.status]), [["pty_member_a", "OPEN"], ["pty_member_b", "OPEN"]]);
  // 봉인된 facts는 그대로(같은 knownAt이면 같은 digest)
  assert.equal((await db.tx((tx) => sealFacts(ctx, tx, SCOPE, sealedAt))).digest, sealedDigest);
  // 화면용: facts에 지금 담당이 함께 온다
  const facts = await http("GET", `/scopes/${SCOPE}/facts`, undefined, editor);
  assert.deepEqual(facts.partAssignments.map((a: any) => [a.slotId, a.partNo, a.partyId, a.previousPartyId, a.status]), [["s_ch", 2, "pty_member_a", "pty_member_b", "ASSERTED"]]);
  // 점검은 지금 담당 기준: 멤버 a가 부른 파트 2 스템이 없다
  const v = await validation();
  assert.ok(v.some((i) => i.rule === "PART_NO_ORIGINAL_STEM" && i.subjectId === "s_ch#2" && i.message.includes("pty_member_a")), JSON.stringify(v));
  // 열린 확인 요청은 정합성 경고로
  const pend = v.filter((i) => i.rule === "DOC_CONFIRMATION_PENDING" && i.subjectId === "PART:pa_s_ch_2");
  assert.equal(pend.length, 1);
  assert.ok(pend[0]!.message.includes("pty_member_a") && pend[0]!.message.includes("pty_member_b"));
});

test("both members confirm in the performer app → VERIFIED new version; another member cannot confirm for them", async () => {
  const mine = await http("GET", "/confirmations", undefined, "usr_ma");
  const ra = mine.find((r: any) => r.recordType === "PART" && r.status === "OPEN");
  assert.ok(ra, JSON.stringify(mine));
  const rb = (await http("GET", "/confirmations", undefined, "usr_mb")).find((r: any) => r.recordType === "PART" && r.status === "OPEN");
  // 다른 멤버의 요청은 보이지도 않는다(RLS) — 대신 확인할 수 없다
  assert.equal((await http("POST", `/confirmations/${rb.requestId}/confirm`, {}, "usr_ma", 404)).code, "NOT_FOUND");
  await http("POST", `/confirmations/${ra.requestId}/confirm`, {}, "usr_ma", 200);
  assert.equal((await q("SELECT status FROM part_assignment WHERE assignment_id = 'pa_s_ch_2' AND superseded_at IS NULL"))[0].status, "ASSERTED", "waits for the other member");
  await http("POST", `/confirmations/${rb.requestId}/confirm`, {}, "usr_mb", 200);
  const cur = await q("SELECT version, status, party_id FROM part_assignment WHERE assignment_id = 'pa_s_ch_2' AND superseded_at IS NULL");
  assert.deepEqual(cur.map((r) => [r.version, r.status, r.party_id]), [[2, "VERIFIED", "pty_member_a"]]);
});

test("a member declines → the assignment is DISPUTED and the other open request is superseded", async () => {
  await http("POST", "/part-assignments", fix(1, "pty_member_b"), editor);
  const rb = (await http("GET", "/confirmations", undefined, "usr_mb")).find((r: any) => r.recordId === "pa_s_ch_1" && r.status === "OPEN");
  assert.equal((await http("POST", `/confirmations/${rb.requestId}/decline`, { reason: "원곡 파트 1은 내가 부르지 않았다" }, "usr_mb", 200)).status, "DECLINED");
  const cur = await q("SELECT status FROM part_assignment WHERE assignment_id = 'pa_s_ch_1' AND superseded_at IS NULL");
  assert.equal(cur[0].status, "DISPUTED");
  const left = await q("SELECT status FROM confirmation_request WHERE record_id = 'pa_s_ch_1' AND counterparty_id = 'pty_member_a'");
  assert.equal(left[0].status, "SUPERSEDED");
  // 다시 바로잡으면(이전 담당으로 되돌리기 포함) 새 버전
  const again = await http("POST", "/part-assignments", fix(1, "pty_member_b", { reason: "재확인" }), editor);
  assert.equal(again.version, 3);
});
