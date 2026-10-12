import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { freshDb } from "../helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { processOutbox } from "../../src/platform/outbox.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";
import { closeDispute, openDispute } from "../../src/registry/disputes.ts";
import * as reg from "../../src/registry/service.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);

const users = await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  const u = await seedUsers(tx, fixedClock(T0, 0));
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
  return u;
});
await db.tx(async (tx) => {
  const r = await policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT });
  await policy.approvePolicy(ctx, tx, clock, users.approver, r);
  await policy.activatePolicy(ctx, tx, clock, users.activator, r);
  await issuance.activatePack(ctx, tx, clock, users.activator, PACK);
});
const combo = (vcId: string) => ({
  packId: PACK, vcId, assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_2", stemId: "stm_b2" }],
  members: { pty_member_a: 5000, pty_member_b: 5000 },
});
const packStatus = async () => (await db.pool.query("SELECT status FROM vocal_pack WHERE pack_id = $1", [PACK])).rows[0].status;

test("opening a dispute records a DISPUTED version and the outbox pauses the pack", async () => {
  await db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_1", targetType: "RIGHT_CLAIM", targetId: "c_own_b", reason: "ownership contested" }));
  const cur = await db.tx((tx) => reg.currentClaim(tx, "c_own_b"));
  assert.equal(cur.status, "DISPUTED");
  assert.equal(await packStatus(), "ACTIVE");
  assert.equal(await processOutbox(db, issuance.OUTBOX_HANDLERS, clock), 1);
  assert.equal(await packStatus(), "PAUSED");
  assert.equal(await processOutbox(db, issuance.OUTBOX_HANDLERS, clock), 0);
  const paused = await db.pool.query("SELECT actor_user_id, after_json FROM audit_log WHERE action_name = 'PACK_PAUSED' AND entity_id = $1", [PACK]);
  assert.deepEqual(paused.rows.map((r) => [r.actor_user_id, r.after_json]), [["system:outbox", { disputeId: "dsp_1" }]]);
  await assert.rejects(db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_dup", targetType: "RIGHT_CLAIM", targetId: "c_own_b", reason: "again" })), (e: any) => e.code === "23505" || e.code === "CONFLICT");
});

test("while disputed: issuing, pack activation and rebind are refused", async () => {
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_d1"))), { code: "PACK_NOT_ACTIVE" });
  await assert.rejects(db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK)), { code: "FACTS_DISPUTE_OPEN" });
  await assert.rejects(db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova")), { code: "REBIND_REQUIRES_APPROVAL" });
});

test("closing restores VERIFIED; a light rebind pins the new facts; the pack reactivates and issues", async () => {
  await db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_1" }));
  const cur = await db.tx((tx) => reg.currentClaim(tx, "c_own_b"));
  assert.equal(cur.status, "VERIFIED");
  // 활성 정책은 분쟁 이전 facts에 고정돼 있으므로 재고정 없이 재활성화할 수 없다.
  await assert.rejects(db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK)), { code: "REBIND_REQUIRED", status: 409 });
  const before = await db.tx((tx) => policy.activePolicyForPack(tx, PACK));
  const rb = await db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova"));
  assert.equal(rb.version, before!.version + 1);
  assert.notEqual(rb.factsDigest, before!.factsDigest);
  const rows = await db.pool.query("SELECT version, status, rebind_of_version FROM policy_version WHERE policy_id = 'pol_nova' ORDER BY version");
  assert.deepEqual(rows.rows.map((r) => [r.version, r.status, r.rebind_of_version]), [[1, "SUPERSEDED", null], [2, "ACTIVE", 1]]);
  await db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK));
  const seal = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_after")));
  assert.equal(seal.factsDigest, rb.factsDigest);
  await assert.rejects(db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova")), { code: "REBIND_NOT_NEEDED" });
});

test("a dispute opened and closed before the outbox runs still forces a rebind before issuing", async () => {
  await db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_quick", targetType: "RIGHT_CLAIM", targetId: "c_master", reason: "quick" }));
  await db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_quick" }));
  assert.equal(await packStatus(), "ACTIVE", "outbox not processed: the pack was never paused");
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_quick"))), { code: "REBIND_REQUIRED", status: 409 });
  const rb = await db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova"));
  const seal = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_quick")));
  assert.equal(seal.factsDigest, rb.factsDigest);
});

test("an issue racing an opening dispute waits for it and then sees the dispute", async () => {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await openDispute(client, clock, { disputeId: "dsp_race", targetType: "RIGHT_CLAIM", targetId: "c_master", reason: "race" });
    let settled = false;
    const racing = db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_race"))).finally(() => { settled = true; });
    racing.catch(() => undefined);
    await sleep(300);
    assert.equal(settled, false, "issue must block on the pack lock held by openDispute");
    await client.query("COMMIT");
    await assert.rejects(racing, { code: "FACTS_DISPUTE_OPEN" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  await db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_race" }));
});

test("a rebind that would change the claimant set requires full approval", async () => {
  // 녹음 기여자(RECORDING_CONTRIBUTOR)가 새로 생기면 파생 청구권자 집합이 바뀐다.
  await db.tx((tx) => reg.recordClaim(tx, clock, {
    claimId: "c_contrib", factsScopeId: SCOPE, sourceId: "rcd_nova", edge: "CONTRIBUTED_BY", targetId: "pty_author_c",
    shareBps: 10000, status: "VERIFIED", validFrom: T0,
  }));
  await assert.rejects(db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova")), (e: any) =>
    e.code === "REBIND_REQUIRES_APPROVAL" && e.status === 409
    && e.diagnostics.some((d: any) => d.code === "FACTS_CLAIMANT_DRIFT" && d.message.includes("RECORDING_CONTRIBUTOR:pty_author_c")));
});

test("closing with a resolution amends the claim in a new VERIFIED version", async () => {
  await db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_2", targetType: "MANDATE", targetId: "m_agency", reason: "term" }));
  await processOutbox(db, issuance.OUTBOX_HANDLERS, clock);
  assert.equal(await packStatus(), "PAUSED");
  await db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_2", resolution: { shareBps: 5000 } }));
  await assert.rejects(db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK)), { code: "REBIND_REQUIRED", status: 409 });
  const m = await db.tx((tx) => reg.currentMandate(tx, "m_agency"));
  assert.equal(m.status, "VERIFIED");
  assert.equal(m.shareBps, 5000);
  const d = await db.pool.query("SELECT status, closed_at FROM dispute WHERE dispute_id = 'dsp_2'");
  assert.equal(d.rows[0].status, "CLOSED");
  assert.notEqual(d.rows[0].closed_at, null);
  await assert.rejects(db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_2" })), { code: "INVALID_STATE" });
  await assert.rejects(db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_none" })), { code: "NOT_FOUND" });
});

test("dispute timestamps must be millisecond-truncated", async () => {
  await assert.rejects(db.pool.query(
    "INSERT INTO dispute (dispute_id, target_type, target_id, facts_scope_id, dispute_reason, opened_at) VALUES ('dsp_us','RIGHT_CLAIM','c_master',$1,'x','2026-03-01T00:00:00.000001Z')", [SCOPE],
  ), /check constraint/);
});
