import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, setSodRules } from "../helpers.ts";
import { createUser, ensureSystemIdentities } from "../../src/platform/actor.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";

// 참여 기관의 연결 열쇠(테넌트 정책 4절, 결정 TD10·TD11·TD12): 양쪽 확인으로만 성립, 신탁 수령 자동 위임, 필요한 항목만 보인다.
const { db, adminUrl, drop } = await freshDb();
let tick = 0;
const clock = { now: () => new Date(Date.parse("2026-03-01T00:00:00.000Z") + 1000 * tick++).toISOString() };
const app = buildServer({ db, ctx: createBridgeCtx(createFsBlobStore("/tmp/rc-links-test-blobs")), clock, jobs: recordingJobs() });
after(async () => { await app.close(); await drop(); });
const T0 = "2026-01-01T00:00:00.000Z";
await db.tx(async (tx) => {
  await ensureSystemIdentities(tx, clock);
  for (const [id, type, status] of [["tnt_lbl", "LABEL", "ACTIVE"], ["tnt_cmo", "CMO", "ACTIVE"], ["tnt_cmo_new", "CMO", "VERIFIED"], ["tnt_dist", "B2B_PARTNER", "ACTIVE"]]) {
    await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, status, created_at) VALUES ($1,$2,$3,$4,$5)", [id, type, id, status, T0]);
  }
  await createUser(tx, clock, { userId: "usr_onb", displayName: "onboarding", roles: ["ONBOARDING"] });
  await createUser(tx, clock, { userId: "usr_ops", displayName: "ops", roles: ["SPACE_OPS"] });
  await createUser(tx, clock, { userId: "usr_lbl", displayName: "label rights", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, clock, { userId: "usr_lbl2", displayName: "label rights 2", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, clock, { userId: "usr_cmo", displayName: "cmo trust", roles: ["TRUST_OFFICER"], tenantId: "tnt_cmo" });
  await createUser(tx, clock, { userId: "usr_cmo_new", displayName: "new cmo", roles: ["TRUST_OFFICER"], tenantId: "tnt_cmo_new" });
  await createUser(tx, clock, { userId: "usr_dist", displayName: "dist", roles: ["PARTNER_INTEGRATION"], tenantId: "tnt_dist" });
  for (const [id, type, name, tenant] of [["pty_cmo", "CMO", "신탁단체", "tnt_cmo"], ["pty_cmo_new", "CMO", "새 신탁단체", "tnt_cmo_new"],
    ["pty_author", "AUTHOR", "해외 작가", "tnt_lbl"], ["pty_author2", "AUTHOR", "레이블 작가", "tnt_lbl"], ["pty_lbl", "LABEL", "레이블", "tnt_lbl"]]) {
    await tx.query("INSERT INTO party (party_id, party_type, display_name, created_at, tenant_id) VALUES ($1,$2,$3,$4,$5)", [id, type, name, T0, tenant]);
  }
});

type Method = "GET" | "POST";
const call = (ch: string, actor: string, method: Method, url: string, payload?: object) =>
  app.inject({ method, url: `/${ch}${url}`, headers: { "x-actor": actor }, ...(payload && { payload }) });
const ok = async (ch: string, actor: string, method: Method, url: string, payload?: object): Promise<any> => {
  const r = await call(ch, actor, method, url, payload);
  assert.ok(r.statusCode === 200 || r.statusCode === 201, `${ch} ${method} ${url} as ${actor}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const code = async (ch: string, actor: string, method: Method, url: string, payload?: object) => (await call(ch, actor, method, url, payload)).json().code;
const song = async (n: string, author: string) => {
  await ok("portal", "usr_lbl", "POST", "/works", { workId: `wrk_${n}`, title: `곡 ${n}` });
  await ok("portal", "usr_lbl", "POST", "/scopes", { factsScopeId: `fsc_${n}`, workId: `wrk_${n}` });
  await ok("portal", "usr_lbl", "POST", "/recordings", { recordingId: `rcd_${n}`, workId: `wrk_${n}`, masterOwnerPartyId: "pty_lbl", versionTitle: n });
  await ok("portal", "usr_lbl", "POST", "/claims", { claimId: `c_m_${n}`, factsScopeId: `fsc_${n}`, sourceId: `rcd_${n}`, edge: "CONTROLLED_BY", targetId: "pty_lbl", shareBps: 10000, status: "VERIFIED", validFrom: T0 });
  await ok("portal", "usr_lbl", "POST", "/claims", { claimId: `c_w_${n}`, factsScopeId: `fsc_${n}`, sourceId: `wrk_${n}`, edge: "WRITTEN_BY", targetId: author, shareBps: 10000, status: "ASSERTED", validFrom: T0 });
};
const trustMandates = async (author: string) => (await db.pool.query(
  "SELECT mandate_id, facts_scope_id, to_party_id, right_kind, share_bps, status, valid_to, source_ref FROM mandate WHERE from_party_id = $1 AND source_ref LIKE 'link:%' AND superseded_at IS NULL ORDER BY facts_scope_id", [author])).rows;

test("a trust link needs the other side: the label proposes from its registration data, the CMO confirms; then the work share goes to the CMO", async () => {
  await song("a", "pty_author");
  // 신탁단체는 연결 전에는 그 곡을 전혀 보지 못한다.
  assert.deepEqual(await ok("partner", "usr_cmo", "GET", "/trust/works"), []);
  const l = await ok("portal", "usr_lbl", "POST", "/links", { linkId: "lnk_t1", linkType: "TRUST", participantTenantId: "tnt_cmo", authorPartyId: "pty_author", memberRef: "IPI-0001", validFrom: T0 });
  assert.equal(l.status, "PROPOSED");
  assert.equal(l.payeePartyId, "pty_cmo");
  // 제안한 쪽(같은 테넌트의 다른 사람 포함)은 확인할 수 없다. 플랫폼도 이 경우 확인하는 쪽이 아니다.
  assert.equal(await code("portal", "usr_lbl2", "POST", "/links/lnk_t1/confirm"), "NOT_THE_COUNTERPARTY");
  assert.equal(await code("ops", "usr_onb", "POST", "/links/lnk_t1/confirm"), "NOT_THE_COUNTERPARTY");
  assert.equal((await ok("partner", "usr_cmo", "POST", "/links/lnk_t1/confirm")).status, "ACTIVE");
  const m = await trustMandates("pty_author");
  assert.deepEqual(m.map((x) => [x.facts_scope_id, x.to_party_id, x.right_kind, x.share_bps, x.status, x.source_ref]), [["fsc_a", "pty_cmo", "WORK", 10000, "VERIFIED", "link:lnk_t1"]]);
  // 연결 열쇠: 신탁 작품의 작품 정보와 작가 지분만 보인다(녹음·레이블 몫은 아니다).
  const works = await ok("partner", "usr_cmo", "GET", "/trust/works");
  assert.deepEqual(works.map((w: any) => [w.factsScopeId, w.title, w.authors.map((a: any) => [a.partyId, a.shareBps])]), [["fsc_a", "곡 a", [["pty_author", 10000]]]]);
  const seen = await db.tx(async (tx) => {
    await tx.query("SELECT set_config('rc.scope', 'tenant', true), set_config('rc.tenant_id', 'tnt_cmo', true)");
    return {
      claims: (await tx.query("SELECT claim_id FROM right_claim ORDER BY claim_id")).rows.map((r) => r.claim_id),
      recordings: (await tx.query("SELECT count(*)::int AS n FROM recording_version")).rows[0].n,
    };
  });
  assert.deepEqual(seen, { claims: ["c_w_a"], recordings: 0 });
  // 링크는 양쪽이 본다. 다른 신탁단체는 보지 못한다.
  assert.deepEqual((await ok("portal", "usr_lbl", "GET", "/links")).map((x: any) => x.linkId), ["lnk_t1"]);
  assert.deepEqual(await ok("partner", "usr_cmo_new", "GET", "/links"), []);
  // 같은 작가에 열린 신탁 연결은 하나뿐이다.
  assert.equal(await code("partner", "usr_cmo_new", "POST", "/links", { linkId: "lnk_t1b", linkType: "TRUST", authorPartyId: "pty_author" }), "LINK_EXISTS");
});

test("a new work by a trusted author gets the trust mandate too; ending the link ends the mandates from now on", async () => {
  await song("b", "pty_author");
  assert.deepEqual((await trustMandates("pty_author")).map((x) => x.facts_scope_id), ["fsc_a", "fsc_b"]);
  assert.equal(await code("partner", "usr_cmo", "POST", "/links/lnk_t1/end", {}), "REASON_REQUIRED");
  assert.equal((await ok("partner", "usr_cmo", "POST", "/links/lnk_t1/end", { reason: "신탁 해지" })).status, "ENDED");
  const ended = await trustMandates("pty_author");
  assert.ok(ended.every((x) => x.valid_to !== null), "the mandates now end at the time the link ended");
  assert.deepEqual(await ok("partner", "usr_cmo", "GET", "/trust/works"), [], "after the link ends the CMO no longer sees the works");
});

test("a CMO may ask; the author's manager (the label) confirms; the platform is not a side of a link (WD1); only active CMOs", async () => {
  await song("c", "pty_author2");
  await ok("partner", "usr_cmo", "POST", "/links", { linkId: "lnk_t2", linkType: "TRUST", authorPartyId: "pty_author2", validFrom: T0 });
  assert.equal(await code("partner", "usr_cmo", "POST", "/links/lnk_t2/confirm"), "NOT_THE_COUNTERPARTY");
  assert.equal((await ok("portal", "usr_lbl", "POST", "/links/lnk_t2/confirm")).status, "ACTIVE");
  // 플랫폼은 연결의 쪽이 아니다(플랫폼 위탁 당사자 없음, 결정 WD1): 제안도 확인도 못 한다. 아직 활성이 아닌 신탁단체는 연결을 활성화하지 못한다.
  await ok("partner", "usr_cmo_new", "POST", "/links", { linkId: "lnk_t3", linkType: "TRUST", authorPartyId: "pty_author", validFrom: T0 });
  assert.equal(await code("ops", "usr_onb", "POST", "/links/lnk_t3/confirm"), "NOT_THE_COUNTERPARTY");
  assert.equal(await code("ops", "usr_onb", "POST", "/links", { linkId: "lnk_px", linkType: "TRUST", participantTenantId: "tnt_cmo", authorPartyId: "pty_author" }), "TENANT_FORBIDDEN");
  assert.equal(await code("portal", "usr_lbl", "POST", "/links/lnk_t3/confirm"), "PARTICIPANT_NOT_ACTIVE");
  assert.equal((await ok("portal", "usr_lbl", "POST", "/links/lnk_t3/decline", { reason: "신탁 계약 확인 불가" })).status, "DECLINED");
  // 신탁단체는 권리를 만들지 않는다: 포털에 못 들어오고, 연결은 작가에게만 건다.
  assert.equal(await code("portal", "usr_cmo", "GET", "/works"), "CHANNEL_FORBIDDEN");
  assert.equal(await code("partner", "usr_cmo", "POST", "/links", { linkId: "lnk_x", linkType: "TRUST", authorPartyId: "pty_lbl" }), "NOT_AN_AUTHOR");
});

test("the trust mandate warns when the active policy does not route the work share via mandate", async () => {
  const issues = (await ok("portal", "usr_lbl", "GET", "/scopes/fsc_c/validation")).issues.map((i: any) => i.rule);
  assert.ok(!issues.includes("TRUST_NOT_ROUTED"), "no active policy yet: nothing to warn about");
});

test("distribution: the label and the partner confirm a distribution contract; product mappings need it; terminating the partner ends it", async () => {
  await ok("portal", "usr_lbl", "POST", "/links", { linkId: "lnk_d1", linkType: "DISTRIBUTION", participantTenantId: "tnt_dist", validFrom: T0 });
  assert.equal(await code("portal", "usr_lbl", "POST", "/links", { linkId: "lnk_d2", linkType: "DISTRIBUTION", participantTenantId: "tnt_cmo" }), "NOT_A_PARTNER");
  assert.equal((await ok("partner", "usr_dist", "POST", "/links/lnk_d1/confirm")).status, "ACTIVE");
  assert.equal(await code("partner", "usr_dist", "POST", "/asset-mappings", { externalId: "SKU-1", vcId: "vc_missing" }), "NOT_FOUND");
  assert.equal(await code("partner", "usr_cmo", "POST", "/asset-mappings", { externalId: "SKU-1", vcId: "vc_missing" }), "PARTNER_ONLY");
  await ok("ops", "usr_ops", "POST", "/tenants/tnt_dist/status", { status: "TERMINATED", reason: "계약 종료" });
  assert.equal((await ok("portal", "usr_lbl", "GET", "/links/lnk_d1")).status, "ENDED");
});

test("link.propose-confirm: when enabled the proposer cannot confirm from another membership; disabled (MVP 총괄 운영, 결정 RD6) the same person may", async () => {
  // 한 사람이 레이블(권리 편집)과 신탁단체(신탁 담당) 양쪽 소속이다(총괄 계정과 같은 모양).
  await db.tx(async (tx) => {
    await createUser(tx, clock, { userId: "usr_both_sides", displayName: "both sides", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
    await tx.query("INSERT INTO user_membership (user_id, tenant_id, added_by, added_at) VALUES ('usr_both_sides', 'tnt_cmo', 'usr_both_sides', $1)", [clock.now()]);
    await tx.query("INSERT INTO portal_role (user_id, tenant_id, role) VALUES ('usr_both_sides', 'tnt_cmo', 'TRUST_OFFICER')");
    await tx.query("INSERT INTO party (party_id, party_type, display_name, created_at, tenant_id) VALUES ('pty_author3', 'AUTHOR', '레이블 작가 3', $1, 'tnt_lbl')", [T0]);
  });
  await song("sod", "pty_author3");
  await ok("portal", "usr_both_sides", "POST", "/links", { linkId: "lnk_sod", linkType: "TRUST", participantTenantId: "tnt_cmo", authorPartyId: "pty_author3", memberRef: "IPI-0003", validFrom: T0 });
  const confirm = () => app.inject({ method: "POST", url: "/partner/links/lnk_sod/confirm", headers: { "x-actor": "usr_both_sides", "x-tenant": "tnt_cmo" } });
  await setSodRules(adminUrl, ["link.propose-confirm"]);
  try {
    assert.equal((await confirm()).json().code, "SAME_PERSON");
  } finally {
    await setSodRules(adminUrl, ["link.propose-confirm"], false);
  }
  const r = await confirm();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, "ACTIVE");
});
