import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { processOutbox } from "../../src/platform/outbox.ts";
import { buildServer } from "../../src/http/server.ts";
import { OUTBOX_HANDLERS } from "../../src/issuance/service.ts";
import { devIdentityProvider } from "../../src/performer/identity.ts";
import { pushOutboxHandlers, recordingPushSender } from "../../src/performer/notifications.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";

// 실연자 앱 API(다음 작업 11): 본인 인증 → 동의 서명·철회, 내 보이스·사용 이력, 이의제기, 알림함과 웹 푸시.
const w = await settlementWorld();
const clock = fixedClock("2026-02-10T00:00:00.000Z", 1000);
const push = recordingPushSender();
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs(), identity: devIdentityProvider, push });
after(async () => { await app.close(); await w.drop(); });
await w.db.tx((tx) => createUser(tx, fixedClock("2026-01-01T00:00:00.000Z", 0), { userId: "usr_perf_b", displayName: "멤버 b", roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: "pty_member_b" }));

const call = (method: "GET" | "POST", url: string, payload?: object, actor = "usr_perf_b") =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, status: number, payload?: object, actor?: string): Promise<any> => {
  const r = await call(method, url, payload, actor);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const consentBody = (id: string) => ({
  consentId: id, factsScopeId: SCOPE, assetId: "vo_b", scope: { actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] },
  validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z",
});

test("identity verification comes first: an unverified performer cannot sign", async () => {
  assert.equal((await json("GET", "/performer/me", 200)).identityVerified, false);
  assert.equal((await json("POST", "/performer/consents", 403, consentBody("cst_b_app"))).code, "IDENTITY_REQUIRED");
  const start = await json("POST", "/performer/identity/start", 200, {});
  assert.match(start.devCode, /^\d{6}$/);
  const wrong = await json("POST", "/performer/identity/confirm", 200, { challengeId: start.challengeId, code: start.devCode === "000000" ? "111111" : "000000" });
  assert.deepEqual(wrong, { verified: false, attemptsLeft: 4 });
  assert.equal((await json("POST", "/performer/identity/confirm", 200, { challengeId: start.challengeId, code: start.devCode })).verified, true);
  assert.equal((await json("POST", "/performer/identity/confirm", 409, { challengeId: start.challengeId, code: start.devCode })).code, "ALREADY_VERIFIED");
  const me = await json("GET", "/performer/me", 200);
  assert.equal(me.identityVerified, true);
  assert.equal(me.identityMethod, "DEV_CODE");
});

test("my voices with their consent status; signing and revoking from the app", async () => {
  const voices = await json("GET", "/performer/voices", 200);
  assert.deepEqual(voices.map((v: any) => [v.voiceId, v.title, v.consent]), [["vo_b", "Nova", "SIGNED"]], "the contract consent counts");
  await json("POST", "/performer/consents", 201, consentBody("cst_b_app"));
  await json("POST", "/performer/consents/cst_b_app/revoke", 200, { reason: "앱에서 철회" });
  assert.equal((await json("GET", "/performer/voices", 200))[0].consent, "REVOKED");
  // 철회는 계약서 동의까지 막는다(새 조합 발행 거부). 다시 동의하면 풀린다.
  await json("POST", "/performer/consents", 201, consentBody("cst_b_app2"));
  assert.equal((await json("GET", "/performer/voices", 200))[0].consent, "SIGNED");
});

test("usage: a new combination with my stem shows up in my history and as a notification", async () => {
  const r = await call("POST", "/ops/issues", {
    packId: "pak_nova", vcId: "vc_app_1", members: { pty_member_a: 5000, pty_member_b: 5000 },
    assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_2", stemId: "stm_b2" }, { slotId: "slt_mr", stemId: "stm_mr" }],
  }, "usr_issuer");
  assert.equal(r.statusCode, 201, r.body);
  assert.deepEqual((await json("GET", "/performer/usages", 200)).map((u: any) => [u.vcId, u.slotId]), [["vc_app_1", "slt_2"]]);
});

test("objection: only on a claim that concerns me; it opens a dispute the rights holder and platform see", async () => {
  const claims = await json("GET", "/performer/claims", 200);
  assert.deepEqual(claims.map((c: any) => c.claimId), ["c_own_b", "c_perf_b1", "c_perf_b2"]);
  assert.equal((await call("POST", "/performer/objections", { claimId: "c_master", reason: "녹음 권리자가 아닙니다" })).statusCode, 404);
  assert.equal((await call("POST", "/performer/objections", { claimId: "c_perf_b2", reason: "x" })).statusCode, 400);
  const o = await json("POST", "/performer/objections", 201, { claimId: "c_perf_b2", reason: "이 스템은 제가 부른 녹음이 아닙니다" });
  const mine = await json("GET", "/performer/objections", 200);
  assert.deepEqual(mine.map((x: any) => [x.disputeId, x.claimId, x.status]), [[o.disputeId, "c_perf_b2", "OPEN"]]);
  const disputes = await json("GET", "/ops/disputes?status=OPEN", 200, undefined, "usr_rights");
  assert.ok(disputes.items.some((d: any) => d.disputeId === o.disputeId));
  const owner = (await w.db.pool.query("SELECT owner_tenant_id, opened_by FROM dispute WHERE dispute_id = $1", [o.disputeId])).rows[0];
  assert.deepEqual(owner, { owner_tenant_id: "tnt_platform", opened_by: "usr_perf_b" }, "the dispute belongs to the song's owner, opened by the performer");
});

test("notifications inbox and web push: subscribe, deliver through the outbox, mark read", async () => {
  assert.equal((await json("GET", "/performer/push/vapid-key", 200)).publicKey, "test-public-key");
  await json("POST", "/performer/push/subscriptions", 201, { endpoint: "https://push.example/sub/b", keys: { p256dh: "BPkey", auth: "authkey" } });
  await processOutbox(w.db, { ...OUTBOX_HANDLERS, ...pushOutboxHandlers(push) }, clock);
  const inbox = await json("GET", "/performer/notifications", 200);
  assert.deepEqual([...new Set(inbox.map((n: any) => n.kind))].sort(), ["CONSENT", "OBJECTION", "USAGE"]);
  assert.ok(inbox.every((n: any) => n.pushed), "everything was pushed to the one subscription");
  assert.equal(push.sent.length, inbox.length);
  assert.ok(push.sent.every((s) => s.endpoint === "https://push.example/sub/b"));
  await json("POST", `/performer/notifications/${inbox[0].notificationId}/read`, 200, {});
  assert.equal((await json("GET", "/performer/notifications", 200))[0].read, true);
  assert.deepEqual(await json("GET", "/performer/notifications", 200, undefined, "usr_rights").catch(() => "forbidden"), "forbidden", "platform users are not on the performer channel");
});
