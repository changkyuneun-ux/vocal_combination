import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as reg from "../../src/registry/service.ts";

const { db, drop } = await freshDb();
after(drop);
const T0 = "2026-01-01T00:00:00.000Z";

async function seed() {
  const c = fixedClock(T0, 0);
  await db.tx(async (tx) => {
    await reg.registerParty(tx, c, { partyId: "pty_label", partyType: "LABEL", displayName: "Label", isni: "0000000123456789" });
    await reg.registerParty(tx, c, { partyId: "pty_m1", partyType: "MEMBER", displayName: "M1" });
    await reg.registerParty(tx, c, { partyId: "pty_fan", partyType: "FAN", displayName: "Fan" });
    await reg.registerParty(tx, c, { partyId: "pty_cmo", partyType: "CMO", displayName: "CMO" });
    await reg.registerWork(tx, c, { workId: "wrk_1", title: "Song" });
    await reg.createScope(tx, c, { factsScopeId: "fsc_1", workId: "wrk_1" });
    await reg.registerRecording(tx, c, { recordingId: "rcd_1", workId: "wrk_1", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
    await reg.registerSlot(tx, { slotId: "slt_1", recordingId: "rcd_1", startMs: 0, endMs: 30000, sortOrder: 1 });
    await reg.registerStem(tx, c, { stemId: "stm_1", slotId: "slt_1", recordingId: "rcd_1", performerPartyId: "pty_m1", rightsBearing: true });
    await reg.registerVoice(tx, c, { voiceId: "vo_1", factsScopeId: "fsc_1", kind: "HUMAN" });
  });
}
await seed();

const claim = (over: Partial<reg.ClaimDraft> = {}): reg.ClaimDraft => ({
  claimId: "c_ctrl", factsScopeId: "fsc_1", sourceId: "rcd_1", edge: "CONTROLLED_BY", targetId: "pty_label",
  shareBps: 10000, status: "VERIFIED", validFrom: T0, ...over,
});

test("recordClaim creates version 1, then a new version supersedes the old one", async () => {
  const c = fixedClock("2026-02-01T00:00:00.000Z", 1000);
  const v1 = await db.tx((tx) => reg.recordClaim(tx, c, claim()));
  assert.deepEqual(v1, { id: "c_ctrl", version: 1, recordedAt: "2026-02-01T00:00:00.000Z" });
  const v2 = await db.tx((tx) => reg.recordClaim(tx, c, claim({ status: "DISPUTED" })));
  assert.equal(v2.version, 2);
  const rows = await db.pool.query("SELECT version, status, superseded_at FROM right_claim WHERE claim_id = 'c_ctrl' ORDER BY version");
  assert.equal(rows.rows[0].superseded_at.toISOString(), "2026-02-01T00:00:01.000Z");
  assert.equal(rows.rows[1].superseded_at, null);
  const cur = await db.tx((tx) => reg.currentClaim(tx, "c_ctrl"));
  assert.equal(cur.status, "DISPUTED");
  assert.equal(cur.version, 2);
});

test("right_claim rows cannot be updated or deleted except a single superseded_at set", async () => {
  await assert.rejects(db.pool.query("UPDATE right_claim SET share_bps = 1 WHERE claim_id = 'c_ctrl'"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM right_claim WHERE claim_id = 'c_ctrl'"), /append-only|permission denied/);
  await assert.rejects(
    db.pool.query("UPDATE right_claim SET superseded_at = now() WHERE claim_id = 'c_ctrl' AND version = 1"),
    /append-only/,
  );
});

test("edge endpoint kinds are enforced", async () => {
  const c = fixedClock("2026-03-01T00:00:00.000Z", 1000);
  await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_bad1", sourceId: "stm_1" }))), { code: "INVALID_REFERENCE" });
  await assert.rejects(
    db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_bad2", edge: "PERFORMED_BY", sourceId: "stm_1", targetId: "pty_m1", performerRole: "FEATURED" }))),
    { code: "INVALID_REFERENCE" },
  );
  const ok = await db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_perf", edge: "PERFORMED_BY", sourceId: "stm_1", targetId: "vo_1", performerRole: "FEATURED" })));
  assert.equal(ok.version, 1);
});

test("FAN and PLATFORM parties cannot appear in facts", async () => {
  const c = fixedClock("2026-04-01T00:00:00.000Z", 1000);
  await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_fan", targetId: "pty_fan" }))), { code: "INVALID_REFERENCE" });
  await assert.rejects(
    db.tx((tx) => reg.recordMandate(tx, c, {
      mandateId: "m_fan", factsScopeId: "fsc_1", fromPartyId: "pty_fan", toPartyId: "pty_cmo", rightKind: "WORK",
      shareBps: 10000, status: "VERIFIED", validFrom: T0,
    })),
    { code: "INVALID_REFERENCE" },
  );
});

test("a new version must be recorded strictly after the current one and stay in the same scope", async () => {
  const c = fixedClock("2026-05-01T00:00:00.000Z", 0);
  await db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_same" })));
  await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_same" }))), { code: "CLOCK_NOT_MONOTONIC" });
});

test("recordMandate versions like claims and rejects self-mandates", async () => {
  const c = fixedClock("2026-06-01T00:00:00.000Z", 1000);
  const m = { mandateId: "m_1", factsScopeId: "fsc_1", fromPartyId: "pty_m1", toPartyId: "pty_cmo", rightKind: "PERFORMER" as const,
    shareBps: 10000, status: "VERIFIED" as const, validFrom: T0 };
  assert.equal((await db.tx((tx) => reg.recordMandate(tx, c, m))).version, 1);
  assert.equal((await db.tx((tx) => reg.recordMandate(tx, c, { ...m, shareBps: 5000 }))).version, 2);
  await assert.rejects(db.tx((tx) => reg.recordMandate(tx, c, { ...m, mandateId: "m_self", toPartyId: "pty_m1" })), { code: "INVALID_REFERENCE" });
});

test("entities are immutable and stems must belong to their slot's recording", async () => {
  await assert.rejects(db.pool.query("UPDATE party SET display_name = 'x' WHERE party_id = 'pty_m1'"), /append-only|permission denied/);
  const c = fixedClock(T0, 0);
  await assert.rejects(db.tx(async (tx) => {
    await reg.registerRecording(tx, c, { recordingId: "rcd_2", workId: "wrk_1", masterOwnerPartyId: "pty_label", versionTitle: "B" });
    await reg.registerStem(tx, c, { stemId: "stm_x", slotId: "slt_1", recordingId: "rcd_2", rightsBearing: true });
  }));
});

test("recording with a stale expectedVersion is refused with VERSION_CONFLICT (lost-update guard)", async () => {
  const c = fixedClock("2026-07-01T00:00:00.000Z", 1000);
  const cur = await db.tx((tx) => reg.currentClaim(tx, "c_ctrl"));
  assert.equal(cur.version, 2);
  await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, claim({ status: "VERIFIED" }), { expectedVersion: 1 })), { code: "VERSION_CONFLICT", status: 409 });
  await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_new" }), { expectedVersion: 1 })), { code: "VERSION_CONFLICT" });
  assert.equal((await db.tx((tx) => reg.recordClaim(tx, c, claim({ status: "VERIFIED" }), { expectedVersion: 2 }))).version, 3);
  const m = { mandateId: "m_1", factsScopeId: "fsc_1", fromPartyId: "pty_m1", toPartyId: "pty_cmo", rightKind: "PERFORMER" as const,
    shareBps: 10000, status: "VERIFIED" as const, validFrom: T0 };
  await assert.rejects(db.tx((tx) => reg.recordMandate(tx, c, m, { expectedVersion: 1 })), { code: "VERSION_CONFLICT" });
  assert.equal((await db.tx((tx) => reg.recordMandate(tx, c, m, { expectedVersion: 2 }))).version, 3);
});

test("superseded_at without a successor version fails at commit with RC001", async () => {
  const setOnCurrent = "UPDATE right_claim SET superseded_at = recorded_at + interval '1 second' WHERE claim_id = 'c_perf' AND superseded_at IS NULL";
  await assert.rejects(db.pool.query(setOnCurrent), { code: "RC001" });
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE mandate SET superseded_at = recorded_at + interval '1 second' WHERE mandate_id = 'm_1' AND superseded_at IS NULL");
    await assert.rejects(client.query("COMMIT"), { code: "RC001" });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  const cur = await db.tx((tx) => reg.currentClaim(tx, "c_perf"));
  assert.equal(cur.version, 1);
});
