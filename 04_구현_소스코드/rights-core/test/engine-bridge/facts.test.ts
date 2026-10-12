import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "mdrl/core";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import type { Tx } from "../../src/platform/db.ts";
import * as reg from "../../src/registry/service.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { loadSealed } from "../../src/engine-bridge/seal-store.ts";
import { loadFacts, sealFacts } from "../../src/engine-bridge/facts.ts";

const conformance = JSON.parse(readFileSync(new URL("../../../mdrl/conformance/facts/001-basic/input.json", import.meta.url), "utf8"));
const T0 = "2026-01-01T00:00:00.000Z";
const KNOWN_AT = "2026-06-01T00:00:00.000Z";
const KIND_TO_TYPE: Record<string, reg.PartyType> = { AGENCY: "AGENCY", AUTHOR: "AUTHOR", CMO: "CMO", LABEL: "LABEL", PERFORMER: "MEMBER" };

const shuffle = <T>(xs: T[], seed: number): T[] => {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

/** 적합성 facts 001-basic을 registry 행으로 등록한다(scope id = facts id). order가 있으면 각 목록 안의 순서를 섞는다. */
async function registerConformance(tx: Tx, seed?: number) {
  const c = fixedClock(T0, 0);
  const f = conformance.facts.body;
  const order = <T>(xs: T[]) => (seed === undefined ? xs : shuffle(xs, seed));
  for (const p of order<any>(f.parties)) {
    await reg.registerParty(tx, c, { partyId: p.id, partyType: KIND_TO_TYPE[p.kind]!, displayName: p.id, ...(p.ids?.isni && { isni: p.ids.isni }) });
  }
  await reg.registerWork(tx, c, { workId: "wrk_01", title: "Nova", iswc: f.works[0].ids.iswc });
  await reg.createScope(tx, c, { factsScopeId: conformance.facts.id, workId: "wrk_01" });
  await reg.registerRecording(tx, c, { recordingId: "rcd_01", workId: "wrk_01", masterOwnerPartyId: "pty_label_x", isrc: f.recordings[0].ids.isrc, versionTitle: "Main" });
  let sort = 1;
  for (const s of f.stems) await reg.registerSlot(tx, { slotId: s.slot, recordingId: "rcd_01", startMs: 0, endMs: 1000, sortOrder: sort++ });
  for (const s of order<any>(f.stems)) await reg.registerStem(tx, c, { stemId: s.id, slotId: s.slot, recordingId: s.of, rightsBearing: s.rights_bearing });
  for (const v of order<any>(f.voices)) await reg.registerVoice(tx, c, { voiceId: v.id, factsScopeId: conformance.facts.id, kind: v.kind });
  for (const cl of order<any>(f.claims)) {
    await reg.recordClaim(tx, c, {
      claimId: cl.id, factsScopeId: conformance.facts.id, sourceId: cl.source, edge: cl.edge, targetId: cl.target, shareBps: Number(cl.share),
      status: cl.status, validFrom: cl.valid.from,
      ...(cl.performer_role && { performerRole: cl.performer_role }), ...(cl.role_detail && { roleDetail: cl.role_detail }),
      ...(cl.evidence && { evidenceDigest: cl.evidence }),
    });
  }
  for (const m of order<any>(f.mandates)) {
    await reg.recordMandate(tx, c, {
      mandateId: m.id, factsScopeId: conformance.facts.id, fromPartyId: m.from, toPartyId: m.to, rightKind: m.right,
      shareBps: Number(m.share), status: m.status, validFrom: m.valid.from,
    });
  }
}

const blobRoot = mkdtempSync(join(tmpdir(), "rc-blobs-"));
after(() => rmSync(blobRoot, { recursive: true, force: true }));
const ctx = createBridgeCtx(createFsBlobStore(blobRoot));

test("golden: registry rows for conformance facts/001-basic seal to the conformance digest", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const sealed = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    assert.equal(sealed.digest, digestOf(conformance.facts));
    assert.equal(sealed.docVersion, "1");
    const back = await db.tx((tx) => loadFacts(ctx, tx, sealed.digest));
    assert.deepEqual(back, conformance.facts);
    const again = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    assert.equal(again.digest, sealed.digest);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM sealed_document");
    assert.equal(n.rows[0].n, 1);
  } finally {
    await drop();
  }
});

test("property: registration order does not change the digest", async () => {
  for (const seed of [7, 99, 2026]) {
    const { db, drop } = await freshDb();
    try {
      await db.tx((tx) => registerConformance(tx, seed));
      const sealed = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
      assert.equal(sealed.digest, digestOf(conformance.facts), `seed ${seed}`);
    } finally {
      await drop();
    }
  }
});

test("knownAt filters later records and bumps the version; superseded versions keep history", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const later = fixedClock("2026-03-01T00:00:00.000Z", 0);
    await db.tx(async (tx) => {
      const cur = await reg.currentClaim(tx, "c6");
      await reg.recordClaim(tx, later, { ...cur, status: "DISPUTED" });
    });
    const before = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, "2026-02-01T00:00:00.000Z"));
    assert.equal(before.digest, digestOf(conformance.facts));
    const afterDispute = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    assert.notEqual(afterDispute.digest, before.digest);
    assert.equal(afterDispute.docVersion, "2");
    const doc = await db.tx((tx) => loadFacts(ctx, tx, afterDispute.digest));
    const c6 = doc.body.claims.filter((c) => c.id.startsWith("c6"));
    assert.deepEqual(c6.map((c) => [c.id, c.status, c.superseded_at]), [
      ["c6", "VERIFIED", "2026-03-01T00:00:00.000Z"],
      ["c6.v2", "DISPUTED", undefined],
    ]);
  } finally {
    await drop();
  }
});

test("invalid facts are reported as MDRL diagnostics (422)", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const c = fixedClock("2026-03-01T00:00:00.000Z", 0);
    await db.tx(async (tx) => {
      const cur = await reg.currentClaim(tx, "c6");
      await reg.recordClaim(tx, c, { ...cur, shareBps: 5000 });
    });
    await assert.rejects(db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT)), (e: any) => {
      assert.equal(e.code, "FACTS_INVALID");
      assert.equal(e.status, 422);
      assert.ok(e.diagnostics.some((d: any) => d.code === "FACTS_SUM_MISMATCH"));
      return true;
    });
  } finally {
    await drop();
  }
});

test("loadSealed reads storage without the cache and 404s unknown digests", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const sealed = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    const fresh = createBridgeCtx(createFsBlobStore(blobRoot));
    const ok = await db.tx((tx) => loadSealed(fresh, tx, sealed.digest));
    assert.deepEqual(ok, conformance.facts);
    await assert.rejects(db.tx((tx) => loadSealed(fresh, tx, `mdrl:sha256:${"0".repeat(64)}`)), { code: "NOT_FOUND" });
  } finally {
    await drop();
  }
});

test("a rolled-back seal is not served from the cache", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const local = createBridgeCtx(createFsBlobStore(blobRoot));
    let digest = "";
    await assert.rejects(
      db.tx(async (tx) => {
        digest = (await sealFacts(local, tx, conformance.facts.id, KNOWN_AT)).digest;
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(digest, digestOf(conformance.facts));
    await assert.rejects(db.tx((tx) => loadSealed(local, tx, digest)), { code: "NOT_FOUND" });
  } finally {
    await drop();
  }
});

test("cached sealed documents are deeply frozen", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const sealed = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    const doc = await db.tx((tx) => loadFacts(ctx, tx, sealed.digest));
    assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.body.claims[0]) && Object.isFrozen(doc.body.claims[0]!.valid));
  } finally {
    await drop();
  }
});

test("non-canonical knownAt is rejected as INVALID_INSTANT (422)", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    for (const bad of ["2026-06-01T09:00:00.000+09:00", "2026-06-01T00:00:00Z", "2026-02-30T00:00:00.000Z"]) {
      await assert.rejects(db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, bad)), (e: any) => {
        assert.equal(e.code, "INVALID_INSTANT");
        assert.equal(e.status, 422);
        return true;
      }, bad);
    }
  } finally {
    await drop();
  }
});
