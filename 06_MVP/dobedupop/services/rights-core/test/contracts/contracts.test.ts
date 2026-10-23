import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "../../src/platform/actor.ts";
import { markIdentityVerified } from "../../src/performer/identity.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { withSystemScope } from "../../src/platform/actor.ts";
import { buildServer } from "../../src/http/server.ts";
import { createFsDocumentStore } from "../../src/documents/store.ts";
import { devSignatureProvider } from "../../src/contracts/esign.ts";
import { providerSigned } from "../../src/contracts/service.ts";
import { viaChannel } from "../http/channel-app.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";
import { setSodRules } from "../helpers.ts";

// 최초 작성(원천 문서 설계 S4, 결정 D6·D1): 표준 계약 템플릿 → 마법사 답 → 계약서 → 전자서명(개발용 공급자) → 서명본 원천 문서 + VERIFIED 기록.
const w = await settlementWorld({ consents: false });
await setSodRules(w.adminUrl, ["contract-template.author-approve"]); // 이 파일은 직무 분리 거부를 확인한다(규칙 기본 꺼짐, 결정 RD6)
const dir = mkdtempSync(join(tmpdir(), "rc-ctr-"));
const documents = createFsDocumentStore(dir, Buffer.alloc(32, 7));
const clock = fixedClock("2026-02-10T00:00:00.000Z", 1000);
const app = viaChannel(buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs(), documents, esign: devSignatureProvider }),
  (actor) => (actor?.startsWith("usr_perf_") ? "performer" : "ops"));
after(async () => { await app.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await createUser(tx, c0, { userId: "usr_perf_a", displayName: "a", roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: "pty_member_a" });
  await markIdentityVerified(tx, c0, "usr_perf_a", "TEST");
  await createUser(tx, c0, { userId: "usr_legal", displayName: "법무 1", roles: ["LEGAL"] });
  await createUser(tx, c0, { userId: "usr_legal2", displayName: "법무 2", roles: ["LEGAL"] });
});
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await app.inject({ method, url, headers: { "x-actor": actor, "user-agent": "test-device" }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${method} ${url} as ${actor}: ${r.body}`);
  return r.json();
};
const usage = { actions: ["PREVIEW", "COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"], validFrom: "2026-02-01", validTo: "2027-02-01" };

test("five standard templates and the two rights confirmations (CT5) are approved at v1", async () => {
  const t = await json("GET", "/contract-templates", "usr_rights", 200);
  assert.deepEqual(t.map((x: any) => `${x.templateId}@${x.version} ${x.status}`).sort(), [
    "tpl_claim_confirm_author@1 APPROVED", "tpl_claim_confirm_label@1 APPROVED", "tpl_master_license@1 APPROVED", "tpl_performer_consent@1 APPROVED", "tpl_performer_mandate@1 APPROVED", "tpl_platform_contract@1 APPROVED", "tpl_work_license@1 APPROVED",
  ]);
});

test("preview fills the clauses with readable values, escapes them, and lists the records signing will create", async () => {
  const p = await json("POST", "/contracts/preview", "usr_rights", 200, { templateId: "tpl_master_license", factsScopeId: SCOPE, answers: { licensor: "pty_label", recording: "rcd_nova", ...usage } });
  assert.match(p.html, /제1조 당사자/);
  assert.match(p.html, /2026년 2월 1일/);
  assert.match(p.html, /미리듣기·조합 생성/);
  assert.deepEqual(p.signers, ["pty_label"]);
  assert.equal(p.records[0].type, "CONSENT");
  assert.equal(p.records[0].rightType, "MASTER");
  assert.equal(p.records[0].validFrom, "2026-02-01T00:00:00.000Z");
  const bad = await app.inject({ method: "POST", url: "/ops/contracts/preview", headers: { "x-actor": "usr_rights" },
    payload: { templateId: "tpl_master_license", factsScopeId: SCOPE, answers: { licensor: "pty_label", recording: "rcd_other", ...usage } } });
  assert.equal(bad.statusCode, 422, bad.body);
  const missing = await app.inject({ method: "POST", url: "/ops/contracts/preview", headers: { "x-actor": "usr_rights" },
    payload: { templateId: "tpl_master_license", factsScopeId: SCOPE, answers: { licensor: "pty_label", ...usage } } });
  assert.match(missing.json().message, /녹음\(recording\) is required/);
});

test("sending checks that the records can be made: a voice the performer does not own is refused before anyone signs", async () => {
  const r = await app.inject({ method: "POST", url: "/ops/contracts", headers: { "x-actor": "usr_rights" },
    payload: { contractId: "ctr_bad", templateId: "tpl_performer_consent", factsScopeId: SCOPE, answers: { performer: "pty_member_a", voice: "vo_b", ...usage } } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, "CONSENT_ASSET_MISMATCH");
  assert.equal((await app.inject({ method: "GET", url: "/ops/contracts/ctr_bad", headers: { "x-actor": "usr_rights" } })).statusCode, 404, "the dry run left nothing behind");
});

test("a mandate contract: both parties sign, then the drafter completes it into a signed source document and a VERIFIED mandate", async () => {
  const c = await json("POST", "/contracts", "usr_rights", 201, {
    contractId: "ctr_mandate", templateId: "tpl_performer_mandate", factsScopeId: SCOPE,
    answers: { performer: "pty_member_a", agency: "pty_label", shareBps: 3000, validFrom: "2026-02-01", validTo: "2027-02-01" },
  });
  assert.equal(c.status, "SENT");
  assert.equal(c.provider, "DEV_ESIGN");
  assert.match(c.html, /30%/);
  assert.equal((await app.inject({ method: "POST", url: "/ops/contracts/ctr_mandate/complete", headers: { "x-actor": "usr_rights" } })).statusCode, 409, "not signed yet");
  // 실연자는 실연자 앱에서 자기 몫에 서명한다(자기에게 온 계약이 보인다).
  const mine = await json("GET", "/contracts", "usr_perf_a", 200);
  assert.deepEqual(mine.map((x: any) => x.contractId), ["ctr_mandate"]);
  const s1 = await json("POST", "/contracts/ctr_mandate/sign", "usr_perf_a", 200);
  assert.equal(s1.status, "SENT");
  assert.equal((await app.inject({ method: "POST", url: "/performer/contracts/ctr_mandate/sign", headers: { "x-actor": "usr_perf_a" } })).statusCode, 403, "nothing left to sign");
  const s2 = await json("POST", "/contracts/ctr_mandate/sign", "usr_rights", 200); // 레이블 파티의 테넌트 RIGHTS_EDITOR
  assert.equal(s2.status, "SIGNED");
  const done = await json("POST", "/contracts/ctr_mandate/complete", "usr_rights", 200);
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(done.records, [{ type: "MANDATE", id: "mnd_ctr_mandate" }]);
  const doc = await json("GET", `/documents/${done.document.documentId}`, "usr_rights", 200);
  assert.equal(doc.versions[0].origin, "TEMPLATE_SIGNED");
  assert.equal(doc.versions[0].kind, "MANDATE");
  assert.deepEqual(doc.versions[0].parties, ["pty_label", "pty_member_a"]);
  const file = await app.inject({ method: "GET", url: `/ops/documents/${done.document.documentId}/versions/1/file`, headers: { "x-actor": "usr_rights" } });
  assert.match(String(file.headers["content-type"]), /text\/html/);
  assert.match(String(file.headers["content-security-policy"]), /sandbox/);
  assert.match(file.body, /서명 증명/);
  assert.match(file.body, new RegExp(c.sha256));
  const m = await w.db.tx((tx) => withSystemScope(tx, async () => (await tx.query("SELECT status, evidence_digest FROM mandate WHERE mandate_id = 'mnd_ctr_mandate'")).rows[0]));
  assert.equal(m.status, "VERIFIED");
  assert.match(m.evidence_digest, /^mdrl:sha256:/);
});

test("a party outside the platform signs at the provider; the work licence becomes a consent backed by the signed copy", async () => {
  await json("POST", "/contracts", "usr_rights", 201, { contractId: "ctr_work_b", templateId: "tpl_work_license", factsScopeId: SCOPE, answers: { licensor: "pty_author_b", ...usage } });
  await w.db.tx((tx) => withSystemScope(tx, () => providerSigned(tx, clock, devSignatureProvider, "ctr_work_b", "pty_author_b")));
  const done = await json("POST", "/contracts/ctr_work_b/complete", "usr_rights", 200);
  const consent = await json("GET", "/consents/cns_ctr_work_b", "usr_rights", 200);
  assert.equal(consent.rightType, "WORK");
  assert.deepEqual(consent.sourceDocument, done.document);
  assert.equal(done.signatures[0].method, "DEV_ESIGN");
  assert.equal(done.signatures[0].signedBy, undefined, "signed at the provider, not by a platform user");
});

test("legal staff revise a template; the author cannot approve; signed contracts stay on their version", async () => {
  const v2 = await json("POST", "/contract-templates/tpl_work_license/versions", "usr_legal", 201, { title: "작품 이용허락 표준계약(2026 개정)" });
  assert.equal(v2.version, 2);
  assert.equal(v2.status, "DRAFT");
  assert.equal((await app.inject({ method: "POST", url: "/ops/contract-templates/tpl_work_license/versions/2/approve", headers: { "x-actor": "usr_legal" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/ops/contract-templates/tpl_work_license/versions", headers: { "x-actor": "usr_rights" }, payload: {} })).statusCode, 403);
  await json("POST", "/contract-templates/tpl_work_license/versions/2/approve", "usr_legal2", 200);
  assert.equal((await json("GET", "/contract-templates/tpl_work_license", "usr_rights", 200)).version, 2);
  assert.equal((await json("GET", "/contracts/ctr_work_b", "usr_rights", 200)).templateVersion, 1);
  const r = await app.inject({ method: "POST", url: "/ops/contract-templates/tpl_work_license/versions", headers: { "x-actor": "usr_legal" },
    payload: { clauses: [{ clauseId: "x", heading: "x", clauseType: "OTHER", fields: [], text: "{{nope}}" }] } });
  assert.equal(r.statusCode, 422, "a clause may only use the template's variables");
});

test("a performer's in-app consent leaves a consent original as its source document", async () => {
  const c = await json("POST", "/consents", "usr_perf_a", 201, { consentId: "cst_app_a", factsScopeId: SCOPE, assetId: "vo_a", scope: { actions: ["PREVIEW"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] } });
  assert.deepEqual(c.sourceDocument, { documentId: "doc_cst_app_a", version: 1 });
  const file = await app.inject({ method: "GET", url: "/ops/documents/doc_cst_app_a/versions/1/file", headers: { "x-actor": "usr_rights" } });
  assert.match(file.body, /실연 이용 동의서/);
  assert.match(file.body, /플랫폼 자체 서명/);
  assert.match(file.body, /test-device/);
});

test("with contract-template.author-approve disabled the author may approve their own template version (MVP 총괄 운영, 결정 RD6)", async () => {
  await setSodRules(w.adminUrl, ["contract-template.author-approve"], false);
  try {
    const v = await json("POST", "/contract-templates/tpl_work_license/versions", "usr_legal", 201, { title: "작품 이용허락 표준계약(본인 승인 시험)" });
    await json("POST", `/contract-templates/tpl_work_license/versions/${v.version}/approve`, "usr_legal", 200);
    assert.equal((await json("GET", "/contract-templates/tpl_work_license", "usr_rights", 200)).version, v.version);
  } finally {
    await setSodRules(w.adminUrl, ["contract-template.author-approve"], true);
  }
});
