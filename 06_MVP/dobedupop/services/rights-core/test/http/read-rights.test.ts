import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fixedClock, type Clock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { viaChannel } from "./channel-app.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";
import { PACK, POLICY_TEXT, SCOPE } from "../fixtures.ts";

const w = await settlementWorld();
const clock: Clock = fixedClock("2026-03-10T00:00:00.000Z", 1);
const app = viaChannel(buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() }));
after(async () => { await app.close(); await w.drop(); });

const get = (url: string, actor: string | null = "usr_rights") =>
  app.inject({ method: "GET", url, headers: actor === null ? {} : { "x-actor": actor } });
const ok = async (url: string, actor: string = "usr_rights"): Promise<any> => {
  const r = await get(url, actor);
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  return r.json();
};

await issueCombo(w, "vc_1");
await issueCombo(w, "vc_2", "b", "a");
// vc_2의 격리: 정산 모듈 없이 테이블에 직접 넣는다(조회가 SQL로 읽는지만 본다).
const snap2 = (await w.db.pool.query("SELECT snapshot_id FROM rights_snapshot WHERE vc_id = 'vc_2'")).rows[0].snapshot_id as string;
await w.db.pool.query("INSERT INTO quarantine (snapshot_id, reason, diagnostics, created_at) VALUES ($1,'TEST','[]'::jsonb,$2)", [snap2, "2026-03-05T00:00:00.000Z"]);

test("401 without x-actor on every read; 404 NOT_FOUND on unknown ids", async () => {
  for (const u of ["/me", "/users", "/audit", "/parties", "/works", "/scopes/x", "/scopes/x/facts", "/disputes", "/policies", "/policies/p/versions", "/policies/p/versions/1", "/packs", "/packs/x", "/issues"]) {
    assert.equal((await get(u, null)).statusCode, 401, u);
  }
  for (const u of ["/scopes/nope", "/scopes/nope/facts", "/policies/nope/versions", "/policies/pol_nova/versions/99", "/packs/nope"]) {
    const r = await get(u);
    assert.equal(r.statusCode, 404, u);
    assert.equal(r.json().code, "NOT_FOUND");
  }
  assert.equal((await get("/policies/pol_nova/versions/abc")).statusCode, 400);
});

test("/me and /users", async () => {
  const seededName = (await w.db.pool.query("SELECT display_name FROM user_account WHERE user_id = 'usr_issuer'")).rows[0].display_name as string;
  const me = await ok("/me", "usr_issuer");
  assert.deepEqual(me, {
    userId: "usr_issuer", displayName: seededName, roles: ["ISSUER"], tenantId: "tnt_platform", tenantType: "PLATFORM_OPS", orgClass: "PLATFORM", tenantStatus: "ACTIVE", scope: "platform",
    memberships: [{ tenantId: "tnt_platform", name: me.memberships[0].name, tenantType: "PLATFORM_OPS", orgClass: "PLATFORM", status: "ACTIVE", home: true, roles: ["ISSUER"] }],
  });
  const users = await ok("/users");
  const byId = new Map<string, any>(users.items.map((u: any) => [u.userId, u]));
  assert.deepEqual(byId.get("usr_ops").roles, ["SPACE_OPS"]);
  assert.deepEqual(byId.get("sys_settler").roles, ["SYSTEM"]);
  // 온보딩 화면용 필드(소속·로그인 준비 상태). 비밀번호·토큰 값은 없다.
  assert.deepEqual(Object.keys(byId.get("usr_ops")).sort(), ["disabled", "displayName", "hasPassword", "homeMembership", "identityVerified", "lastLoginAt", "memberships", "partyId", "roles", "tenantId", "tenantName", "totpEnabled", "userId"]);
  assert.deepEqual(users.items.map((u: any) => u.userId), [...byId.keys()].sort());
  assert.equal(users.next, null);
});

test("/audit: role gate, fields, filters, DESC order", async () => {
  assert.equal((await get("/audit", "usr_issuer")).statusCode, 403);
  assert.equal((await get("/audit", "usr_issuer").then((r) => r.json())).code, "ROLE_REQUIRED");
  const all = await ok("/audit?limit=200", "usr_ops");
  assert.ok(all.items.length > 0);
  assert.deepEqual(Object.keys(all.items[0]).sort(), ["action", "actor", "after", "auditId", "entityId", "entityType", "occurredAt"]);
  const ids = all.items.map((a: any) => a.auditId);
  assert.deepEqual(ids, [...ids].sort((a: number, b: number) => b - a));
  const pol = await ok("/audit?entityType=policy_version&entityId=pol_nova@1", "usr_settle");
  assert.ok(pol.items.length >= 3);
  assert.ok(pol.items.every((a: any) => a.entityId === "pol_nova@1"));
  const byEditor = await ok("/audit?actor=usr_editor", "usr_rights");
  assert.ok(byEditor.items.length > 0 && byEditor.items.every((a: any) => a.actor === "usr_editor"));
  const p1 = await ok("/audit?limit=2", "usr_ops");
  const p2 = await ok(`/audit?limit=2&after=${p1.next}`, "usr_ops");
  assert.ok(p2.items[0].auditId < p1.items[1].auditId);
});

test("/parties (paging, type filter), /works", async () => {
  const seen: string[] = [];
  let next: string | null = null;
  const sizes: number[] = [];
  do {
    const r: any = await ok(`/parties?limit=3${next === null ? "" : `&after=${next}`}`);
    sizes.push(r.items.length); seen.push(...r.items.map((p: any) => p.partyId)); next = r.next;
  } while (next !== null);
  const everything = (await ok("/parties?limit=200")).items;
  assert.deepEqual(seen, everything.map((p: any) => p.partyId));
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(sizes[sizes.length - 1], seen.length % 3 || 3);
  assert.deepEqual(Object.keys(everything[0]).sort(), ["createdAt", "displayName", "ipiNo", "isni", "partyId", "partyType", "tenantId"]);
  const labels = await ok("/parties?type=LABEL");
  assert.ok(labels.items.length > 0 && labels.items.every((p: any) => p.partyType === "LABEL"));
  const works = await ok("/works");
  assert.equal(works.items.length, 1);
  assert.deepEqual(Object.keys(works.items[0]).sort(), ["createdAt", "iswc", "title", "workId"]);
});

test("/scopes/:id, /scopes/:id/facts", async () => {
  const s = await ok(`/scopes/${SCOPE}`);
  assert.deepEqual(Object.keys(s).sort(), ["createdAt", "factsScopeId", "lastVersion", "latestFactsSeal", "sealedThrough", "workId"]);
  assert.match(s.latestFactsSeal.digest, /^mdrl:sha256:[0-9a-f]{64}$/);
  assert.equal(s.latestFactsSeal.knownAt, s.sealedThrough);
  const pv = await ok("/policies/pol_nova/versions/1");
  assert.equal(s.latestFactsSeal.digest, pv.factsDigest);
  const f = await ok(`/scopes/${SCOPE}/facts`);
  assert.deepEqual(Object.keys(f).sort(), ["claims", "disputes", "mandates", "recordings", "slots", "stems", "voices"]);
  assert.ok(f.recordings.length > 0 && f.slots.length > 0 && f.stems.length > 0 && f.claims.length > 0);
  const ids = f.stems.map((x: any) => x.stemId);
  assert.deepEqual(ids, [...ids].sort());
  assert.ok(f.claims[0].factsScopeId === SCOPE && "supersededAt" in f.claims[0]);
});

test("/disputes: filters and shape (open one via registry)", async () => {
  assert.deepEqual((await ok("/disputes")).items, []);
  const claim = (await ok(`/scopes/${SCOPE}/facts`)).claims[0];
  const open = await app.inject({ method: "POST", url: "/disputes", headers: { "x-actor": "usr_rights" }, payload: {
    disputeId: "dsp_1", targetType: "RIGHT_CLAIM", targetId: claim.claimId, factsScopeId: SCOPE, reason: "test",
  } });
  assert.equal(open.statusCode, 201, open.body);
  const all = await ok("/disputes");
  assert.equal(all.items.length, 1);
  assert.deepEqual(Object.keys(all.items[0]).sort(), ["closedAt", "disputeId", "disputeReason", "factsScopeId", "openedAt", "status", "targetId", "targetType"]);
  assert.equal((await ok("/disputes?status=OPEN")).items.length, 1);
  assert.equal((await ok("/disputes?status=CLOSED")).items.length, 0);
  assert.equal((await ok(`/disputes?scope=${SCOPE}`)).items.length, 1);
  assert.equal((await ok("/disputes?scope=other")).items.length, 0);
  const closed = await app.inject({ method: "POST", url: "/disputes/dsp_1/close", headers: { "x-actor": "usr_rights" }, payload: {} });
  assert.equal(closed.statusCode, 200, closed.body);
});

test("/policies, versions, version detail", async () => {
  const list = await ok(`/policies?pack=${PACK}`);
  assert.deepEqual(list.items, [{ policyId: "pol_nova", packId: PACK, latestVersion: 1, activeVersion: 1 }]);
  assert.deepEqual((await ok("/policies?pack=other")).items, []);
  const vs = await ok("/policies/pol_nova/versions");
  assert.equal(vs.items.length, 1);
  const v = vs.items[0];
  assert.equal("sourceText" in v, false);
  assert.equal(v.status, "ACTIVE");
  assert.equal(v.approved, true);
  assert.equal(v.approvedBy, "usr_approver");
  assert.deepEqual(Object.keys(v).sort(), ["activatedAt", "approved", "approvedBy", "createdAt", "createdBy", "factsDigest", "factsKnownAt", "packId", "policyDigest", "policyId", "rebindOfVersion", "status", "version"]);
  const d = await ok("/policies/pol_nova/versions/1");
  assert.equal(typeof d.sourceText, "string");
  assert.deepEqual(d.approvals.map((a: any) => [a.userId, a.role]).sort(), [["usr_activator", "ACTIVATOR"], ["usr_approver", "WORK_APPROVER"], ["usr_editor", "EDITOR"]]);
  assert.match(d.approvals[0].at, /Z$/);
});

test("/packs, /packs/:id", async () => {
  const list = await ok("/packs");
  assert.equal(list.items.length, 1);
  assert.deepEqual(Object.keys(list.items[0]).sort(), ["createdAt", "factsScopeId", "packCode", "packId", "status", "title"]);
  const p = await ok(`/packs/${PACK}`);
  assert.equal(p.status, "ACTIVE");
  assert.deepEqual(p.activePolicy, { policyId: "pol_nova", version: 1 });
  assert.ok(p.claimants.length > 0);
  assert.deepEqual(Object.keys(p.claimants[0]).sort(), ["claimantRole", "partyId"]);
});

test("/issues: fields, filters, quarantined, DESC paging", async () => {
  const all = await ok("/issues");
  assert.equal(all.items.length, 2);
  const [a] = all.items;
  assert.deepEqual(Object.keys(a).sort(), ["asOf", "createdAt", "factsDigest", "knownAt", "membersDigest", "packId", "policyDigest", "policyId", "policyVersion", "projectionDigest", "quarantined", "snapshotId", "vcId"]);
  const byVc = new Map<string, any>(all.items.map((i: any) => [i.vcId, i]));
  assert.equal(byVc.get("vc_1").quarantined, false);
  assert.equal(byVc.get("vc_2").quarantined, true);
  assert.match(byVc.get("vc_1").projectionDigest, /^mdrl:sha256:/);
  assert.equal((await ok("/issues?vc=vc_1")).items.length, 1);
  assert.equal((await ok(`/issues?pack=${PACK}`)).items.length, 2);
  assert.equal((await ok("/issues?pack=other")).items.length, 0);
  const p1 = await ok("/issues?limit=1");
  assert.ok(p1.next);
  const p2 = await ok(`/issues?limit=1&after=${p1.next}`);
  assert.equal(p2.next, null);
  assert.notEqual(p1.items[0].snapshotId, p2.items[0].snapshotId);
});

test("limit/after validation over HTTP", async () => {
  for (const l of ["0", "201", "abc"]) {
    const r = await get(`/parties?limit=${l}`);
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "BAD_REQUEST");
  }
  const bad = await get("/parties?after=%21%21");
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "BAD_CURSOR");
  const wrongShape = await get(`/issues?after=${Buffer.from('["x"]').toString("base64url")}`);
  assert.equal(wrongShape.json().code, "BAD_CURSOR");
});

test("/policies?pack= filters by any version in the pack but aggregates over all versions", async () => {
  const mk = await app.inject({ method: "POST", url: "/packs", headers: { "x-actor": "usr_rights" }, payload: { packId: "pak_b", packCode: "NOVAB", title: "Nova B", factsScopeId: SCOPE } });
  assert.equal(mk.statusCode, 201, mk.body);
  const c = await app.inject({ method: "POST", url: "/policies/pol_nova/compile", headers: { "x-actor": "usr_editor" }, payload: { packId: "pak_b", sourceText: POLICY_TEXT.replace(PACK, "pak_b") } });
  assert.equal(c.statusCode, 201, c.body);
  for (const pack of [PACK, "pak_b"]) {
    const r = await ok(`/policies?pack=${pack}`);
    assert.deepEqual(r.items, [{ policyId: "pol_nova", packId: "pak_b", latestVersion: 2, activeVersion: 1 }], pack);
  }
  assert.deepEqual((await ok("/policies?pack=pak_none")).items, []);
});
