import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { freshDb } from "../helpers.ts";
import { SCOPE, T0, seedSong, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as reg from "../../src/registry/service.ts";
import { openDispute } from "../../src/registry/disputes.ts";
import { loadFacts, sealFacts } from "../../src/engine-bridge/facts.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });
await db.tx((tx) => seedSong(tx, fixedClock(T0, 0)));

const KNOWN_AT = "2026-03-01T00:00:00.000Z";
const contrib = (claimId: string): reg.ClaimDraft => ({
  claimId, factsScopeId: SCOPE, sourceId: "rcd_nova", edge: "CONTRIBUTED_BY", targetId: "pty_author_c", shareBps: 10000, status: "VERIFIED", validFrom: T0,
});

test("a seal waits for an uncommitted writer whose recorded_at precedes knownAt, then includes its row", async () => {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await reg.recordClaim(client, fixedClock("2026-02-01T00:00:00.000Z", 0), contrib("c_contrib"));
    let settled = false;
    const sealing = db.tx((tx) => sealFacts(ctx, tx, SCOPE, KNOWN_AT)).finally(() => { settled = true; });
    sealing.catch(() => undefined);
    await sleep(300);
    assert.equal(settled, false, "sealFacts must wait for the writer holding the scope FOR SHARE");
    await client.query("COMMIT");
    const sealed = await sealing;
    const doc = await db.tx((tx) => loadFacts(ctx, tx, sealed.digest));
    assert.ok(doc.body.claims.some((c) => c.id === "c_contrib"), "the committed row is in the seal");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
});

test("after a seal, writers at or before sealed_through are refused with FACTS_SEALED_THROUGH", async () => {
  const through = (await db.pool.query("SELECT sealed_through FROM facts_scope WHERE facts_scope_id = $1", [SCOPE])).rows[0].sealed_through;
  assert.equal(through.toISOString(), KNOWN_AT);
  const refused = { code: "FACTS_SEALED_THROUGH", status: 409 };
  for (const at of [KNOWN_AT, "2026-02-15T00:00:00.000Z"]) {
    const c = fixedClock(at, 0);
    await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, contrib("c_late"))), refused, at);
    await assert.rejects(db.tx((tx) => reg.recordMandate(tx, c, {
      mandateId: "m_late", factsScopeId: SCOPE, fromPartyId: "pty_author_c", toPartyId: "pty_cmo", rightKind: "WORK", shareBps: 10000, status: "VERIFIED", validFrom: T0,
    })), refused, at);
    await assert.rejects(db.tx((tx) => reg.registerVoice(tx, c, { voiceId: "vo_late", factsScopeId: SCOPE, kind: "AI" })), refused, at);
    await assert.rejects(db.tx((tx) => reg.registerStem(tx, c, { stemId: "stm_late", slotId: "slt_1", recordingId: "rcd_nova", rightsBearing: true })), refused, at);
    await assert.rejects(db.tx((tx) => reg.registerRecording(tx, c, { recordingId: "rcd_late", workId: "wrk_nova", masterOwnerPartyId: "pty_label", versionTitle: "Late" })), refused, at);
    await assert.rejects(db.tx((tx) => openDispute(tx, c, { disputeId: "dsp_late", targetType: "RIGHT_CLAIM", targetId: "c_master", reason: "late" })), refused, at);
  }
  // 기준 시점을 과거로 다시 봉인해도 울타리는 내려가지 않는다.
  await db.tx((tx) => sealFacts(ctx, tx, SCOPE, "2026-02-01T00:00:00.000Z"));
  assert.equal((await db.pool.query("SELECT sealed_through FROM facts_scope WHERE facts_scope_id = $1", [SCOPE])).rows[0].sealed_through.toISOString(), KNOWN_AT);
  // 울타리 뒤의 쓰기는 통과한다. 범위가 없는 작품의 녹음은 울타리가 없다.
  const later = fixedClock("2026-03-01T00:00:00.001Z", 1);
  await db.tx((tx) => reg.recordClaim(tx, later, contrib("c_after")));
  await db.tx(async (tx) => {
    const old = fixedClock(T0, 0);
    await reg.registerWork(tx, old, { workId: "wrk_unscoped", title: "No scope" });
    await reg.registerRecording(tx, old, { recordingId: "rcd_unscoped", workId: "wrk_unscoped", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
  });
});
