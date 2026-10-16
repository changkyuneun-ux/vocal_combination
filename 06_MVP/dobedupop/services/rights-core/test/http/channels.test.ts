import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../src/platform/actor.ts";
import { markIdentityVerified } from "../../src/performer/identity.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";

// API 채널(다음 작업 5): 채널마다 들어올 수 있는 신원이 다르다. ops = 플랫폼, portal = 권리자 테넌트·플랫폼,
// performer = PERFORMER 본인, fan = 팬 파티, partner = B2B 파트너 테넌트.
const w = await settlementWorld();
const clock = fixedClock("2026-02-10T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });

await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_lbl','LABEL','label',$1), ('tnt_partner','B2B_PARTNER','partner',$1)", ["2026-01-01T00:00:00.000Z"]);
  await registerParty(tx, c0, { partyId: "pty_fan_1", partyType: "FAN", displayName: "fan", tenantId: "tnt_platform_default" });
  await createUser(tx, c0, { userId: "usr_label", displayName: "label", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_perf_a", displayName: "a", roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: "pty_member_a" });
  await markIdentityVerified(tx, c0, "usr_perf_a", "TEST");
  await createUser(tx, c0, { userId: "usr_fan", displayName: "fan", roles: [], tenantId: "tnt_platform_default", partyId: "pty_fan_1" });
  await createUser(tx, c0, { userId: "usr_partner", displayName: "partner", roles: [], tenantId: "tnt_partner" });
});

const call = (method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url} as ${actor}: ${r.body}`);
  return r.json();
};

test("each channel admits only its identities (403 CHANNEL_FORBIDDEN otherwise)", async () => {
  const users = ["usr_ops", "usr_label", "usr_perf_a", "usr_fan", "usr_partner"];
  const admits: Record<string, string[]> = {
    ops: ["usr_ops"], portal: ["usr_ops", "usr_label"], performer: ["usr_perf_a"], fan: ["usr_fan"], partner: ["usr_partner"],
  };
  for (const [ch, ok] of Object.entries(admits)) {
    for (const u of users) {
      const r = await call("GET", `/${ch}/me`, u);
      assert.equal(r.statusCode, ok.includes(u) ? 200 : 403, `/${ch}/me as ${u}: ${r.body}`);
      if (!ok.includes(u)) assert.equal(r.json().code, "CHANNEL_FORBIDDEN");
    }
  }
});

test("the same handler on two channels: settlement reads are ops-only, registry reads are on ops and portal", async () => {
  await json("GET", "/ops/ledger/trial-balance", "usr_settle", 200);
  await json("GET", "/portal/ledger/trial-balance", "usr_settle", 404);
  await json("GET", "/portal/works", "usr_label", 200);
  await json("GET", "/ops/works", "usr_label", 403);
});

test("fan app: the catalog shows active packs, and a combination issues on the fan's behalf with slot-proportional member shares", async () => {
  const packs = await json("GET", "/fan/packs", "usr_fan", 200);
  assert.deepEqual(packs.map((p: any) => p.packId), ["pak_nova"]);
  assert.deepEqual(packs[0].slots.map((s: any) => s.slotId), ["slt_1", "slt_2", "slt_mr"]);
  const seal = await json("POST", "/fan/combinations", "usr_fan", 201, {
    packId: "pak_nova", vcId: "vc_fan_1", assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_2", stemId: "stm_b2" }, { slotId: "slt_mr", stemId: "stm_mr" }],
  });
  assert.equal(seal.snapshotId, "snp_vc_fan_1");
  const pct = (await w.db.pool.query("SELECT party_id, pct_bps FROM snapshot_member_pct WHERE snapshot_id = 'snp_vc_fan_1' ORDER BY party_id")).rows;
  assert.deepEqual(pct, [{ party_id: "pty_member_a", pct_bps: 5000 }, { party_id: "pty_member_b", pct_bps: 5000 }]);
  const actor = (await w.db.pool.query("SELECT actor_user_id FROM audit_log WHERE action_name = 'ISSUED' AND entity_id = 'snp_vc_fan_1'")).rows[0].actor_user_id;
  assert.equal(actor, "usr_fan");
});

test("performer app: own consents (signed as self), usages of own stems, and own statement only", async () => {
  const c = await json("POST", "/performer/consents", "usr_perf_a", 201, {
    consentId: "cst_app_a", factsScopeId: SCOPE, assetId: "vo_a", partyId: "pty_member_b",
    scope: { actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] },
    validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(c.partyId, "pty_member_a", "the party in the body is ignored: the app always signs for the caller");
  const mine = await json("GET", "/performer/consents", "usr_perf_a", 200);
  assert.ok(mine.length >= 2 && mine.every((x: any) => x.partyId === "pty_member_a"), JSON.stringify(mine));
  const usages = await json("GET", "/performer/usages", "usr_perf_a", 200);
  assert.deepEqual(usages.map((u: any) => [u.vcId, u.slotId, u.stemId]), [["vc_fan_1", "slt_1", "stm_a1"]]);
  await json("GET", "/performer/statements", "usr_perf_a", 400);
  const st = await json("GET", "/performer/statements?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z", "usr_perf_a", 200);
  assert.equal(st.partyId, "pty_member_a");
});

test("rights-holder portal: statements only for parties of the caller's tenant", async () => {
  const q = "from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z";
  await json("GET", `/portal/parties/pty_label/statements?${q}`, "usr_label", 404);
  assert.deepEqual(await json("GET", "/portal/my/parties", "usr_label", 200), []);
  await json("GET", `/portal/parties/pty_label/statements?${q}`, "usr_ops", 200);
});

test("user APIs exist only under a channel: the old root paths are gone", async () => {
  for (const u of ["/me", "/works", "/batches/x", "/consents"]) assert.equal((await call("GET", u, "usr_ops")).statusCode, 404, u);
});
