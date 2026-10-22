import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { createUser, ensureSystemIdentities } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { stageOf } from "../../src/registry/overview.ts";
import { tempBridge } from "../fixtures.ts";

// 포털 작품 목록·곡 워크스페이스(2부-B Task 1): 작품 개요(진행 단계)와 IR 생성 준비 조회. 테넌트는 자기 곡만 본다.
const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
const app = buildServer({ db, ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await drop(); cleanup(); });
await db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await ensureSystemIdentities(tx, c0);
  for (const t of ["tnt_lbl", "tnt_other"]) await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ($1, 'LABEL', $2, $3)", [t, t, c0.now()]);
  await registerParty(tx, c0, { partyId: "pty_lbl", partyType: "LABEL", displayName: "레이블", tenantId: "tnt_lbl" });
  await registerParty(tx, c0, { partyId: "pty_writer", partyType: "AUTHOR", displayName: "작가 W" });
  await registerParty(tx, c0, { partyId: "pty_mem", partyType: "MEMBER", displayName: "멤버 M", tenantId: "tnt_platform_default" });
  await createUser(tx, c0, { userId: "usr_lbl", displayName: "label", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_other", displayName: "other", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_other" });
});
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const T0 = "2026-01-01T00:00:00.000Z";
for (const [path, body] of [
  ["/works", { workId: "wrk_x", title: "X" }], ["/scopes", { factsScopeId: "fsc_x", workId: "wrk_x" }],
  ["/recordings", { recordingId: "rcd_x", workId: "wrk_x", masterOwnerPartyId: "pty_lbl", versionTitle: "Main" }],
  ["/slots", { slotId: "slt_x1", recordingId: "rcd_x", startMs: 0, endMs: 9000, sortOrder: 1, sectionLabel: "Chorus",
    parts: [{ partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 0, endMs: 9000, originalPartyId: "pty_mem" }, { partNo: 2, kind: "INSTRUMENT", startMs: 0, endMs: 9000 }] }],
  ["/stems", { stemId: "stm_x1", slotId: "slt_x1", partNo: 1, recordingId: "rcd_x", performerPartyId: "pty_mem", rightsBearing: true }],
  ["/claims", { claimId: "c_x_work", factsScopeId: "fsc_x", sourceId: "wrk_x", edge: "WRITTEN_BY", targetId: "pty_writer", shareBps: 10000, status: "ASSERTED", validFrom: T0 }],
] as const) await json("POST", `/portal${path}`, "usr_lbl", 201, body);

test("works overview: counts, authors and stage for the tenant's song; another tenant does not see it", async () => {
  const list = await json("GET", "/portal/works/overview", "usr_lbl", 200);
  const w = list.find((x: any) => x.workId === "wrk_x");
  assert.ok(w, JSON.stringify(list));
  assert.equal(w.scopeId, "fsc_x");
  assert.equal(w.recordingTitle, "Main");
  assert.deepEqual(w.authors, ["작가 W"]);
  assert.deepEqual(w.rights, { work: 1, master: 0, performers: 0 });
  assert.deepEqual([w.slots, w.vocalParts, w.stems], [1, 1, 1]);
  assert.equal(w.pendingConfirmations, 1);
  assert.equal(w.sealed, false);
  assert.equal(w.pack, null);
  assert.equal(w.stage, 1);
  assert.equal(w.status, "확인 대기");
  const other = await json("GET", "/portal/works/overview", "usr_other", 200);
  assert.equal(other.some((x: any) => x.workId === "wrk_x"), false);
});

test("readiness: confirmations warn, master share missing, original stem present; another tenant gets 404", async () => {
  const r = await json("GET", "/portal/scopes/fsc_x/readiness", "usr_lbl", 200);
  const by = Object.fromEntries(r.items.map((i: any) => [i.key, i]));
  assert.deepEqual(Object.keys(by), ["shares", "evidence", "originalStems", "confirmations", "consents", "mandates", "audio", "blocks"]);
  assert.equal(by.confirmations.ok, "warn");
  assert.equal(by.shares.ok, false, "no master claim yet");
  assert.equal(by.originalStems.ok, true);
  await json("GET", "/portal/scopes/fsc_x/readiness", "usr_other", 404);
});

test("stage rules: active pack sells, active policy waits, sealed is IR, dispute or paused pack is on hold", () => {
  const base = { packStatus: null, activePolicy: false, sealed: false, pending: 0, openDisputes: 0 };
  assert.deepEqual(stageOf(base), { stage: 0, status: "입력 중" });
  assert.deepEqual(stageOf({ ...base, sealed: true, pending: 3 }), { stage: 2, status: "IR 생성됨" });
  assert.deepEqual(stageOf({ ...base, sealed: true, activePolicy: true }), { stage: 3, status: "IR 생성됨" });
  assert.deepEqual(stageOf({ ...base, packStatus: "ACTIVE", activePolicy: true, sealed: true }), { stage: 4, status: "판매 중" });
  assert.deepEqual(stageOf({ ...base, packStatus: "PAUSED", activePolicy: true, sealed: true }), { stage: 3, status: "분쟁·보류" });
  assert.deepEqual(stageOf({ ...base, openDisputes: 1 }), { stage: 0, status: "분쟁·보류" });
});
