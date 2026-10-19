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

// Dynamite를 페르소나별 채널 API로 끝까지(MVP 점검 2026-10-16): 빅히트 테넌트 → 멤버 → 운영 → 가상 팬 → 정산·지급·명세.
const { db, drop } = await freshDb();
const dir = mkdtempSync(join(tmpdir(), "rc-personas-"));
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

test("Dynamite end to end by persona: BigHit tenant, members, operators and fans through their own channels", async () => {
  const r = await runDynamitePersonas(driver, { purchases: { vc_bts_orig: 12, vc_bts_swap: 5, vc_bts_vocal: 3, vc_bts_jin: 2 } });
  // 정합성: 근거 문서·동의·확인·지급 정보를 갖춘 뒤라 차단 이슈 없이 활성화됐다(빅히트 테넌트는 적용 대상).
  assert.deepEqual(r.validationBlocksBeforeActivation, []);
  // 참여 기관(가상 신탁단체)은 활성이고, 신탁 연결은 제안 상태다(확인 전에는 위임이 없어 금액이 그대로다).
  const link = (await db.pool.query("SELECT status, proposed_side FROM participant_link WHERE link_id = 'lnk_trust_demo'")).rows[0];
  assert.deepEqual(link, { status: "PROPOSED", proposed_side: "RIGHTS" });
  assert.deepEqual(r.issued, ["vc_bts_orig", "vc_bts_swap", "vc_bts_vocal", "vc_bts_jin"]);
  assert.equal(r.soloRejected.code, "ISSUE_NOT_SETTLEABLE");
  // 정산: 조합마다 run, 독립 재계산 통과 뒤 확정.
  assert.equal(r.runs.length, 4);
  assert.ok(r.runs.every((x: string) => x.endsWith("VERIFIED")));
  // 지급: 빅히트 레이블·소속사(국내 법인), 작가는 최소 지급액 미만이면 이월.
  const byParty = Object.fromEntries(r.payout.instructions.map((i: any) => [i.partyId, i.status]));
  assert.ok(["SUBMITTED", "PAID", "PENDING"].includes(byParty.pty_bighit_label), byParty.pty_bighit_label);
  assert.ok(["SUBMITTED", "PAID", "PENDING"].includes(byParty.pty_bighit_agency));
  // 명세: 레이블은 정산·환불 역분개가 보인다. 멤버 몫은 소속사 명세에 있다(위임 100%).
  assert.equal(r.statements.label.reversed, "-924");
  assert.ok(BigInt(r.statements.agency.settled) > 0n);
  // 멤버는 실연자 앱에서 위임 전 자기 기여분(참고값)을 본다.
  assert.ok(JSON.stringify(r.contributions).includes("vc_bts_orig"));
  // 격리: 빅히트는 작가(플랫폼 밖 당사자)·다른 멤버의 명세를 볼 수 없고, 멤버는 운영·포털 채널에 들어갈 수 없다.
  assert.equal((await driver.call("portal", "usr_bh_rights", "GET", "/parties/pty_david_stewart/statements?from=2026-01-01T00:00:00.000Z&to=2026-05-02T00:00:00.000Z")).status, 404);
  assert.equal((await driver.call("portal", "usr_member_jungkook", "GET", "/my/parties")).status, 403);
  assert.equal((await driver.call("ops", "usr_bh_rights", "GET", "/batches")).status, 403);
});
