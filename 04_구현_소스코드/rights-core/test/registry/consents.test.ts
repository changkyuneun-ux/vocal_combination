import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { processOutbox } from "../../src/platform/outbox.ts";
import { buildServer } from "../../src/http/server.ts";
import { OUTBOX_HANDLERS } from "../../src/issuance/service.ts";
import { decideGrant, loadGrantRules } from "../../src/engine-bridge/grant.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";

// 이용허락 동의(0018_consent.sql, 다음 작업 2): 실연 동의는 본인이 서명·철회하고, 엔진 GrantRule로 그대로 판정된다.
const w = await settlementWorld();
const clock = fixedClock("2026-02-10T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });

await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  for (const m of ["a", "b"]) {
    await createUser(tx, c0, { userId: `usr_perf_${m}`, displayName: m, roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: `pty_member_${m}` });
  }
});
await issueCombo(w, "vc_1"); // 멤버 a가 슬롯 1, b가 슬롯 2를 부른 조합

const call = (method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url} as ${actor}: ${r.body}`);
  return r.json();
};
const fanOnly = { actions: ["PREVIEW", "COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] };
const consent = (id: string, party: string, asset: string, extra: object = {}) => ({
  consentId: id, factsScopeId: SCOPE, partyId: party, rightType: "PERFORMER", assetId: asset, scope: fanOnly,
  validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z", ...extra,
});

test("a performer signs a consent for its own voice; the row is the engine's grant rule", async () => {
  const c = await json("POST", "/consents", "usr_perf_a", 201, consent("cst_a", "pty_member_a", "vo_a"));
  assert.equal(c.status, "SIGNED");
  assert.equal(c.signedBy, "usr_perf_a");
  assert.deepEqual(c.scope, fanOnly);
});

test("signing is self-only for performer consents, and the asset must be the party's voice in the scope", async () => {
  assert.equal((await json("POST", "/consents", "usr_perf_a", 403, consent("cst_x", "pty_member_b", "vo_b"))).code, "NOT_SELF");
  assert.equal((await json("POST", "/consents", "usr_perf_a", 422, consent("cst_x", "pty_member_a", "vo_b"))).code, "CONSENT_ASSET_MISMATCH");
  assert.equal((await json("POST", "/consents", "usr_rights", 422, consent("cst_x", "pty_member_b", "vo_b"))).code, "CONTRACT_REQUIRED");
  await json("POST", "/consents", "usr_rights", 201, consent("cst_b_paper", "pty_member_b", "vo_b", { sourceContractUri: "contract://paper/b" }));
  await json("POST", "/consents", "usr_perf_a", 422, consent("cst_bad", "pty_member_a", "vo_a", { validTo: "2025-01-01T00:00:00.000Z" }));
});

test("each performer sees only its own consents; the platform sees all", async () => {
  assert.deepEqual((await json("GET", "/consents", "usr_perf_a", 200)).map((c: any) => c.consentId), ["cst_a"]);
  assert.deepEqual((await json("GET", "/consents", "usr_perf_b", 200)).map((c: any) => c.consentId), ["cst_b_paper"]);
  assert.deepEqual((await json("GET", `/consents?scope=${SCOPE}`, "usr_rights", 200)).map((c: any) => c.consentId), ["cst_a", "cst_b_paper"]);
});

test("revocation: only the consenting side, once; the outbox records the issued combinations it affects", async () => {
  await json("POST", "/consents/cst_a/revoke", "usr_perf_b", 404, { reason: "x" });
  await json("POST", "/consents/cst_a/revoke", "usr_perf_a", 400, {});
  const r = await json("POST", "/consents/cst_a/revoke", "usr_perf_a", 200, { reason: "활동 중단" });
  assert.equal(r.status, "REVOKED");
  assert.equal((await json("POST", "/consents/cst_a/revoke", "usr_perf_a", 409, { reason: "again" })).code, "CONSENT_ALREADY_REVOKED");
  await processOutbox(w.db, OUTBOX_HANDLERS, clock);
  const impact = (await w.db.pool.query("SELECT after_json FROM audit_log WHERE action_name = 'CONSENT_IMPACT' AND entity_id = 'cst_a'")).rows[0].after_json;
  assert.deepEqual(impact, { partyId: "pty_member_a", snapshots: ["snp_vc_1"] });
});

test("grant rules are read as of knownAt: before the revocation the consent permits, after it the engine denies", async () => {
  const revokedAt = (await w.db.pool.query("SELECT revoked_at FROM consent_agreement WHERE consent_id = 'cst_a'")).rows[0].revoked_at.toISOString() as string;
  const before = new Date(Date.parse(revokedAt) - 1).toISOString();
  const req = [{ id: "r_a", asset: "vo_a", right_type: "PERFORMER", scope: { ...fanOnly, actions: ["COMBINE"], period: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-02T00:00:00.000Z" } } }];
  const decide = async (knownAt: string) => {
    const grants = await w.db.tx((tx) => loadGrantRules(tx, SCOPE, knownAt));
    return decideGrant({ requirements: req, grants, as_of: "2026-03-01T00:00:00.000Z", known_at: knownAt });
  };
  assert.equal((await decide(before)).result, "PERMIT");
  const after_ = await decide(revokedAt);
  assert.equal(after_.result, "DENY");
  assert.ok(after_.reason_codes.includes("GRANT_REVOKED"), JSON.stringify(after_));
});

test("the table is append-only except a single revocation", async () => {
  await assert.rejects(w.db.pool.query("UPDATE consent_agreement SET media = '{PUBLIC}' WHERE consent_id = 'cst_b_paper'"), /append-only|permission denied/);
  await assert.rejects(w.db.pool.query("DELETE FROM consent_agreement WHERE consent_id = 'cst_b_paper'"), /append-only|permission denied/);
});
