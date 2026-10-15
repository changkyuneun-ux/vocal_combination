import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { createBatch, confirmBatch } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

// 멀티테넌시(0017_tenancy.sql): 소유 데이터는 등록한 테넌트만, 참여 데이터는 파티가 소속된 테넌트만, 플랫폼 범위는 전부.
const w = await settlementWorld();
const clock = fixedClock("2026-03-10T00:00:00.000Z", 1);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });

const call = (method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url} as ${actor}: ${r.body}`);
  return r.json();
};

// 테넌트 셋: 레이블 A·B(소유 데이터 격리), 기획사(참여 데이터). 플랫폼 SPACE_OPS가 HTTP로 등록한다.
for (const [id, type] of [["tnt_lbl_a", "LABEL"], ["tnt_lbl_b", "LABEL"], ["tnt_agency", "AGENCY"]]) {
  await json("POST", "/tenants", "usr_ops", 201, { tenantId: id, tenantType: type, name: id });
}
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await createUser(tx, c0, { userId: "usr_a", displayName: "a", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl_a" });
  await createUser(tx, c0, { userId: "usr_b", displayName: "b", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl_b" });
  await createUser(tx, c0, { userId: "usr_agency", displayName: "agency", roles: ["SPACE_SETTLE"], tenantId: "tnt_agency" });
});
// fixtures의 파티는 플랫폼 테넌트로 만들어진다. 기획사 파티만 기획사 테넌트로 옮긴다(party는 불변이라 관리자 연결에서 트리거를 끄고 바꾼다).
{
  const admin = new pg.Client({ connectionString: w.adminUrl });
  await admin.connect();
  await admin.query("SET session_replication_role = replica");
  await admin.query("UPDATE party SET tenant_id = 'tnt_agency' WHERE party_id = 'pty_agency'");
  await admin.end();
}

test("tenant registration is platform-only and /me reports the scope", async () => {
  assert.equal((await json("POST", "/tenants", "usr_a", 403, { tenantId: "tnt_x", tenantType: "LABEL", name: "x" })).code, "ROLE_REQUIRED");
  assert.deepEqual((await json("GET", "/me", "usr_a", 200)).scope, "tenant");
  assert.deepEqual((await json("GET", "/tenants", "usr_a", 200)).map((t: any) => t.tenantId), ["tnt_lbl_a"]);
  assert.ok((await json("GET", "/tenants", "usr_ops", 200)).length >= 4);
});

test("owned data: each label sees only what it registered; the platform sees everything", async () => {
  await json("POST", "/works", "usr_a", 201, { workId: "wrk_a", title: "A" });
  await json("POST", "/scopes", "usr_a", 201, { factsScopeId: "fsc_a", workId: "wrk_a" });
  await json("POST", "/works", "usr_b", 201, { workId: "wrk_b", title: "B" });
  const ids = async (actor: string) => (await json("GET", "/works?limit=200", actor, 200)).items.map((x: any) => x.workId).sort();
  assert.deepEqual(await ids("usr_a"), ["wrk_a"]);
  assert.deepEqual(await ids("usr_b"), ["wrk_b"]);
  assert.deepEqual(await ids("usr_rights"), ["wrk_a", "wrk_b", "wrk_nova"]);
  await json("GET", "/scopes/fsc_a", "usr_b", 404);
  await json("GET", "/scopes/fsc_nova", "usr_a", 404);
  await json("GET", "/scopes/fsc_a", "usr_a", 200);
});

test("writes under another tenant's rows are refused by RLS (403 TENANT_FORBIDDEN)", async () => {
  const r = await json("POST", "/recordings", "usr_b", 403, { recordingId: "rcd_b_on_a", workId: "wrk_a", masterOwnerPartyId: "pty_label", versionTitle: "x" });
  assert.equal(r.code, "TENANT_FORBIDDEN");
  await json("POST", "/scopes", "usr_b", 403, { factsScopeId: "fsc_b_on_a", workId: "wrk_a" });
  await json("POST", "/recordings", "usr_a", 201, { recordingId: "rcd_a", workId: "wrk_a", masterOwnerPartyId: "pty_label", versionTitle: "x" });
});

test("parties join the caller's tenant; only the platform registers parties for another tenant", async () => {
  await json("POST", "/parties", "usr_a", 201, { partyId: "pty_a_artist", partyType: "ARTIST", displayName: "artist" });
  const tenantOf = async (id: string) => (await w.db.pool.query("SELECT tenant_id FROM party WHERE party_id = $1", [id])).rows[0].tenant_id;
  assert.equal(await tenantOf("pty_a_artist"), "tnt_lbl_a");
  assert.equal((await json("POST", "/parties", "usr_b", 403, { partyId: "pty_x", partyType: "AUTHOR", displayName: "x", tenantId: "tnt_lbl_a" })).code, "TENANT_FORBIDDEN");
  await json("POST", "/parties", "usr_rights", 201, { partyId: "pty_b_author", partyType: "AUTHOR", displayName: "x", tenantId: "tnt_lbl_b" });
  assert.equal(await tenantOf("pty_b_author"), "tnt_lbl_b");
});

test("participation data: the agency tenant sees its own party's statement only, and no platform operations data", async () => {
  await issueCombo(w, "vc_1");
  await purchase(w, "ev_1", "vc_1", "1000000");
  const jobs = recordingJobs();
  const d = { db: w.db, ctx: w.ctx, clock, jobs };
  await createBatch(d, w.users.ops, { batchId: "bat_t", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_t");
  await jobs.drain(jobHandlers(d));

  const q = "from=2026-03-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z";
  const mine = await json("GET", `/parties/pty_agency/statements?${q}`, "usr_agency", 200);
  const platform = await json("GET", `/parties/pty_agency/statements?${q}`, "usr_settle", 200);
  assert.deepEqual(mine, platform, "the owning tenant sees the same statement as the platform");
  assert.ok(BigInt(mine.settled) > 0n, `agency has settled lines: ${JSON.stringify(mine)}`);
  await json("GET", `/parties/pty_label/statements?${q}`, "usr_agency", 404);
  await json("GET", "/batches/bat_t", "usr_agency", 404);
  const lines = await w.db.tx(async (tx) => {
    await tx.query("SELECT set_config('rc.scope', 'tenant', true), set_config('rc.tenant_id', 'tnt_agency', true)");
    return (await tx.query("SELECT DISTINCT party_id FROM allocation_line")).rows.map((r) => r.party_id);
  });
  assert.deepEqual(lines, ["pty_agency"]);
});

test("seals are served only when a row the caller can see points at them", async () => {
  const facts = (await w.db.pool.query("SELECT facts_digest FROM policy_version WHERE policy_id = 'pol_nova'")).rows[0].facts_digest as string;
  await json("GET", `/seals/${encodeURIComponent(facts)}`, "usr_a", 404);
  await json("GET", `/seals/${encodeURIComponent(facts)}`, "usr_rights", 200);
  await json("GET", "/issues/snp_vc_1/audit", "usr_a", 404);
});

test("a connection without a scope sees nothing (fail-closed)", async () => {
  const c = new pg.Client({ connectionString: (w.db.pool as any).options.connectionString });
  await c.connect();
  try {
    assert.equal((await c.query("SELECT count(*)::int AS n FROM work")).rows[0].n, 0);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM allocation_line")).rows[0].n, 0);
  } finally {
    await c.end();
  }
});
