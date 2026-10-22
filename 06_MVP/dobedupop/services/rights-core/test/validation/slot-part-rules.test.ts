import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { SCOPE, T0, seedSong } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as reg from "../../src/registry/service.ts";
import { checkScope } from "../../src/validation/service.ts";

// 슬롯·파트와 권리 주장의 정합성 규칙 4개: 위반 데이터를 만들면 그 코드가 나오고, 고치면 사라진다.
const { db, drop } = await freshDb();
after(drop);
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
await db.tx((tx) => seedSong(tx, fixedClock(T0, 0)));
const base = { factsScopeId: SCOPE, status: "VERIFIED" as const, validFrom: T0 };
const rules = async (rule: string) =>
  (await db.tx((tx) => checkScope(tx, SCOPE, clock.now()))).filter((v) => v.rule === rule).map((v) => `${v.severity} ${v.subjectId}`).sort();

test("the seeded song has none of the new violations", async () => {
  for (const r of ["MASTER_OWNER_CLAIM_MISMATCH", "STEM_PERFORMER_CLAIM_MISMATCH", "PART_NO_ORIGINAL_STEM", "PART_ORIGINAL_NO_VOICE"]) assert.deepEqual(await rules(r), [], r);
});

test("MASTER_OWNER_CLAIM_MISMATCH: the recording's master owner differs from its CONTROLLED_BY claim (WARN)", async () => {
  await db.tx(async (tx) => {
    await reg.registerRecording(tx, clock, { recordingId: "rcd_alt", workId: "wrk_nova", masterOwnerPartyId: "pty_label", versionTitle: "Alt" });
    await reg.recordClaim(tx, clock, { ...base, claimId: "c_master_alt", sourceId: "rcd_alt", edge: "CONTROLLED_BY", targetId: "pty_agency", shareBps: 10000 });
  });
  assert.deepEqual(await rules("MASTER_OWNER_CLAIM_MISMATCH"), ["WARN rcd_alt"]);
  await db.tx((tx) => reg.recordClaim(tx, clock, { ...base, claimId: "c_master_alt", sourceId: "rcd_alt", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000 }));
  assert.deepEqual(await rules("MASTER_OWNER_CLAIM_MISMATCH"), []);
});

test("STEM_PERFORMER_CLAIM_MISMATCH: the stem's performer is not the owner of the voice it is claimed to perform (BLOCK)", async () => {
  await db.tx(async (tx) => {
    await reg.registerStem(tx, clock, { stemId: "stm_x", slotId: "slt_1", recordingId: "rcd_nova", performerPartyId: "pty_member_a", rightsBearing: true });
    await reg.recordClaim(tx, clock, { ...base, claimId: "c_perf_x", sourceId: "stm_x", edge: "PERFORMED_BY", targetId: "vo_b", shareBps: 10000, performerRole: "FEATURED" });
  });
  assert.deepEqual(await rules("STEM_PERFORMER_CLAIM_MISMATCH"), ["BLOCK stm_x"]);
  await db.tx((tx) => reg.recordClaim(tx, clock, { ...base, claimId: "c_perf_x", sourceId: "stm_x", edge: "PERFORMED_BY", targetId: "vo_a", shareBps: 10000, performerRole: "FEATURED" }));
  assert.deepEqual(await rules("STEM_PERFORMER_CLAIM_MISMATCH"), []);
});

test("PART_ORIGINAL_NO_VOICE (BLOCK) and PART_NO_ORIGINAL_STEM (WARN) for a vocal part", async () => {
  await db.tx(async (tx) => {
    await reg.registerParty(tx, clock, { partyId: "pty_member_c", partyType: "MEMBER", displayName: "C" });
    await reg.registerSlot(tx, clock, { slotId: "s_br", recordingId: "rcd_nova", startMs: 0, endMs: 10000, sortOrder: 9,
      parts: [{ partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 0, endMs: 10000, originalPartyId: "pty_member_c" }, { partNo: 2, kind: "GROUP", role: "UNISON", startMs: 0, endMs: 10000 }] });
  });
  assert.deepEqual(await rules("PART_ORIGINAL_NO_VOICE"), ["BLOCK s_br#1"]);
  assert.deepEqual(await rules("PART_NO_ORIGINAL_STEM"), ["WARN s_br#1", "WARN s_br#2"]);
  await db.tx(async (tx) => {
    await reg.registerVoice(tx, clock, { voiceId: "vo_c", factsScopeId: SCOPE, kind: "HUMAN" });
    await reg.recordClaim(tx, clock, { ...base, claimId: "c_own_c", sourceId: "vo_c", edge: "OWNED_BY", targetId: "pty_member_c", shareBps: 10000 });
    await reg.registerStem(tx, clock, { stemId: "stm_br_c", slotId: "s_br", partNo: 1, recordingId: "rcd_nova", performerPartyId: "pty_member_c", rightsBearing: true });
    await reg.registerStem(tx, clock, { stemId: "stm_br_group", slotId: "s_br", partNo: 2, recordingId: "rcd_nova", rightsBearing: false });
  });
  assert.deepEqual(await rules("PART_ORIGINAL_NO_VOICE"), []);
  assert.deepEqual(await rules("PART_NO_ORIGINAL_STEM"), []);
});
