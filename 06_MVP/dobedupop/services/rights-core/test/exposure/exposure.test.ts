import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { processOutbox } from "../../src/platform/outbox.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { OUTBOX_HANDLERS } from "../../src/issuance/service.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";

// 동의 철회 후 노출 중지(다음 작업 17): 철회된 자산을 쓴 발행 조합은 재생 기록·마스터 다운로드가 멈추고, 다시 동의하면 풀린다.
const w = await settlementWorld();
const clock = fixedClock("2026-03-10T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await registerParty(tx, c0, { partyId: "pty_fan_x", partyType: "FAN", displayName: "fan x", tenantId: "tnt_platform_default" });
  await createUser(tx, c0, { userId: "usr_fan_x", displayName: "fan x", roles: [], tenantId: "tnt_platform_default", partyId: "pty_fan_x" });
});

const call = (method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const mix = (a: string, b: string) => [{ slotId: "slt_1", stemId: `stm_${a}1` }, { slotId: "slt_2", stemId: `stm_${b}2` }, { slotId: "slt_mr", stemId: "stm_mr" }];
let seq = 0;
const play = (vcId: string) => call("POST", "/fan/plays", "usr_fan_x", { playId: `ply_x_${++seq}`, vcId, durationMs: 60_000 });
const drainOutbox = () => processOutbox(w.db, OUTBOX_HANDLERS, clock);
const consentOf = async (asset: string) => (await w.db.pool.query("SELECT consent_id, party_id FROM consent_agreement WHERE asset_id = $1 AND revoked_at IS NULL ORDER BY consent_id LIMIT 1", [asset])).rows[0];

await json("POST", "/fan/combinations", "usr_fan_x", 201, { packId: "pak_nova", vcId: "vc_x_ab", assignments: mix("a", "b") });
await json("POST", "/fan/combinations", "usr_fan_x", 201, { packId: "pak_nova", vcId: "vc_x_ba", assignments: mix("b", "a") });

test("before any revocation every combination is exposed", async () => {
  assert.equal((await play("vc_x_ab")).statusCode, 201);
  assert.deepEqual((await json("GET", "/fan/combinations", "usr_fan_x", 200)).map((c: any) => [c.vcId, c.exposure]).sort(), [["vc_x_ab", "OPEN"], ["vc_x_ba", "OPEN"]]);
});

let revokedB = "";
test("revoking member b's performer consent stops exposure of every combination b sings in", async () => {
  const c = await consentOf("vo_b");
  revokedB = c.consent_id;
  await json("POST", `/ops/consents/${revokedB}/revoke`, "usr_ops", 200, { reason: "member b withdraws" });
  await drainOutbox();
  const holds = await json("GET", "/ops/exposure-holds", "usr_ops", 200);
  assert.deepEqual(holds.map((h: any) => [h.vcId, h.rightType, h.assetId]).sort(), [["vc_x_ab", "PERFORMER", "vo_b"], ["vc_x_ba", "PERFORMER", "vo_b"]]);
  const r = await play("vc_x_ab");
  assert.equal(r.statusCode, 410);
  assert.equal(r.json().code, "EXPOSURE_STOPPED");
  assert.deepEqual((await json("GET", "/fan/combinations", "usr_fan_x", 200)).map((x: any) => x.exposure), ["STOPPED", "STOPPED"]);
  // 재처리해도 보류는 하나씩만(멱등)
  await drainOutbox();
  assert.equal((await json("GET", "/ops/exposure-holds", "usr_ops", 200)).length, 2);
});

test("⑧ and the impact analysis show the stopped combinations", async () => {
  const sig = await json("GET", "/ops/pipeline/signals", "usr_ops", 200);
  const dispute = Object.fromEntries(sig.stages.find((s: any) => s.stage === "dispute").signals.map((s: any) => [s.key, s.value]));
  assert.equal(dispute["exposure-stopped"], 2);
  const impact = await json("GET", `/ops/impact?consent=${revokedB}`, "usr_ops", 200);
  assert.deepEqual(impact.exposure.stopped, ["vc_x_ab", "vc_x_ba"]);
});

test("re-consenting by the same party releases its holds and exposure resumes", async () => {
  await json("POST", "/ops/consents", "usr_rights", 201, {
    consentId: "cst_b_again", factsScopeId: SCOPE, partyId: "pty_member_b", rightType: "PERFORMER", assetId: "vo_b",
    scope: { actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] },
    validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z", sourceContractUri: "contract://renewed",
  });
  assert.deepEqual(await json("GET", "/ops/exposure-holds", "usr_ops", 200), []);
  const all = await json("GET", "/ops/exposure-holds?all=1", "usr_ops", 200);
  assert.ok(all.every((h: any) => h.releaseReason === "RECONSENT" && h.releasedBy === "usr_rights"));
  assert.equal((await play("vc_x_ab")).statusCode, 201);
  assert.deepEqual((await json("GET", "/fan/combinations", "usr_fan_x", 200)).map((x: any) => x.exposure), ["OPEN", "OPEN"]);
});

test("a work consent revocation stops every combination of the song", async () => {
  const c = await consentOf("wrk_nova");
  assert.ok(c, "work consent exists");
  await json("POST", `/ops/consents/${c.consent_id}/revoke`, "usr_ops", 200, { reason: "author withdraws" });
  await drainOutbox();
  const holds = await json("GET", "/ops/exposure-holds", "usr_ops", 200);
  assert.deepEqual(holds.map((h: any) => [h.vcId, h.rightType]).sort(), [["vc_x_ab", "WORK"], ["vc_x_ba", "WORK"]]);
});
