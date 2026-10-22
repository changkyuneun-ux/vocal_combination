import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedConsents, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";
import { rederiveIssue } from "../../src/engine-bridge/issue.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);

const users = await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  const u = await seedUsers(tx, fixedClock(T0, 0));
  await seedConsents(tx, fixedClock(T0, 0));
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
  return u;
});

const combo = (vcId: string, a = "a", b = "b") => ({
  packId: PACK, vcId,
  assignments: [{ slotId: "slt_1", stemId: `stm_${a}1` }, { slotId: "slt_2", stemId: `stm_${b}2` }, { slotId: "slt_mr", stemId: "stm_mr" }],
  members: a === b ? { [`pty_member_${a}`]: 10000 } : { [`pty_member_${a}`]: 5000, [`pty_member_${b}`]: 5000 },
});

test("pack activation requires an active policy", async () => {
  await assert.rejects(db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK)), { code: "NO_ACTIVE_POLICY" });
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, r));
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_early"))), { code: "PACK_NOT_ACTIVE" });
  await db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK));
});

test("issue writes the snapshot and an issue seal whose projection matches the usage", async () => {
  const seal = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_1")));
  assert.equal(seal.snapshotId, "snp_vc_1");
  assert.equal(seal.asOf, seal.knownAt);
  const rows = await db.pool.query("SELECT stem_id, duration_ms, rights_bearing FROM snapshot_stem_assignment WHERE snapshot_id = 'snp_vc_1' ORDER BY slot_id");
  assert.deepEqual(rows.rows.map((r) => [r.stem_id, r.duration_ms, r.rights_bearing]), [["stm_a1", 30000, true], ["stm_b2", 60000, true], ["stm_mr", 90000, false]]);
  const proj = (await db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [seal.projectionDigest])).rows[0].content;
  assert.equal(proj.format, "mdrl-projection/1");
  assert.deepEqual(proj.vectors.PERFORMER_FEATURED, { pty_member_a: "1/3", pty_member_b: "2/3" });
  const members = (await db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [seal.membersDigest])).rows[0].content;
  assert.deepEqual(members, { members: { pty_member_a: "1/2", pty_member_b: "1/2" } });
});

test("identical combinations share the members seal; projections differ only by as_of", async () => {
  const a = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_2", "b", "a")));
  const b = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_3", "b", "a")));
  assert.equal(a.membersDigest, b.membersDigest);
  assert.notEqual(a.asOf, b.asOf);
  assert.notEqual(a.projectionDigest, b.projectionDigest);
  const load = async (d: string) => (await db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [d])).rows[0].content;
  const [pa, pb] = [await load(a.projectionDigest), await load(b.projectionDigest)];
  assert.deepEqual(pa.vectors, pb.vectors);
  assert.deepEqual(pa.paths, pb.paths);
});

test("invalid assignments and members are rejected and nothing is written", async () => {
  const bad = [
    { ...combo("vc_x1"), assignments: [{ slotId: "slt_1", stemId: "stm_a2" }] },
    { ...combo("vc_x2"), assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_1", stemId: "stm_b1" }] },
    { ...combo("vc_x3"), members: { pty_member_a: 6000, pty_member_b: 3000 } },
    { ...combo("vc_x4"), members: { pty_ghost: 10000 } },
    { ...combo("vc_x5"), assignments: [] },
    // 멤버는 배정된 정산 대상 스템의 실연자여야 한다.
    { ...combo("vc_x6"), members: { pty_member_a: 5000, pty_label: 5000 } },
    { ...combo("vc_x7", "a", "a"), members: { pty_member_a: 5000, pty_member_b: 5000 } },
  ];
  for (const input of bad) {
    await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, input)), { code: "INVALID_ISSUE" });
  }
  const n = await db.pool.query("SELECT count(*)::int AS n FROM rights_snapshot WHERE vc_id LIKE 'vc_x%'");
  assert.equal(n.rows[0].n, 0);
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_1"))), (e: any) => e.code === "23505" || e.code === "CONFLICT");
});

test("an open dispute in the scope blocks issuing even before the pack is paused", async () => {
  await db.tx((tx) => tx.query(
    "INSERT INTO dispute (dispute_id, target_type, target_id, facts_scope_id, dispute_reason, opened_at) VALUES ('dsp_t','RIGHT_CLAIM','c_master',$1,'test',date_trunc('milliseconds', now()))", [SCOPE],
  ));
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_d"))), { code: "FACTS_DISPUTE_OPEN", status: 409 });
});

test("every issue seal re-derives from rows with a fresh bridge (no cache)", async () => {
  const fresh = createBridgeCtx(ctx.blobs);
  for (const snap of ["snp_vc_1", "snp_vc_2", "snp_vc_3"]) {
    const r = await db.tx((tx) => rederiveIssue(fresh, tx, snap));
    assert.equal(r.ok, true, snap);
    assert.equal(r.policyMatch, true, snap);
  }
});

test("re-derivation fails when the issue seal's digests differ from the snapshot's policy version", async () => {
  await db.tx(async (tx) => {
    await tx.query("INSERT INTO rights_snapshot SELECT 'snp_forged', 'vc_forged', pack_id, policy_id, policy_version, created_at FROM rights_snapshot WHERE snapshot_id = 'snp_vc_1'");
    await tx.query("INSERT INTO snapshot_stem_assignment SELECT 'snp_forged', slot_id, stem_id, party_id, start_ms, end_ms, duration_ms, rights_bearing, part_no FROM snapshot_stem_assignment WHERE snapshot_id = 'snp_vc_1'");
    await tx.query("INSERT INTO snapshot_member_pct SELECT 'snp_forged', party_id, pct_bps FROM snapshot_member_pct WHERE snapshot_id = 'snp_vc_1'");
    // 정책 digest 자리에 다른 봉인(facts)을 넣은 위조 봉인: 조합 지분·멤버는 그대로라 재계산만으로는 드러나지 않는다.
    await tx.query("INSERT INTO issue_seal SELECT 'snp_forged', facts_digest, facts_digest, projection_digest, members_digest, as_of, known_at FROM issue_seal WHERE snapshot_id = 'snp_vc_1'");
  });
  const r = await db.tx((tx) => rederiveIssue(createBridgeCtx(ctx.blobs), tx, "snp_forged"));
  assert.equal(r.policyMatch, false);
  assert.equal(r.ok, false);
});

test("snapshot and issue seal rows are immutable", async () => {
  await assert.rejects(db.pool.query("UPDATE issue_seal SET as_of = now()"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM snapshot_member_pct"), /append-only|permission denied/);
});
