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
import { ensureSuperAdmin } from "../../src/platform/super-admin.ts";

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
  provisionSuperAdmin: (a) => db.tx((tx) => ensureSuperAdmin(tx, clock, a)),
  providerSigned: (id, party) => db.tx((tx) => withSystemScope(tx, () => providerSigned(tx, clock, devSignatureProvider, id, party))),
};

test("Dynamite end to end by persona: BigHit tenant, members, operators and fans through their own channels", async () => {
  const r = await runDynamitePersonas(driver, { purchases: { vc_bts_orig: 12, vc_bts_swap: 5, vc_bts_vocal: 3, vc_bts_jin: 2 } });
  // 정합성: 근거 문서·동의·확인·지급 정보를 갖춘 뒤라 차단 이슈 없이 활성화됐다(빅히트 테넌트는 적용 대상).
  assert.deepEqual(r.validationBlocksBeforeActivation, []);
  // 참여 기관(가상 신탁단체)은 활성이고, 신탁 연결은 제안 상태다(확인 전에는 위임이 없어 금액이 그대로다).
  const link = (await db.pool.query("SELECT status, proposed_side FROM participant_link WHERE link_id = 'lnk_trust_demo'")).rows[0];
  assert.deepEqual(link, { status: "PROPOSED", proposed_side: "RIGHTS" });
  // 슬롯 12·파트 34(보컬 20·그룹 2·반주 12)·스템 154(SL-S4). 보컬 스템과 함께 만든 보이스·실연 주장 147건은 멤버가 모두 확인했다.
  const count = async (sql: string) => (await db.pool.query(sql)).rows[0].n as number;
  assert.equal(await count("SELECT count(*)::int AS n FROM part_slot WHERE recording_id = 'rcd_dynamite'"), 12);
  assert.deepEqual((await db.pool.query("SELECT p.kind, count(*)::int AS n FROM slot_part p JOIN part_slot s USING (slot_id) WHERE s.recording_id = 'rcd_dynamite' GROUP BY 1 ORDER BY 1")).rows,
    [{ kind: "GROUP", n: 2 }, { kind: "INSTRUMENT", n: 12 }, { kind: "VOCAL", n: 20 }]);
  assert.equal(await count("SELECT count(*)::int AS n FROM stem WHERE recording_id = 'rcd_dynamite'"), 154);
  assert.equal(await count("SELECT count(*)::int AS n FROM confirmation_request r JOIN party p ON p.party_id = r.counterparty_id WHERE p.party_type = 'MEMBER' AND r.status = 'CONFIRMED'"), 147);
  // 곡 워크스페이스 문서·계약: 빅히트는 자기 곡 범위의 계약을 다 본다 — 플랫폼이 작가와 맺은 작품 이용허락도(조회만).
  const ctr = (await driver.call("portal", "usr_bh_rights", "GET", "/contracts?scope=fsc_dynamite")).body as { contractId: string }[];
  assert.ok(ctr.some((c) => c.contractId === "ctr_work_david_stewart"), JSON.stringify(ctr.map((c) => c.contractId)));
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
  // 데모 구매 수로 돌린 지급 금액 고정은 dynamite-payout.test.ts에 있다(이 시험은 구매 수를 줄여 돈다).
  // 작가는 빅히트 관리 당사자다(결정 WD1·WD4): 관리 테넌트, 지급 정보 등록자, 명세는 빅히트가 본다.
  assert.deepEqual((await db.pool.query("SELECT party_id, tenant_id FROM party WHERE party_type = 'AUTHOR' ORDER BY party_id")).rows,
    [{ party_id: "pty_david_stewart", tenant_id: "tnt_bighit" }, { party_id: "pty_jessica_agombar", tenant_id: "tnt_bighit" }]);
  const mine = (await driver.call("portal", "usr_bh_rights", "GET", "/my/parties")).body as { partyId: string }[];
  assert.ok(mine.some((p) => p.partyId === "pty_david_stewart"), JSON.stringify(mine));
  const ds = await driver.call("portal", "usr_bh_rights", "GET", "/parties/pty_david_stewart/statements?from=2026-01-01T00:00:00.000Z&to=2026-05-02T00:00:00.000Z");
  assert.equal(ds.status, 200);
  // 다른 테넌트(참여 기관 신탁단체 관리자)는 작가 명세를 볼 수 없다.
  const other = await driver.call("partner", "usr_cmo_admin", "GET", "/parties/pty_david_stewart/statements?from=2026-01-01T00:00:00.000Z&to=2026-05-02T00:00:00.000Z");
  assert.ok([403, 404].includes(other.status), String(other.status));
  // 작가 지분은 작가가 전자서명한 권리 확인서로 확정됐다(플랫폼 대조 없음, WD2·WD3).
  assert.deepEqual((await db.pool.query("SELECT DISTINCT status FROM confirmation_request WHERE record_id IN ('c_work_ds','c_work_ja')")).rows.map((x) => x.status), ["SUPERSEDED"]);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM confirmation_request WHERE status = 'PLATFORM_VERIFIED'")).rows[0].n, 0);
  // 격리: 다른 멤버의 명세는 볼 수 없고, 멤버는 운영·포털 채널에 들어갈 수 없다.
  assert.equal((await driver.call("portal", "usr_member_jungkook", "GET", "/my/parties")).status, 403);
  assert.equal((await driver.call("ops", "usr_bh_rights", "GET", "/batches")).status, 403);
});

// 총괄 한 사람(2026-10-26, Butter 막힌 곳 9 · 결정 RD1·RD6): 시드가 usr_admin(플랫폼 + 빅히트 RIGHTS_ALL)을 만들고, 직무 분리 규칙은 모두 꺼져 있다.
// 포털에서 usr_admin은 빅히트 소속으로 들어오고 권리 편집·계약 서명·정책 편집·승인·활성화·당사자 등록·지급 정보를 한 계정으로 한다.
test("the seed provisions one super admin (usr_admin) who holds every rights-tenant duty; separation of duties is off", async () => {
  const me = (await driver.call("portal", "usr_admin", "GET", "/me")).body as { userId: string; tenantId: string; roles: string[]; permissions: string[] };
  assert.equal(me.tenantId, "tnt_bighit");
  assert.deepEqual(me.roles, ["RIGHTS_ALL"]);
  for (const p of ["rights.edit", "contract.draft", "contract.sign_org", "policy.edit", "policy.approve", "policy.activate", "payout.profile_own", "account.manage"]) {
    assert.ok(me.permissions.includes(p), `usr_admin lacks ${p}`);
  }
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM sod_rule WHERE enabled")).rows[0].n, 0);
});

// 당사자 등록·지급 정보(2026-10-26, Butter 막힌 곳 5·6, 시안 Ops-Org-Parties): 포털에서 빅히트 관리 당사자로 등록(국가·구분·연락 이메일)하고,
// 당사자 표는 쓰인 곳과 지급 정보 유무(없으면 '지급 정보 없음')를 함께 읽는다.
test("the portal registers a BigHit-managed party with country class and contact email; the parties table shows usage and payout status", async () => {
  const post = await driver.call("portal", "usr_admin", "POST", "/parties", { partyId: "pty_jenna_andrews", partyType: "AUTHOR", displayName: "Jenna Andrews", countryClass: "FOREIGN_INDIVIDUAL", contactEmail: "jenna@example.com" });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.ok((await driver.call("portal", "usr_admin", "POST", "/parties", { partyId: "pty_bad_mail", partyType: "AUTHOR", displayName: "x", contactEmail: "not-an-email" })).status >= 400);
  type Mine = { partyId: string; countryClass: string | null; contactEmail: string | null; hasPayoutProfile: boolean; uses: { title: string; edge: string; shareBps: number }[]; mandates: number };
  const mine = async () => (await driver.call("portal", "usr_admin", "GET", "/my/parties")).body as Mine[];
  const j = (await mine()).find((p) => p.partyId === "pty_jenna_andrews")!;
  assert.deepEqual([j.countryClass, j.contactEmail, j.hasPayoutProfile, j.uses, j.mandates], ["FOREIGN_INDIVIDUAL", "jenna@example.com", false, [], 0]);
  assert.equal((await db.pool.query("SELECT tenant_id FROM party WHERE party_id = 'pty_jenna_andrews'")).rows[0].tenant_id, "tnt_bighit");
  // 기존 당사자: 작가는 Dynamite 작가 지분, 소속사는 멤버 7 수령 위임
  const all = await mine();
  assert.deepEqual(all.find((p) => p.partyId === "pty_david_stewart")!.uses.map((u) => [u.title, u.edge]), [["Dynamite", "WRITTEN_BY"]]);
  assert.equal(all.find((p) => p.partyId === "pty_bighit_agency")!.mandates, 7);
  const put = await driver.call("portal", "usr_admin", "PUT", "/parties/pty_jenna_andrews/payout-profile", { taxType: "FOREIGN", payoutAccountRef: "Chase ****1234", kycVerified: true });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await mine()).find((p) => p.partyId === "pty_jenna_andrews")!.hasPayoutProfile, true);
});
