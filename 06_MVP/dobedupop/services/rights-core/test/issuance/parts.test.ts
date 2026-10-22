import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedConsents, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as reg from "../../src/registry/service.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";
import { rederiveIssue } from "../../src/engine-bridge/issue.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";

// 발행을 슬롯·파트 단위로(결정 SL1·SL2·SL7): 보컬 파트는 모두 채우고, 사용 시간은 파트 길이, 그룹 파트는 원곡 스템으로 고정.
const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);

const users = await db.tx(async (tx) => {
  const c0 = fixedClock(T0, 0);
  await seedSong(tx, c0);
  // Chorus 슬롯: 파트 1(a), 파트 2(b), 파트 3(반주). Intro 슬롯은 반주 파트 하나. Bridge 슬롯은 그룹 파트 하나.
  await reg.registerSlot(tx, c0, { slotId: "s_ch", recordingId: "rcd_nova", startMs: 0, endMs: 18000, sortOrder: 4, sectionLabel: "Chorus 1",
    parts: [{ partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 0, endMs: 9000, originalPartyId: "pty_member_a" },
      { partNo: 2, kind: "VOCAL", role: "LEAD", startMs: 9000, endMs: 18000, originalPartyId: "pty_member_b" },
      { partNo: 3, kind: "INSTRUMENT", startMs: 0, endMs: 18000 }] });
  await reg.registerSlot(tx, c0, { slotId: "s_in", recordingId: "rcd_nova", startMs: 18000, endMs: 22000, sortOrder: 5, sectionLabel: "Intro" });
  await reg.registerSlot(tx, c0, { slotId: "s_gr", recordingId: "rcd_nova", startMs: 22000, endMs: 26000, sortOrder: 6, sectionLabel: "Outro",
    parts: [{ partNo: 1, kind: "GROUP", role: "UNISON", startMs: 22000, endMs: 26000 }] });
  const stems: [string, string, number, string | undefined, boolean][] = [
    ["st_ch_1_a", "s_ch", 1, "pty_member_a", true], ["st_ch_2_b", "s_ch", 2, "pty_member_b", true], ["st_ch_2_a", "s_ch", 2, "pty_member_a", true],
    ["st_ch_inst", "s_ch", 3, undefined, false], ["st_in", "s_in", 1, undefined, false], ["st_gr", "s_gr", 1, undefined, false],
  ];
  for (const [stemId, slotId, partNo, performer, rb] of stems) {
    await reg.registerStem(tx, c0, { stemId, slotId, partNo, recordingId: "rcd_nova", ...(performer === undefined ? {} : { performerPartyId: performer }), rightsBearing: rb });
    if (performer !== undefined) {
      await reg.recordClaim(tx, c0, { factsScopeId: SCOPE, status: "VERIFIED", validFrom: T0, claimId: `c_perf_${stemId}`, sourceId: stemId, edge: "PERFORMED_BY",
        targetId: performer === "pty_member_a" ? "vo_a" : "vo_b", shareBps: 10000, performerRole: "FEATURED" });
    }
  }
  const u = await seedUsers(tx, c0);
  await seedConsents(tx, c0);
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
  return u;
});
const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));
await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r));
await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, r));
await db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK));

const issueAs = (input: { vcId: string; assignments: { slotId: string; partNo?: number; stemId: string }[]; members: Record<string, number> }) =>
  db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, { packId: PACK, ...input }));

test("issue by part: both vocal parts must be assigned, usage = part length, group/instrument excluded", async () => {
  await assert.rejects(issueAs({ vcId: "vc_miss", assignments: [{ slotId: "s_ch", partNo: 1, stemId: "st_ch_1_a" }, { slotId: "s_ch", partNo: 3, stemId: "st_ch_inst" }, { slotId: "s_in", stemId: "st_in" }], members: { pty_member_a: 10000 } }), { code: "PART_MISSING" });
  await assert.rejects(issueAs({ vcId: "vc_dup", assignments: [{ slotId: "s_ch", partNo: 1, stemId: "st_ch_1_a" }, { slotId: "s_ch", partNo: 1, stemId: "st_ch_1_a" }], members: { pty_member_a: 10000 } }), { code: "INVALID_ISSUE" });
  // 파트 2의 스템을 파트 1에 둘 수 없다.
  await assert.rejects(issueAs({ vcId: "vc_wrong", assignments: [{ slotId: "s_ch", partNo: 1, stemId: "st_ch_2_a" }, { slotId: "s_ch", partNo: 2, stemId: "st_ch_2_b" }], members: { pty_member_b: 10000 } }), { code: "INVALID_ISSUE" });
  const seal = await issueAs({ vcId: "vc_swap", assignments: [{ slotId: "s_ch", partNo: 1, stemId: "st_ch_1_a" }, { slotId: "s_ch", partNo: 2, stemId: "st_ch_2_a" }, { slotId: "s_ch", partNo: 3, stemId: "st_ch_inst" }, { slotId: "s_in", stemId: "st_in" }, { slotId: "s_gr", stemId: "st_gr" }, { slotId: "slt_1", stemId: "stm_b1" }], members: { pty_member_a: 5000, pty_member_b: 5000 } });
  const a = (await db.pool.query("SELECT slot_id, part_no, stem_id, duration_ms FROM snapshot_stem_assignment WHERE snapshot_id = $1 ORDER BY slot_id, part_no", [seal.snapshotId])).rows;
  assert.deepEqual(a.map((x) => [x.slot_id, x.part_no, x.duration_ms]), [["s_ch", 1, 9000], ["s_ch", 2, 9000], ["s_ch", 3, 18000], ["s_gr", 1, 4000], ["s_in", 1, 4000], ["slt_1", 1, 30000]]);
  // 사용 시간: a는 파트 1·2(9초+9초), b는 slt_1(30초). 반주·그룹 스템은 없다.
  const proj = (await db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [seal.projectionDigest])).rows[0].content;
  assert.deepEqual(proj.vectors.PERFORMER_FEATURED, { pty_member_a: "3/8", pty_member_b: "5/8" });
  // 재도출(감사): 스냅샷 배정으로 다시 계산해도 같은 봉인
  const re = await db.tx((tx) => rederiveIssue(createBridgeCtx(ctx.blobs), tx, seal.snapshotId));
  assert.equal(re.ok, true);
});

test("a group part keeps its original stem (SL7)", async () => {
  await db.tx((tx) => reg.registerStem(tx, fixedClock("2026-03-01T00:00:00.000Z", 0), { stemId: "st_gr_alt", slotId: "s_gr", partNo: 1, recordingId: "rcd_nova", rightsBearing: false }));
  await assert.rejects(issueAs({ vcId: "vc_grp", assignments: [{ slotId: "s_ch", partNo: 1, stemId: "st_ch_1_a" }, { slotId: "s_ch", partNo: 2, stemId: "st_ch_2_a" }, { slotId: "s_gr", stemId: "st_gr_alt" }], members: { pty_member_a: 10000 } }), { code: "GROUP_PART_FIXED" });
});
