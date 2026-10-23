import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../helpers.ts";
import { createUser, ensureSystemIdentities, withSystemScope, type Role } from "../../src/platform/actor.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { createFsDocumentStore } from "../../src/documents/store.ts";
import { devSignatureProvider } from "../../src/contracts/esign.ts";
import { providerSigned } from "../../src/contracts/service.ts";
import { devIdentityProvider } from "../../src/performer/identity.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { payoutJobHandlers } from "../../src/payout/handlers.ts";
import { fakeProvider } from "../../src/payout/fake-provider.ts";
import { runDynamitePersonas, type Driver } from "../../src/scenario/dynamite-personas.ts";

// Dynamite 지급 금액 고정(3부-C, 결정 WD4 "금액은 바뀌지 않는다"): 데모와 같은 구매 수(조합 기본값 1,200·500·300·200)로 끝까지 돌려
// 5/1 지급 지시의 금액을 고정한다 — 소속사 2,285,920 · 레이블 2,030,952 · 작가 각 296,604(원천징수 뒤, 원천징수 각 83,650) · 합계 4,910,080.
const { db, drop } = await freshDb();
const dir = mkdtempSync(join(tmpdir(), "rc-payout-"));
after(async () => { await app.close(); await drop(); rmSync(dir, { recursive: true, force: true }); });
let now = "2026-01-01T00:00:00.000Z";
const clock = { now: () => now };
const jobs = recordingJobs();
const ctx = createBridgeCtx(createFsBlobStore(join(dir, "blobs")));
const provider = fakeProvider({ outcome: () => "PAID" });
const app = buildServer({ db, ctx, clock, jobs, provider, documents: createFsDocumentStore(join(dir, "docs"), Buffer.alloc(32, 3)), esign: devSignatureProvider, identity: devIdentityProvider });
await db.tx(async (tx) => {
  await ensureSystemIdentities(tx, clock);
  for (const [userId, role] of [["usr_ops", "SPACE_OPS"], ["usr_settle", "SPACE_SETTLE"], ["usr_settle2", "SPACE_SETTLE"]] as const) {
    await createUser(tx, clock, { userId, displayName: userId, roles: [role] });
  }
});
const reply = (r: Awaited<ReturnType<typeof app.inject>>) => { let body: unknown = r.body; try { body = r.json(); } catch { /* not json */ } return { status: r.statusCode, body }; };
const driver: Driver = {
  call: async (channel, actor, method, path, body) => reply(await app.inject({ method, url: `/${channel}${path}`, headers: actor ? { "x-actor": actor } : {}, ...(body === undefined ? {} : { payload: body as object }) })),
  upload: async (channel, actor, path, bytes, contentType) => reply(await app.inject({ method: "POST", url: `/${channel}${path}`, headers: { "x-actor": actor, "content-type": contentType }, payload: Buffer.from(bytes) })),
  setClock: async (at) => { assert.ok(at >= now, `clock goes forward: ${at}`); now = at; },
  drain: async () => {
    const handlers = { ...jobHandlers({ db, ctx, clock, jobs }), ...payoutJobHandlers({ db, clock, jobs, provider, pollDelaySeconds: 0 }) };
    while ((await jobs.drain(handlers)) > 0) { /* 처리기가 새로 넣은 작업까지 */ }
  },
  provisionUser: (u) => db.tx((tx) => createUser(tx, clock, { ...u, roles: u.roles as Role[] })),
  providerSigned: (id, party) => db.tx((tx) => withSystemScope(tx, () => providerSigned(tx, clock, devSignatureProvider, id, party))),
};


test("Dynamite payout amounts with the demo purchases are unchanged by the platform-trust removal (WD4)", async () => {
  const r = await runDynamitePersonas(driver);
  const pay = Object.fromEntries(r.payout.instructions.map((i: any) => [i.partyId, { net: Number(i.netKrw), wht: Number(i.withholdingKrw) }]));
  console.log(JSON.stringify(pay));
  assert.equal(pay.pty_bighit_agency.net, 2285920);
  assert.equal(pay.pty_bighit_label.net, 2030952);
  assert.equal(pay.pty_david_stewart.net, 296604);
  assert.equal(pay.pty_jessica_agombar.net, 296604);
  assert.equal(pay.pty_david_stewart.wht, 83650);
  assert.equal(pay.pty_jessica_agombar.wht, 83650);
  assert.equal(Object.values(pay).reduce((a: number, x: any) => a + x.net, 0), 4910080, "2,285,920 + 2,030,952 + 296,604 × 2 (시안의 4,909,080은 합계 오기)");
});
