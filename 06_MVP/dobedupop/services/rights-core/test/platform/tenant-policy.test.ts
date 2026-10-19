import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { createUser, ensureSystemIdentities } from "../../src/platform/actor.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { devIdentityProvider } from "../../src/performer/identity.ts";
import { assertOwnerTenantActive } from "../../src/platform/tenants.ts";
import { withSystemScope } from "../../src/platform/actor.ts";

// 테넌트 정책(00_프로젝트_개요/테넌트_관리_기준과_정책_20261019.md, 결정 TD1~TD9): 참여 구분, 수명주기, 역할 범위, 조직 관리자, 다중 소속, 당사자 기준.
const { db, drop } = await freshDb();
let now = "2026-03-01T00:00:00.000Z";
const clock = { now: () => now };
const app = buildServer({ db, ctx: createBridgeCtx(createFsBlobStore("/tmp/rc-tenant-policy-blobs")), clock, jobs: recordingJobs(), identity: devIdentityProvider, dev: {} as never });
after(async () => { await app.close(); await drop(); });
await db.tx(async (tx) => {
  await ensureSystemIdentities(tx, clock);
  await createUser(tx, clock, { userId: "usr_ops", displayName: "ops", roles: ["SPACE_OPS"] });
  await createUser(tx, clock, { userId: "usr_onb", displayName: "onboarding", roles: ["ONBOARDING"] });
  await createUser(tx, clock, { userId: "usr_comp", displayName: "compliance", roles: ["COMPLIANCE"] });
});

type Method = "GET" | "POST" | "PUT";
const call = (ch: string, actor: string, method: Method, url: string, payload?: object, tenant?: string) =>
  app.inject({ method, url: `/${ch}${url}`, headers: { "x-actor": actor, "x-dbp-csrf": "1", ...(tenant && { "x-tenant": tenant }) }, ...(payload && { payload }) });
const ok = async (ch: string, actor: string, method: Method, url: string, payload?: object, status = [200, 201], tenant?: string): Promise<any> => {
  const r = await call(ch, actor, method, url, payload, tenant);
  assert.ok(status.includes(r.statusCode), `${ch} ${method} ${url} as ${actor}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const code = async (ch: string, actor: string, method: Method, url: string, payload?: object, tenant?: string) => (await call(ch, actor, method, url, payload, tenant)).json().code;
const onboard = async (tenantId: string, tenantType: string, extra: object = {}) => {
  await ok("ops", "usr_onb", "POST", "/tenants", { tenantId, tenantType, name: tenantId, ...extra });
  const t = await ok("ops", "usr_onb", "GET", `/tenants/${tenantId}`);
  for (const item of t.required.ACTIVE) await ok("ops", "usr_onb", "PUT", `/tenants/${tenantId}/checks/${item}`, { checked: true });
  await ok("ops", "usr_onb", "POST", `/tenants/${tenantId}/status`, { status: "VERIFIED" });
  await ok("ops", "usr_onb", "POST", `/tenants/${tenantId}/status`, { status: "ACTIVE" });
};

test("participant classes: the tenant list splits rights tenants from participants; CMOs use the participant channel, not the portal", async () => {
  await onboard("tnt_lbl", "LABEL", { businessNo: "111-11-11111", country: "KR", representative: "대표" });
  await onboard("tnt_cmo", "CMO", { businessNo: "222-22-22222" });
  await onboard("tnt_dist", "B2B_PARTNER");
  const cls = async (c: string) => (await ok("ops", "usr_ops", "GET", `/tenants?class=${c}`)).map((t: any) => t.tenantId).sort();
  assert.deepEqual(await cls("RIGHTS"), ["tnt_lbl"]);
  assert.deepEqual(await cls("PARTICIPANT"), ["tnt_cmo", "tnt_dist"]);
  assert.deepEqual(await cls("PLATFORM"), ["tnt_platform"]);
  await ok("ops", "usr_onb", "POST", "/users", { userId: "usr_cmo_admin", displayName: "cmo", tenantId: "tnt_cmo", roles: ["TENANT_ADMIN"] });
  assert.equal(await code("portal", "usr_cmo_admin", "GET", "/me"), "CHANNEL_FORBIDDEN", "a CMO does not register rights");
  assert.equal((await ok("partner", "usr_cmo_admin", "GET", "/me")).orgClass, "PARTICIPANT");
  // 참여 기관에는 권리 역할이 없다.
  assert.equal(await code("partner", "usr_cmo_admin", "POST", "/users", { userId: "usr_cmo_x", displayName: "x", roles: ["RIGHTS_EDITOR"] }), "ROLE_NOT_ASSIGNABLE");
  assert.equal((await ok("partner", "usr_cmo_admin", "POST", "/users", { userId: "usr_cmo_trust", displayName: "신탁 담당", roles: ["TRUST_OFFICER"] })).login, "PASSWORD");
});

test("lifecycle: applied tenants only let their administrator read; checks gate verified and active; suspension stops sales and sessions", async () => {
  await ok("ops", "usr_onb", "POST", "/tenants", { tenantId: "tnt_new", tenantType: "AGENCY", name: "새 기획사" });
  await ok("ops", "usr_onb", "POST", "/users", { userId: "usr_new_admin", displayName: "admin", tenantId: "tnt_new", roles: ["TENANT_ADMIN"] });
  // 신청: 관리자는 열람만 한다(담당자 초대도 확인 뒤).
  assert.equal((await ok("portal", "usr_new_admin", "GET", "/me")).readOnly, true);
  assert.equal(await code("portal", "usr_new_admin", "POST", "/users", { userId: "usr_new_staff", displayName: "s", roles: ["RIGHTS_EDITOR"] }), "TENANT_INACTIVE");
  assert.equal((await ok("portal", "usr_new_admin", "GET", "/tenants/tnt_new")).status, "APPLIED", "the tenant sees its own checklist");
  // 확인 항목이 없으면 올라가지 않는다. 신청에서 바로 활성으로도 못 간다.
  const r = await call("ops", "usr_onb", "POST", "/tenants/tnt_new/status", { status: "VERIFIED" });
  assert.equal(r.json().code, "CHECKS_MISSING");
  assert.deepEqual(r.json().diagnostics.map((d: any) => d.path).sort(), ["BUSINESS_ID", "PLATFORM_AGREEMENT", "REPRESENTATIVE"]);
  assert.equal(await code("ops", "usr_onb", "POST", "/tenants/tnt_new/status", { status: "ACTIVE" }), "INVALID_TRANSITION");
  for (const item of ["BUSINESS_ID", "REPRESENTATIVE", "PLATFORM_AGREEMENT"]) await ok("ops", "usr_onb", "PUT", `/tenants/tnt_new/checks/${item}`, { checked: true });
  await ok("ops", "usr_onb", "POST", "/tenants/tnt_new/status", { status: "VERIFIED" });
  // 확인됨: 등록은 되지만 팩·정책 활성화와 판매는 활성 테넌트만.
  await ok("portal", "usr_new_admin", "POST", "/users", { userId: "usr_new_staff", displayName: "s", roles: ["RIGHTS_EDITOR"] });
  await ok("portal", "usr_new_staff", "POST", "/works", { workId: "wrk_new", title: "new" });
  await ok("portal", "usr_new_staff", "POST", "/scopes", { factsScopeId: "fsc_new", workId: "wrk_new" });
  await assert.rejects(db.tx((tx) => withSystemScope(tx, () => assertOwnerTenantActive(tx, "fsc_new", "activate"))), /TENANT_NOT_ACTIVE|ACTIVE tenant/);
  await ok("ops", "usr_onb", "PUT", "/tenants/tnt_new/checks/RIGHTS_EVIDENCE", { checked: true });
  await ok("ops", "usr_onb", "POST", "/tenants/tnt_new/status", { status: "ACTIVE" });
  await db.tx((tx) => withSystemScope(tx, () => assertOwnerTenantActive(tx, "fsc_new", "issue")));
  // 정지: 온보딩 담당은 못 하고(컴플라이언스·운영), 사유가 있어야 한다. 정지되면 담당자는 못 들어오고 판매가 멈춘다.
  assert.equal(await code("ops", "usr_onb", "POST", "/tenants/tnt_new/status", { status: "SUSPENDED", reason: "x" }), "ROLE_REQUIRED");
  assert.equal(await code("ops", "usr_comp", "POST", "/tenants/tnt_new/status", { status: "SUSPENDED" }), "REASON_REQUIRED");
  await ok("ops", "usr_comp", "POST", "/tenants/tnt_new/status", { status: "SUSPENDED", reason: "계약 위반 조사" });
  assert.equal(await code("portal", "usr_new_staff", "GET", "/me"), "TENANT_INACTIVE");
  assert.equal((await ok("portal", "usr_new_admin", "GET", "/me")).readOnly, true);
  await assert.rejects(db.tx((tx) => withSystemScope(tx, () => assertOwnerTenantActive(tx, "fsc_new", "issue"))), /not on sale/);
  // 재개는 확인 항목을 다시 묻지 않는다. 해지하면 아무도 못 들어온다.
  await ok("ops", "usr_comp", "POST", "/tenants/tnt_new/status", { status: "ACTIVE", reason: "조사 종료" });
  await ok("ops", "usr_ops", "POST", "/tenants/tnt_new/status", { status: "TERMINATED", reason: "계약 종료" });
  assert.equal(await code("portal", "usr_new_admin", "GET", "/me"), "TENANT_INACTIVE");
  assert.equal(await code("ops", "usr_ops", "POST", "/tenants/tnt_new/status", { status: "ACTIVE", reason: "x" }), "INVALID_TRANSITION");
});

test("roles: operators get no rights-decision roles; the first administrator is issued by ops, the rest by the administrator", async () => {
  assert.equal(await code("ops", "usr_ops", "POST", "/users", { userId: "usr_ops_editor", displayName: "x", tenantId: "tnt_platform", roles: ["EDITOR"] }), "ROLE_NOT_ASSIGNABLE");
  assert.equal(await code("ops", "usr_onb", "POST", "/users", { userId: "usr_ops_x", displayName: "x", tenantId: "tnt_platform", roles: ["SPACE_SETTLE"] }), "ROLE_REQUIRED", "only SPACE_OPS manages platform staff");
  await ok("ops", "usr_onb", "POST", "/users", { userId: "usr_lbl_admin", displayName: "label admin", tenantId: "tnt_lbl", roles: ["TENANT_ADMIN"] });
  assert.equal(await code("ops", "usr_onb", "POST", "/users", { userId: "usr_lbl_x", displayName: "x", tenantId: "tnt_lbl", roles: ["TENANT_ADMIN"] }), "TENANT_HAS_ADMIN");
  await ok("portal", "usr_lbl_admin", "POST", "/users", { userId: "usr_lbl_rights", displayName: "권리 편집", roles: ["RIGHTS_EDITOR"] });
  assert.equal(await code("portal", "usr_lbl_admin", "POST", "/users", { userId: "usr_lbl_y", displayName: "y", roles: ["SPACE_OPS"] }), "ROLE_NOT_ASSIGNABLE");
  assert.equal(await code("portal", "usr_lbl_admin", "POST", "/users", { userId: "usr_lbl_z", displayName: "z", tenantId: "tnt_cmo", roles: ["TRUST_OFFICER"] }), "TENANT_FORBIDDEN");
  assert.equal(await code("portal", "usr_lbl_admin", "PUT", "/users/usr_lbl_admin/roles", { roles: [] }), "SAME_PERSON");
  assert.deepEqual((await ok("portal", "usr_lbl_admin", "PUT", "/users/usr_lbl_rights/roles", { roles: ["RIGHTS_EDITOR", "EDITOR"] })).roles, ["EDITOR", "RIGHTS_EDITOR"]);
  assert.deepEqual((await ok("portal", "usr_lbl_admin", "GET", "/users")).items.map((u: any) => u.userId), ["usr_lbl_admin", "usr_lbl_rights"]);
  // 운영은 관리자가 있는 조직 계정의 역할을 바꾸지 않는다.
  assert.equal(await code("ops", "usr_ops", "PUT", "/users/usr_lbl_rights/roles", { roles: [] }), "TENANT_HAS_ADMIN");
  // 온보딩 담당은 당사자를 등록하지만 권리 데이터(곡)는 등록하지 않는다.
  await ok("ops", "usr_onb", "POST", "/parties", { partyId: "pty_foreign_author", partyType: "AUTHOR", displayName: "해외 작가" });
  assert.equal(await code("ops", "usr_onb", "POST", "/works", { workId: "wrk_ops", title: "x" }), "ROLE_REQUIRED");
  // 조직 관리자는 자기 조직 계정만 잠근다.
  await ok("portal", "usr_lbl_admin", "PUT", "/users/usr_lbl_rights/disabled", { disabled: true });
  assert.equal(await code("portal", "usr_lbl_admin", "PUT", "/users/usr_cmo_trust/disabled", { disabled: true }), "TENANT_FORBIDDEN");
});

test("one account, several affiliations: a performer who is also a one-person tenant switches affiliation; the audit log records it", async () => {
  await db.tx(async (tx) => {
    await tx.query("INSERT INTO party (party_id, party_type, display_name, created_at, tenant_id) VALUES ('pty_rm', 'MEMBER', 'RM', $1, 'tnt_platform_default')", [now]);
  });
  await ok("ops", "usr_ops", "POST", "/users", { userId: "usr_rm", displayName: "RM", tenantId: "tnt_platform_default", roles: ["PERFORMER"], partyId: "pty_rm" });
  await onboard("tnt_rm", "INDEPENDENT_ARTIST");
  // 1인 테넌트: 운영이 첫 관리자에게 권리 역할을 함께 준다(관리자는 자기 역할을 못 바꾼다).
  await ok("ops", "usr_onb", "POST", "/users/usr_rm/memberships", { tenantId: "tnt_rm", roles: ["TENANT_ADMIN", "RIGHTS_EDITOR"] });
  await ok("portal", "usr_rm", "POST", "/users/usr_rm/memberships", { roles: ["RIGHTS_EDITOR"] }, [409]);
  // 실연자 앱은 본인(개인) 소속, 포털은 독립 아티스트 테넌트로 들어온다.
  assert.equal((await ok("performer", "usr_rm", "GET", "/me")).tenantId, "tnt_platform_default");
  const me = await ok("portal", "usr_rm", "GET", "/me");
  assert.equal(me.tenantId, "tnt_rm");
  assert.equal(me.partyId, undefined, "portal /me reports the affiliation; the person's own party stays with the account");
  assert.deepEqual(me.memberships.map((m: any) => [m.tenantId, m.home, m.roles]), [["tnt_platform_default", true, ["PERFORMER"]], ["tnt_rm", false, ["RIGHTS_EDITOR", "TENANT_ADMIN"]]]);
  assert.equal(await code("portal", "usr_rm", "PUT", "/users/usr_rm/roles", { roles: ["TENANT_ADMIN"] }), "SAME_PERSON");
  await ok("portal", "usr_rm", "POST", "/works", { workId: "wrk_rm", title: "RM 솔로" });
  // 세션의 소속 전환: 로그인한 소속 → 다른 소속. 들어올 수 없는 소속으로는 바꾸지 못한다.
  const login = await app.inject({ method: "POST", url: "/portal/auth/dev-login", headers: { "x-dbp-csrf": "1" }, payload: { userId: "usr_rm" } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  assert.equal((await app.inject({ method: "GET", url: "/portal/me", headers: { cookie } })).json().tenantId, "tnt_rm");
  const sw = await app.inject({ method: "POST", url: "/portal/auth/switch", headers: { cookie, "x-dbp-csrf": "1" }, payload: { tenantId: "tnt_platform_default" } });
  assert.equal(sw.json().code, "CHANNEL_FORBIDDEN", "the individual affiliation does not enter the portal");
  const audit = (await db.pool.query("SELECT acting_tenant_id FROM audit_log WHERE action_name = 'MEMBERSHIP_ADD' AND entity_id = 'usr_rm'")).rows;
  assert.deepEqual(audit.map((r) => r.acting_tenant_id), ["tnt_platform"]);
});

test("parties per tenant (TD2): another legal entity needs a management contract; a distribution partner has no party; holders must match", async () => {
  await ok("portal", "usr_lbl_admin", "PUT", "/users/usr_lbl_rights/disabled", { disabled: false });
  await ok("portal", "usr_lbl_rights", "POST", "/parties", { partyId: "pty_lbl", partyType: "LABEL", displayName: "레이블" });
  assert.equal((await db.pool.query("SELECT legal_id FROM party WHERE party_id = 'pty_lbl'")).rows[0].legal_id, "111-11-11111", "same entity by default");
  assert.equal(await code("portal", "usr_lbl_rights", "POST", "/parties", { partyId: "pty_other", partyType: "PUBLISHER", displayName: "다른 출판사", legalId: "999-99-99999" }), "PARTY_OTHER_ENTITY");
  await ok("portal", "usr_lbl_rights", "POST", "/parties", { partyId: "pty_sub", partyType: "PUBLISHER", displayName: "계열 출판사", legalId: "999-99-99999", managementDocumentId: "doc_mgmt" });
  assert.equal(await code("ops", "usr_onb", "POST", "/parties", { partyId: "pty_dist", partyType: "LABEL", displayName: "x", tenantId: "tnt_dist" }), "PARTY_NOT_ALLOWED");
  await ok("ops", "usr_onb", "POST", "/parties", { partyId: "pty_cmo", partyType: "CMO", displayName: "신탁단체", tenantId: "tnt_cmo" });
  assert.equal(await code("ops", "usr_onb", "POST", "/parties", { partyId: "pty_cmo2", partyType: "CMO", displayName: "x", tenantId: "tnt_cmo" }), "PARTY_NOT_ALLOWED");
  now = "2026-03-02T00:00:00.000Z";
});
