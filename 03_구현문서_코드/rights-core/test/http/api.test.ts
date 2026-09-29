import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { DECLARED, POLICY_TEXT, T0, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import type { InjectOptions } from "fastify";
import { buildServer } from "../../src/http/server.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
await db.tx((tx) => seedUsers(tx, fixedClock(T0, 0)));
const app = buildServer({ db, ctx, clock });
after(async () => { await app.close(); await drop(); cleanup(); });

const call = (method: "GET" | "POST" | "PUT", url: string, actor?: string, payload?: object) => {
  const opts: InjectOptions = { method, url };
  if (actor) opts.headers = { "x-actor": actor };
  if (payload !== undefined) opts.payload = payload;
  return app.inject(opts);
};
const post = (url: string, actor: string, payload: object) => call("POST", url, actor, payload);

test("registration requires an actor with RIGHTS_EDITOR", async () => {
  assert.equal((await call("POST", "/parties", undefined, { partyId: "p", partyType: "LABEL", displayName: "p" })).statusCode, 401);
  const r = await post("/parties", "usr_editor", { partyId: "p", partyType: "LABEL", displayName: "p" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().code, "ROLE_REQUIRED");
});

test("end-to-end: register a song, compile/approve/activate a policy, activate the pack, issue, audit", async () => {
  const R = "usr_rights";
  const ok = async (p: Promise<{ statusCode: number; body: string }>, status = 201) => {
    const r = await p;
    assert.equal(r.statusCode, status, r.body);
    return JSON.parse(r.body || "{}");
  };
  for (const [partyId, partyType] of [["pty_label", "LABEL"], ["pty_agency", "AGENCY"], ["pty_author_b", "AUTHOR"], ["pty_author_c", "AUTHOR"], ["pty_cmo", "CMO"], ["pty_member_a", "MEMBER"], ["pty_member_b", "MEMBER"]]) {
    await ok(post("/parties", R, { partyId, partyType, displayName: partyId }));
  }
  await ok(post("/works", R, { workId: "wrk_nova", title: "Nova" }));
  await ok(post("/scopes", R, { factsScopeId: "fsc_nova", workId: "wrk_nova" }));
  await ok(post("/recordings", R, { recordingId: "rcd_nova", workId: "wrk_nova", masterOwnerPartyId: "pty_label", versionTitle: "Main" }));
  await ok(post("/slots", R, { slotId: "slt_1", recordingId: "rcd_nova", startMs: 0, endMs: 30000, sortOrder: 1 }));
  await ok(post("/slots", R, { slotId: "slt_2", recordingId: "rcd_nova", startMs: 30000, endMs: 90000, sortOrder: 2 }));
  for (const m of ["a", "b"]) for (const s of ["1", "2"]) {
    await ok(post("/stems", R, { stemId: `stm_${m}${s}`, slotId: `slt_${s}`, recordingId: "rcd_nova", performerPartyId: `pty_member_${m}`, rightsBearing: true }));
  }
  for (const m of ["a", "b"]) await ok(post("/voices", R, { voiceId: `vo_${m}`, factsScopeId: "fsc_nova", kind: "HUMAN" }));
  const base = { factsScopeId: "fsc_nova", status: "VERIFIED", validFrom: T0 };
  for (const m of ["a", "b"]) for (const s of ["1", "2"]) {
    await ok(post("/claims", R, { ...base, claimId: `c_perf_${m}${s}`, sourceId: `stm_${m}${s}`, edge: "PERFORMED_BY", targetId: `vo_${m}`, shareBps: 10000, performerRole: "FEATURED" }));
  }
  for (const m of ["a", "b"]) await ok(post("/claims", R, { ...base, claimId: `c_own_${m}`, sourceId: `vo_${m}`, edge: "OWNED_BY", targetId: `pty_member_${m}`, shareBps: 10000 }));
  await ok(post("/claims", R, { ...base, claimId: "c_master", sourceId: "rcd_nova", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000 }));
  await ok(post("/claims", R, { ...base, claimId: "c_lyrics", sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, roleDetail: "LYRICS" }));
  await ok(post("/claims", R, { ...base, claimId: "c_music", sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_c", shareBps: 4000, roleDetail: "COMPOSITION" }));
  await ok(post("/mandates", R, { ...base, mandateId: "m_cmo", fromPartyId: "pty_author_b", toPartyId: "pty_cmo", rightKind: "WORK", shareBps: 10000 }));
  await ok(post("/mandates", R, { ...base, mandateId: "m_agency", fromPartyId: "pty_member_a", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000 }));
  await ok(post("/packs", R, { packId: "pak_nova", packCode: "NOVA", title: "Nova", factsScopeId: "fsc_nova" }));
  await ok(call("PUT", "/packs/pak_nova/claimants", R, DECLARED), 200);

  const bad = await post("/policies/pol_nova/compile", "usr_editor", { packId: "pak_nova", sourceText: "allocation {" });
  assert.equal(bad.statusCode, 422);
  assert.ok(bad.json().diagnostics.some((d: any) => d.code === "PARSE_SYNTAX"));
  const compiled = await ok(post("/policies/pol_nova/compile", "usr_editor", { packId: "pak_nova", sourceText: POLICY_TEXT }));
  await ok(post(`/policies/pol_nova/versions/${compiled.version}/approve`, "usr_approver", {}), 200);
  await ok(post(`/policies/pol_nova/versions/${compiled.version}/activate`, "usr_activator", {}), 200);
  await ok(post("/packs/pak_nova/activate", "usr_activator", {}), 200);
  const seal = await ok(post("/issues", "usr_issuer", {
    packId: "pak_nova", vcId: "vc_api", assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_2", stemId: "stm_b2" }],
    members: { pty_member_a: 5000, pty_member_b: 5000 },
  }));
  const doc = await ok(call("GET", `/seals/${encodeURIComponent(seal.projectionDigest)}`), 200);
  assert.equal(doc.format, "vcrl-projection/1");
  const audit = await ok(call("GET", "/issues/snp_vc_api/audit"), 200);
  assert.equal(audit.ok, true);
  const dup = await post("/issues", "usr_issuer", {
    packId: "pak_nova", vcId: "vc_api", assignments: [{ slotId: "slt_1", stemId: "stm_a1" }], members: { pty_member_a: 10000 },
  });
  assert.equal(dup.statusCode, 409);
  assert.equal((await call("GET", `/seals/${encodeURIComponent(`vcrl:sha256:${"0".repeat(64)}`)}`)).statusCode, 404);
});

test("empty JSON body is treated as {}; malformed JSON and missing fields are 400, not 500", async () => {
  const empty = await app.inject({ method: "POST", url: "/packs/none/activate", headers: { "x-actor": "usr_activator", "content-type": "application/json" } });
  assert.equal(empty.statusCode, 404, empty.body);
  const bad = await app.inject({ method: "POST", url: "/works", headers: { "x-actor": "usr_rights", "content-type": "application/json" }, payload: "{oops" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "BAD_REQUEST");
  const noBody = await app.inject({ method: "POST", url: "/policies/pol_x/compile", headers: { "x-actor": "usr_editor" } });
  assert.equal(noBody.statusCode, 400, noBody.body);
});
