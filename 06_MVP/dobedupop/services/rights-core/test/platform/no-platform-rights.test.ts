import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { createFsDocumentStore } from "../../src/documents/store.ts";
import { devSignatureProvider } from "../../src/contracts/esign.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";

// 플랫폼은 권리자·권리를 만들거나 확정하지 않는다(결정 WD1~WD3, 2026-10-23): 플랫폼 운영 계정에는 권리 주장·동의·위임을 VERIFIED로 만들거나
// 다른 당사자를 대신 확정하는 길이 없다. 운영 역할 전부(총괄 포함)로 그 길을 하나씩 두드려 본다.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-nopr-"));
const app = buildServer({ db: w.db, ctx: w.ctx, clock: fixedClock("2026-04-01T00:00:00.000Z", 1000), jobs: recordingJobs(),
  documents: createFsDocumentStore(dir, Buffer.alloc(32, 9)), esign: devSignatureProvider });
after(async () => { await app.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
const OPERATORS = [["usr_ops", "SPACE_OPS"], ["usr_onb", "ONBOARDING"], ["usr_settle", "SPACE_SETTLE"], ["usr_law", "LEGAL"], ["usr_comp", "COMPLIANCE"], ["usr_all", "PLATFORM_ALL"]] as const;
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  for (const [u, role] of OPERATORS) if (u !== "usr_ops" && u !== "usr_settle") await createUser(tx, c0, { userId: u, displayName: u, roles: [role] });
});
const post = (actor: string, url: string, payload: object = {}) => app.inject({ method: "POST", url: `/ops${url}`, headers: { "x-actor": actor }, payload });
const T0 = "2026-01-01T00:00:00.000Z";

// 확인 대기 하나(레거시 시험 곡 편집 계정이 ASSERTED로 기록 → 상대 확인 요청).
const asserted = await post("usr_rights", "/claims", { claimId: "c_new_lyrics", factsScopeId: SCOPE, sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, status: "ASSERTED", validFrom: T0 });
assert.equal(asserted.statusCode, 201, asserted.body);
const requestId = (await w.db.pool.query("SELECT request_id FROM confirmation_request WHERE record_id = 'c_new_lyrics' AND status = 'OPEN'")).rows[0].request_id as number;

test("no platform role holds a rights-decision permission (DB role mapping)", async () => {
  const rows = (await w.db.pool.query(
    `SELECT rp.role_id, rp.perm_id FROM role_permission rp JOIN role r ON r.role_id = rp.role_id
      WHERE (r.org_class = 'PLATFORM' OR r.role_id IN ('SPACE_OPS','SPACE_SETTLE','ONBOARDING','LEGAL','COMPLIANCE'))
        AND rp.perm_id IN ('rights.edit','consent.record','contract.draft','contract.sign_org','performer.self','link.decide')`)).rows;
  assert.deepEqual(rows, []);
  const gone = (await w.db.pool.query("SELECT perm_id FROM permission WHERE perm_id IN ('confirmation.platform_verify','link.decide_platform')")).rows;
  assert.deepEqual(gone, [], "the platform verification and platform-side link permissions are removed");
});

test("the platform-verification routes are gone (WD3)", async () => {
  for (const [u] of OPERATORS) {
    assert.equal((await post(u, `/confirmations/${requestId}/platform-verify`, { reason: "원문 대조" })).statusCode, 404, u);
    assert.equal((await post(u, "/contracts/ctr_any/platform-verify", { partyId: "pty_author_b", reason: "x" })).statusCode, 404, u);
  }
});

test("operators cannot record rights, consents or mandates, nor confirm, sign or draft for a party", async () => {
  for (const [u] of OPERATORS) {
    const tries = [
      await post(u, "/claims", { claimId: `c_op_${u}`, factsScopeId: SCOPE, sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 10000, status: "VERIFIED", validFrom: T0 }),
      await post(u, "/mandates", { mandateId: `m_op_${u}`, factsScopeId: SCOPE, fromPartyId: "pty_member_b", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000, status: "VERIFIED", validFrom: T0 }),
      await post(u, "/consents", { consentId: `cst_op_${u}`, factsScopeId: SCOPE, partyId: "pty_author_c", rightType: "WORK", assetId: "wrk_nova",
        scope: { actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] }, validFrom: T0, validTo: "2027-01-01T00:00:00.000Z", sourceContractUri: "contract://paper" }),
      await post(u, `/scopes/${SCOPE}/contract-consents`, { scope: { actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] }, validFrom: T0, validTo: "2027-01-01T00:00:00.000Z", contractUri: "contract://paper" }),
      await post(u, `/confirmations/${requestId}/confirm`),
      await post(u, "/contracts", { contractId: `ctr_op_${u}`, templateId: "tpl_work_license", factsScopeId: SCOPE,
        answers: { licensor: "pty_author_b", actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"], validFrom: "2026-02-01", validTo: "2027-02-01" } }),
      await post(u, "/parties", { partyId: `pty_op_${u}`, partyType: "AUTHOR", displayName: "위탁 작가" }),
    ];
    assert.deepEqual(tries.map((r) => r.statusCode), [403, 403, 403, 403, 403, 403, 403], `${u}: ${tries.map((r) => r.body).join(" | ")}`);
  }
  const still = (await w.db.pool.query("SELECT status FROM confirmation_request WHERE request_id = $1", [requestId])).rows[0].status;
  assert.equal(still, "OPEN");
});
