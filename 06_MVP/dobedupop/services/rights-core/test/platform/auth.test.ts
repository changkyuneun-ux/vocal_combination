import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { createUser, ensureSystemIdentities } from "../../src/platform/actor.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { devIdentityProvider } from "../../src/performer/identity.ts";
import { base32Encode, hashPassword, totp, verifyPassword, verifyTotp } from "../../src/platform/auth.ts";

// 인증·세션(MVP 진행계획 M3, 결정 MD3): 운영 비밀번호 + TOTP(필수), 포털 비밀번호, 실연자 일회용 코드. 세션은 채널에 묶이고 쿠키로만 다닌다.
const { db, drop } = await freshDb();
let now = "2026-03-01T00:00:00.000Z";
const clock = { now: () => now };
const ctx = createBridgeCtx(createFsBlobStore("/tmp/rc-auth-test-blobs"));
const deps = { db, ctx, clock, jobs: recordingJobs(), identity: devIdentityProvider };
const app = buildServer(deps);
const prod = buildServer({ ...deps, headerIdentity: false, cookieSecure: true });
after(async () => { await app.close(); await prod.close(); await drop(); });
await db.tx(async (tx) => {
  await ensureSystemIdentities(tx, clock);
  await createUser(tx, clock, { userId: "usr_ops", displayName: "ops", roles: ["SPACE_OPS"] });
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_bighit', 'LABEL', '빅히트 뮤직', $1)", [now]);
  await tx.query("INSERT INTO party (party_id, party_type, display_name, created_at, tenant_id) VALUES ('pty_jk', 'MEMBER', '정국', $1, 'tnt_platform_default')", [now]);
});
type Res = Awaited<ReturnType<typeof app.inject>>;
const post = (url: string, payload: object, headers: Record<string, string> = {}, srv = app) =>
  srv.inject({ method: "POST", url, payload, headers: { "x-dbp-csrf": "1", ...headers } });
const cookieOf = (r: Res) => String(r.headers["set-cookie"] ?? "").split(";")[0]!;
const asOps = { "x-actor": "usr_ops" };

test("TOTP matches RFC 6238 (SHA-1) and passwords are scrypt-hashed", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(totp(secret, 59_000), "287082");
  assert.equal(totp(secret, 1_111_111_109_000), "081804");
  assert.ok(verifyTotp(secret, totp(secret, 1_000_000_000_000 + 30_000), 1_000_000_000_000), "one step of clock drift is accepted");
  assert.ok(!verifyTotp(secret, "12345", 0));
  const h = hashPassword("correct horse");
  assert.match(h, /^scrypt\$15\$8\$1\$/);
  assert.ok(verifyPassword("correct horse", h));
  assert.ok(!verifyPassword("wrong horse!", h));
});

let adminCookie = "";
test("ops invites the tenant's first administrator, who invites the staff; staff sign in to the portal with a session cookie", async () => {
  // 운영은 조직의 첫 관리자만 발급한다(결정 TD4). 담당자 역할은 줄 수 없다.
  assert.equal((await post("/ops/users", { userId: "usr_bh_x", displayName: "x", tenantId: "tnt_bighit", roles: ["RIGHTS_EDITOR"] }, asOps)).json().code, "FIRST_ADMIN_ONLY");
  const adm = (await post("/ops/users", { userId: "usr_bh_admin", displayName: "빅히트 관리자", tenantId: "tnt_bighit", roles: ["TENANT_ADMIN"] }, asOps)).json();
  await post("/portal/auth/invite/accept", { token: adm.inviteToken, password: "bighit-admin-pw-1" });
  adminCookie = cookieOf(await post("/portal/auth/login", { userId: "usr_bh_admin", password: "bighit-admin-pw-1" }));
  assert.equal((await post("/ops/users", { userId: "usr_bh_x", displayName: "x", tenantId: "tnt_bighit", roles: ["TENANT_ADMIN"] }, asOps)).json().code, "TENANT_HAS_ADMIN");
  const created = await post("/portal/users", { userId: "usr_bh_rights", displayName: "빅히트 권리", roles: ["RIGHTS_EDITOR"] }, { cookie: adminCookie });
  assert.equal(created.statusCode, 201, created.body);
  const { inviteToken, login } = created.json();
  assert.equal(login, "PASSWORD");
  assert.equal((await post("/portal/auth/invite/accept", { token: inviteToken, password: "short" })).json().code, "WEAK_PASSWORD");
  assert.equal((await post("/portal/auth/invite/accept", { token: inviteToken, password: "bighit-password-1" })).statusCode, 200);
  assert.equal((await post("/portal/auth/invite/accept", { token: inviteToken, password: "bighit-password-2" })).statusCode, 410, "an invitation is used once");
  const r = await post("/portal/auth/login", { userId: "usr_bh_rights", password: "bighit-password-1" });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(r.headers["set-cookie"]), /^dbp_portal=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  assert.equal(r.json().token, undefined, "the token only travels in the cookie");
  const cookie = cookieOf(r);
  const me = await app.inject({ method: "GET", url: "/portal/me", headers: { cookie } });
  assert.equal(me.json().userId, "usr_bh_rights");
  // 상태를 바꾸는 요청은 CSRF 헤더가 있어야 한다.
  const noCsrf = await app.inject({ method: "POST", url: "/portal/works", headers: { cookie }, payload: { workId: "wrk_x", title: "X" } });
  assert.equal(noCsrf.json().code, "CSRF_REQUIRED");
  assert.equal((await post("/portal/works", { workId: "wrk_x", title: "X" }, { cookie })).statusCode, 201);
  // 세션은 채널에 묶인다: 같은 토큰을 운영 쿠키로 내도 받지 않는다. 테넌트 계정은 운영 채널에 로그인할 수 없다.
  const token = cookie.split("=")[1]!;
  assert.equal((await app.inject({ method: "GET", url: "/ops/me", headers: { cookie: `dbp_ops=${token}` } })).statusCode, 401);
  assert.equal((await post("/ops/auth/login", { userId: "usr_bh_rights", password: "bighit-password-1" })).json().code, "CHANNEL_FORBIDDEN");
  // 로그아웃하면 세션이 끝난다.
  const out = await post("/portal/auth/logout", {}, { cookie });
  assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
  assert.equal((await app.inject({ method: "GET", url: "/portal/me", headers: { cookie } })).statusCode, 401);
});

test("five wrong passwords lock the account for 15 minutes (the failures are committed)", async () => {
  await post("/portal/users", { userId: "usr_bh_policy", displayName: "빅히트 정책", roles: ["EDITOR"] }, { cookie: adminCookie }).then(async (r) =>
    post("/portal/auth/invite/accept", { token: r.json().inviteToken, password: "policy-password-1" }));
  for (let i = 0; i < 5; i++) assert.equal((await post("/portal/auth/login", { userId: "usr_bh_policy", password: "nope-nope-nope" })).statusCode, 401);
  assert.equal((await post("/portal/auth/login", { userId: "usr_bh_policy", password: "policy-password-1" })).json().code, "ACCOUNT_LOCKED");
  now = "2026-03-01T00:16:00.000Z";
  assert.equal((await post("/portal/auth/login", { userId: "usr_bh_policy", password: "policy-password-1" })).statusCode, 200);
});

test("ops requires TOTP: the first login enrols, later logins ask for the code", async () => {
  const inv = (await post("/ops/users", { userId: "usr_ops2", displayName: "운영 2", tenantId: "tnt_platform", roles: ["SPACE_OPS"] }, asOps)).json();
  await post("/ops/auth/invite/accept", { token: inv.inviteToken, password: "ops2-password-1" });
  const enrol = (await post("/ops/auth/login", { userId: "usr_ops2", password: "ops2-password-1" })).json();
  assert.equal(enrol.status, "MFA_ENROLL");
  assert.match(enrol.otpauthUrl, /^otpauth:\/\/totp\/dobedupop:usr_ops2\?secret=/);
  assert.equal((await post("/ops/auth/login", { userId: "usr_ops2", password: "ops2-password-1", totp: "000000" })).statusCode, 401);
  const ok = await post("/ops/auth/login", { userId: "usr_ops2", password: "ops2-password-1", totp: totp(enrol.secret, Date.now()) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await post("/ops/auth/login", { userId: "usr_ops2", password: "ops2-password-1" })).json().status, "MFA_REQUIRED");
  // 운영자는 자기 역할을 바꿀 수 없다. 계정을 잠그면 열린 세션도 끝난다.
  const cookie = cookieOf(ok);
  assert.equal((await app.inject({ method: "PUT", url: "/ops/users/usr_ops2/roles", headers: { cookie, "x-dbp-csrf": "1" }, payload: { roles: ["SPACE_SETTLE"] } })).json().code, "SAME_PERSON");
  await app.inject({ method: "PUT", url: "/ops/users/usr_ops2/disabled", headers: asOps, payload: { disabled: true } });
  assert.equal((await app.inject({ method: "GET", url: "/ops/me", headers: { cookie } })).statusCode, 401);
});

test("performers sign in with a one-time code from the identity provider (no password)", async () => {
  const created = (await post("/ops/users", { userId: "usr_member_jk", displayName: "정국", tenantId: "tnt_platform_default", roles: ["PERFORMER"], partyId: "pty_jk" }, asOps)).json();
  assert.equal(created.login, "OTP");
  assert.equal((await post("/performer/auth/login", { userId: "usr_member_jk", password: "x" })).json().code, "METHOD_NOT_ALLOWED");
  const ghost = (await post("/performer/auth/otp/start", { loginId: "usr_nobody" })).json();
  assert.equal(ghost.devCode, undefined, "an unknown account gets the same shape and no code");
  const ch = (await post("/performer/auth/otp/start", { loginId: "usr_member_jk" })).json();
  assert.equal((await post("/performer/auth/otp/confirm", { loginId: "usr_member_jk", challengeId: ch.challengeId, code: "000000" })).statusCode, 401);
  const ok = await post("/performer/auth/otp/confirm", { loginId: "usr_member_jk", challengeId: ch.challengeId, code: ch.devCode });
  assert.equal(ok.statusCode, 200, ok.body);
  const me = await app.inject({ method: "GET", url: "/performer/me", headers: { cookie: cookieOf(ok) } });
  assert.equal(me.json().identityVerified, true, "signing in with the code also verifies identity");
});

test("production ignores the dev identity header, sets Secure cookies and has no persona login", async () => {
  assert.equal((await prod.inject({ method: "GET", url: "/ops/me", headers: asOps })).statusCode, 401);
  assert.equal((await post("/portal/auth/dev-login", { userId: "usr_bh_rights" }, {}, prod)).statusCode, 404);
  assert.equal((await prod.inject({ method: "GET", url: "/portal/auth/config" })).json().devLogin, false);
  const r = await post("/portal/auth/login", { userId: "usr_bh_rights", password: "bighit-password-1" }, {}, prod);
  assert.match(String(r.headers["set-cookie"]), /; Secure$/);
  assert.equal((await post("/portal/auth/login", { userId: "usr_bh_rights", password: "bighit-password-1" }, { "x-dbp-csrf": "" }, prod)).json().code, "CSRF_REQUIRED");
});
