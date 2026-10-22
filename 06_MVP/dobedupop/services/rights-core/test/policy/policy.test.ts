import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, setSodRules } from "../helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";
import { signersOf, verifyAttestations } from "../../src/engine-bridge/attest.ts";
import { openDispute } from "../../src/registry/disputes.ts";
import * as reg from "../../src/registry/service.ts";

const { db, adminUrl, drop } = await freshDb();
await setSodRules(adminUrl, ["policy.edit-approve-activate"]); // 이 파일은 직무 분리 거부를 확인한다(규칙 기본 꺼짐, 결정 RD6)
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });

const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
const users = await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  const u = await seedUsers(tx, fixedClock(T0, 0));
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova pack", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
  return u;
});

test("compile pins depends_on to the current facts seal and stores canonical text", async () => {
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));
  assert.equal(r.version, 1);
  assert.match(r.canonicalText, new RegExp(`digest "${r.factsDigest}"`));
  assert.doesNotMatch(r.canonicalText, /0{64}/);
  const s = await db.tx((tx) => signersOf(tx, r.policyDigest));
  assert.deepEqual(s, [{ signerId: "usr_editor", role: "EDITOR" }]);
  assert.equal(await db.tx((tx) => verifyAttestations(tx, r.policyDigest)), true);
});

test("roles and separation of duties are enforced", async () => {
  const ref = { policyId: "pol_nova", version: 1 };
  await assert.rejects(db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.editor, ref)), { code: "ROLE_REQUIRED" });
  await assert.rejects(db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, ref)), { code: "INVALID_STATE" });
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, ref));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, ref));
  const active = await db.tx((tx) => policy.activePolicyForPack(tx, PACK));
  assert.equal(active?.version, 1);
  const s = await db.tx((tx) => signersOf(tx, active!.policyDigest));
  assert.deepEqual(s.map((x) => x.role).sort(), ["ACTIVATOR", "EDITOR", "WORK_APPROVER"]);
});

test("the same person cannot sign two roles on one policy", async () => {
  const both = await db.tx(async (tx) => {
    const { createUser, loadActor } = await import("../../src/platform/actor.ts");
    await createUser(tx, clock, { userId: "usr_both", displayName: "both", roles: ["EDITOR", "WORK_APPROVER"] });
    return loadActor(tx, "usr_both");
  });
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, both, { policyId: "pol_sod", packId: PACK, sourceText: POLICY_TEXT }));
  await assert.rejects(db.tx((tx) => policy.approvePolicy(ctx, tx, clock, both, r)), { code: "SOD_VIOLATION", status: 403 });
});

test("with policy.edit-approve-activate disabled the editor may approve their own policy (MVP 총괄 운영, 결정 RD6)", async () => {
  await setSodRules(adminUrl, ["policy.edit-approve-activate"], false);
  try {
    const both = await db.tx(async (tx) => {
      const { createUser, loadActor } = await import("../../src/platform/actor.ts");
      await createUser(tx, clock, { userId: "usr_both_off", displayName: "both", roles: ["EDITOR", "WORK_APPROVER"] });
      return loadActor(tx, "usr_both_off");
    });
    const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, both, { policyId: "pol_sod_off", packId: PACK, sourceText: POLICY_TEXT }));
    await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, both, r));
    const s = await db.tx((tx) => signersOf(tx, r.policyDigest));
    assert.deepEqual(s.map((x) => `${x.signerId}:${x.role}`).sort(), ["usr_both_off:EDITOR", "usr_both_off:WORK_APPROVER"]);
  } finally {
    await setSodRules(adminUrl, ["policy.edit-approve-activate"], true);
  }
});

test("compile rejects a policy whose scope.pack differs from the target pack, with MDRL diagnostics for bad text", async () => {
  await assert.rejects(
    db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_x", packId: PACK, sourceText: POLICY_TEXT.replace("pack: pak_nova", "pack: pak_other") })),
    { code: "POLICY_PACK_MISMATCH", status: 422 },
  );
  await assert.rejects(
    db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_x", packId: PACK, sourceText: "allocation {" })),
    (e: any) => e.status === 422 && e.diagnostics.some((d: any) => d.code === "PARSE_SYNTAX"),
  );
});

test("activation fails with MDRL diagnostics when declared claimants drift", async () => {
  await db.tx(async (tx) => {
    await issuance.createPack(tx, clock, users.rights, { packId: "pak_drift", packCode: "DRIFT", title: "d", factsScopeId: SCOPE });
    await issuance.setPackClaimants(tx, clock, users.rights, "pak_drift", DECLARED.filter((d) => d.role !== "CMO"));
  });
  const text = POLICY_TEXT.replace("pack: pak_nova", "pack: pak_drift");
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_drift", packId: "pak_drift", sourceText: text }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r));
  await assert.rejects(db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, r)), (e: any) =>
    e.status === 422 && e.diagnostics.some((d: any) => d.code === "FACTS_CLAIMANT_DRIFT"));
});

test("activating a newer version supersedes the previous active version", async () => {
  const r2 = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));
  assert.equal(r2.version, 2);
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r2));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, r2));
  const rows = await db.pool.query("SELECT version, status FROM policy_version WHERE policy_id = 'pol_nova' ORDER BY version");
  assert.deepEqual(rows.rows.map((r) => [r.version, r.status]), [[1, "SUPERSEDED"], [2, "ACTIVE"]]);
});

test("verifyAttestations fails closed: no attestations, or a signer without a key", async () => {
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_verify", packId: PACK, sourceText: POLICY_TEXT }));
  const bare = r.factsDigest; // 봉인은 됐지만 서명은 없는 digest
  assert.deepEqual(await db.tx((tx) => signersOf(tx, bare)), []);
  assert.equal(await db.tx((tx) => verifyAttestations(tx, bare)), false);
  await db.tx((tx) => tx.query(
    "INSERT INTO attestation (digest, signer_id, role, key_version, alg, signature, signed_at) VALUES ($1,'usr_ghost','WORK_APPROVER','dev-1','Ed25519','AAAA',$2)",
    [r.policyDigest, clock.now()],
  ));
  assert.equal(await db.tx((tx) => verifyAttestations(tx, r.policyDigest)), false);
});

test("an ACTIVATOR who already signed the digest is refused", async () => {
  const both = await db.tx(async (tx) => {
    const { createUser, loadActor } = await import("../../src/platform/actor.ts");
    await createUser(tx, clock, { userId: "usr_ed_act", displayName: "ed+act", roles: ["EDITOR", "ACTIVATOR"] });
    return loadActor(tx, "usr_ed_act");
  });
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, both, { policyId: "pol_sod2", packId: PACK, sourceText: POLICY_TEXT }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r));
  await assert.rejects(db.tx((tx) => policy.activatePolicy(ctx, tx, clock, both, r)), { code: "SOD_VIOLATION", status: 403 });
});

test("setPackClaimants writes an audit row", async () => {
  await db.tx((tx) => issuance.setPackClaimants(tx, clock, users.rights, "pak_drift", DECLARED));
  const rows = await db.pool.query("SELECT actor_user_id FROM audit_log WHERE action_name = 'PACK_CLAIMANTS_SET' AND entity_id = 'pak_drift'");
  assert.ok(rows.rows.length >= 1);
  assert.equal(rows.rows.at(-1).actor_user_id, "usr_rights");
});

test("an open dispute in the scope refuses policy activation and rebind even off every projection path", async () => {
  // 조합 지분 경로 밖의 위임(작곡가 c는 실연자가 아니다)에 분쟁을 연다: checkActivation은 이 분쟁을 보지 않는다.
  await db.tx((tx) => reg.recordMandate(tx, clock, {
    mandateId: "m_offpath", factsScopeId: SCOPE, fromPartyId: "pty_author_c", toPartyId: "pty_cmo", rightKind: "PERFORMER", shareBps: 10000, status: "VERIFIED", validFrom: T0,
  }));
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r));
  await db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_offpath", targetType: "MANDATE", targetId: "m_offpath", reason: "off path" }));
  await assert.rejects(db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, r)), { code: "FACTS_DISPUTE_OPEN", status: 409 });
  await assert.rejects(db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova")), { code: "REBIND_REQUIRES_APPROVAL", status: 409 });
});
