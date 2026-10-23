import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, withSystemScope } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { sealFacts } from "../../src/engine-bridge/facts.ts";
import { loadSealed } from "../../src/engine-bridge/seal-store.ts";
import { createFsDocumentStore, type DocumentStore } from "../../src/documents/store.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";

// 원천 문서 저장소(원천 문서 설계 S1): 원문 보관(암호화·불변·해시 대조), 근거 연결(주장·위임·동의 → facts 봉인의 evidence), 권리 요약, 보관 기한·폐기.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-docs-"));
const store = createFsDocumentStore(dir, Buffer.alloc(32, 9));
const clock = fixedClock("2026-03-01T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs(), documents: store });
after(async () => { await app.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  for (const t of ["tnt_lbl", "tnt_lbl2"]) await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ($1, 'LABEL', $2, $3)", [t, t, c0.now()]);
  await registerParty(tx, c0, { partyId: "pty_lbl_x", partyType: "LABEL", displayName: "레이블 X", tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_lbl", displayName: "label", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_lbl2", displayName: "label 2", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl2" });
});

const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
const upload = (actor: string, bytes: Buffer, meta: Record<string, string>, channel = "ops", type = "application/pdf") =>
  app.inject({ method: "POST", url: `/${channel}/documents?${qs(meta)}`, headers: { "x-actor": actor, "content-type": type }, payload: bytes });
const call = (method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};

const MASTER = pdf("master contract rcd_nova");
let masterDoc = "";

test("upload keeps the original encrypted, addressed by its hash; the same file again returns the same document", async () => {
  const r = await upload("usr_rights", MASTER, { kind: "MASTER_CONTRACT", title: "Nova 녹음 계약", parties: "pty_label", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2030-01-01T00:00:00.000Z" });
  assert.equal(r.statusCode, 201, r.body);
  const d = r.json();
  masterDoc = d.documentId;
  assert.equal(d.documentId, `doc_${sha(MASTER).slice(0, 16)}`);
  assert.equal(d.versions[0].sha256, sha(MASTER));
  assert.equal(d.versions[0].retentionUntil, "2040-01-01T00:00:00.000Z", "kept 10 years after the effective end");
  const again = await upload("usr_rights", MASTER, { kind: "MASTER_CONTRACT", title: "dup" });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().documentId, masterDoc);
  // 디스크에는 암호문만 있다.
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile());
  assert.equal(files.length, 1);
  assert.ok(!readFileSync(join(dir, files[0]!)).includes(Buffer.from("master contract")));
  const file = await call("GET", `/ops/documents/${masterDoc}/versions/1/file`, "usr_rights");
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["content-type"], "application/pdf");
  assert.deepEqual(file.rawPayload, MASTER);
});

test("unsupported files and unknown parties are refused", async () => {
  assert.equal((await upload("usr_rights", Buffer.from("GIF89a"), { kind: "EVIDENCE", title: "x" }, "ops", "image/gif")).json().code, "INVALID_DOCUMENT");
  assert.equal((await upload("usr_rights", pdf("x"), { kind: "EVIDENCE", title: "x", parties: "pty_nobody" })).json().code, "INVALID_DOCUMENT");
  assert.equal((await upload("usr_rights", pdf("y"), { kind: "LETTER", title: "x" })).json().code, "INVALID_DOCUMENT");
});

test("a claim recorded with evidence documents seals the document hash into facts; manual digest and documents together are refused", async () => {
  const body = { claimId: "c_master", factsScopeId: SCOPE, sourceId: "rcd_nova", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000, status: "VERIFIED", validFrom: "2026-01-01T00:00:00.000Z" };
  assert.equal((await json("POST", "/ops/claims", "usr_rights", 422, { ...body, evidenceDigest: "x", evidenceDocuments: [{ documentId: masterDoc, version: 1 }] })).code, "INVALID_EVIDENCE");
  const rec = await json("POST", "/ops/claims", "usr_rights", 201, { ...body, evidenceDocuments: [{ documentId: masterDoc, version: 1 }], linkedBy: "usr_spoof" });
  assert.equal(rec.version, 2);
  const row = (await w.db.pool.query("SELECT evidence_digest FROM right_claim WHERE claim_id = 'c_master' AND version = 2")).rows[0];
  assert.equal(row.evidence_digest, `mdrl:sha256:${sha(MASTER)}`);
  const link = (await w.db.pool.query("SELECT linked_by FROM record_evidence WHERE record_type = 'CLAIM' AND record_id = 'c_master' AND record_version = 2")).rows;
  assert.deepEqual(link.map((l) => l.linked_by), ["usr_rights"], "linkedBy is the caller, not the body");
  const doc = await json("GET", `/ops/documents/${masterDoc}`, "usr_rights", 200);
  assert.deepEqual(doc.versions[0].records, [{ type: "CLAIM", id: "c_master", version: 2 }]);
});

let agencyDoc = "";
test("mandate evidence is sealed too (decision D4), and a dispute's new version keeps the evidence link", async () => {
  const r = await upload("usr_rights", pdf("exclusive contract member a"), { kind: "MANDATE", title: "멤버 a 전속계약", parties: "pty_member_a,pty_agency" });
  agencyDoc = r.json().documentId;
  await json("POST", "/ops/mandates", "usr_rights", 201, {
    mandateId: "m_agency", factsScopeId: SCOPE, fromPartyId: "pty_member_a", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000, status: "VERIFIED",
    validFrom: "2026-01-01T00:00:00.000Z", evidenceDocuments: [{ documentId: agencyDoc, version: 1 }],
  });
  // 봉인 시각 = 지금까지의 마지막 기록 시각(그 뒤의 쓰기는 테스트 시계로 더 늦다).
  const knownAt = new Date((await w.db.pool.query("SELECT max(recorded_at) AS t FROM mandate WHERE facts_scope_id = $1", [SCOPE])).rows[0].t).toISOString();
  const facts = await w.db.tx(async (tx) => loadSealed(w.ctx, tx, (await sealFacts(w.ctx, tx, SCOPE, knownAt)).digest)) as any;
  const m = facts.body.mandates.find((x: any) => x.id.startsWith("m_agency") && x.superseded_at === undefined);
  assert.match(m.evidence, /^mdrl:sha256:[0-9a-f]{64}$/);
  const c = facts.body.claims.find((x: any) => x.id.startsWith("c_master") && x.superseded_at === undefined);
  assert.equal(c.evidence, `mdrl:sha256:${sha(MASTER)}`);
  await json("POST", "/ops/disputes", "usr_rights", 201, { disputeId: "dsp_doc", targetType: "RIGHT_CLAIM", targetId: "c_master", reason: "test" });
  const links = (await w.db.pool.query("SELECT record_version FROM record_evidence WHERE record_type = 'CLAIM' AND record_id = 'c_master' ORDER BY record_version")).rows;
  assert.deepEqual(links.map((l) => l.record_version), [2, 3], "the DISPUTED version 3 carries the link");
});

test("a consent can cite a source document instead of a contract URI", async () => {
  const r = await upload("usr_rights", pdf("work license"), { kind: "PUBLISHING", title: "Nova 퍼블리싱 계약", parties: "pty_author_b,pty_author_c" });
  const docId = r.json().documentId;
  const c = await json("POST", "/ops/consents", "usr_rights", 201, {
    consentId: "cst_doc_work", factsScopeId: SCOPE, partyId: "pty_author_c", rightType: "WORK", assetId: "wrk_nova",
    scope: { actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] },
    validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z", sourceDocument: { documentId: docId, version: 1 },
  });
  assert.equal(c.sourceContractUri, `doc:${docId}@1`);
  assert.deepEqual(c.sourceDocument, { documentId: docId, version: 1 });
});

test("a new version supersedes the file; records keep pointing at the version they cited; a rejected version cannot be cited", async () => {
  const r = await app.inject({ method: "POST", url: `/ops/documents/${masterDoc}/versions`, headers: { "x-actor": "usr_rights", "content-type": "application/pdf" }, payload: pdf("master contract v2") });
  assert.equal(r.statusCode, 201, r.body);
  const d = r.json();
  assert.deepEqual(d.versions.map((v: any) => v.version), [2, 1]);
  assert.equal(d.versions[0].title, "Nova 녹음 계약", "metadata carried over");
  assert.deepEqual(d.versions[0].records, []);
  assert.equal(d.versions[1].records.length, 2);
  await json("POST", `/ops/documents/${masterDoc}/versions/2/reject`, "usr_rights", 200, { reason: "잘못 올림" });
  const bad = await json("POST", "/ops/claims", "usr_rights", 422, {
    claimId: "c_lyrics", factsScopeId: SCOPE, sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, status: "VERIFIED",
    validFrom: "2026-01-01T00:00:00.000Z", evidenceDocuments: [{ documentId: masterDoc, version: 2 }],
  });
  assert.equal(bad.code, "DOCUMENT_UNUSABLE");
});

test("visibility: owner tenant, listed parties (unless OWNER-only), and the platform with an inspection record", async () => {
  const own = await upload("usr_lbl", pdf("label x private deal"), { kind: "EVIDENCE", title: "레이블 X 증빙", parties: "pty_lbl_x" }, "portal");
  assert.equal(own.statusCode, 201, own.body);
  const ownId = own.json().documentId;
  assert.equal((await call("GET", `/portal/documents/${ownId}`, "usr_lbl2")).statusCode, 404, "another tenant cannot see it");
  assert.equal((await call("GET", `/portal/documents/${ownId}/versions/1/file`, "usr_lbl2")).statusCode, 404);
  const shared = await upload("usr_rights", pdf("platform doc naming label x"), { kind: "EVIDENCE", title: "공유", parties: "pty_lbl_x" });
  const ownerOnly = await upload("usr_rights", pdf("platform doc owner only"), { kind: "EVIDENCE", title: "비공개", parties: "pty_lbl_x", confidentiality: "OWNER" });
  const seen = (await json("GET", "/portal/documents", "usr_lbl", 200)).map((d: any) => d.documentId);
  assert.ok(seen.includes(ownId) && seen.includes(shared.json().documentId));
  assert.ok(!seen.includes(ownerOnly.json().documentId));
  await json("GET", `/ops/documents/${ownId}`, "usr_ops", 200);
  const logs = (await w.db.pool.query("SELECT panel, node_id, target_tenant_id FROM inspection_audit_log WHERE node_type = 'source_document'")).rows;
  assert.deepEqual(logs.map((l) => [l.panel, l.node_id, l.target_tenant_id]), [["SOURCE_DOCUMENT", ownId, "tnt_lbl"]]);
});

test("rights summary: plain sentences with their evidence documents and the seal badge", async () => {
  const s = await json("GET", `/ops/scopes/${SCOPE}/summary`, "usr_rights", 200);
  const byArea = (a: string) => s.lines.filter((l: any) => l.area === a);
  assert.equal(byArea("MASTER")[0].text, '녹음 "Main": pty_label 100%(분쟁 중)');
  assert.deepEqual(byArea("MASTER")[0].evidence.map((e: any) => [e.documentId, e.version]), [[masterDoc, 1]]);
  assert.equal(byArea("WORK")[0].text, '작품 "Nova": pty_author_b 60%, pty_author_c 40%');
  const voiceA = byArea("VOICE").find((l: any) => l.subject === "vo_a");
  assert.equal(voiceA.text, "보이스 vo_a: pty_member_a 100% 소유 · 스템 2개 · 실연 몫 수령: pty_agency(위임 100%)");
  assert.deepEqual(voiceA.evidence.map((e: any) => e.documentId), [agencyDoc]);
  assert.equal(byArea("MANDATE")[0].text, "작품 몫 수령 위임: pty_author_b → pty_cmo 100%");
  assert.ok(s.evidenceCoverage.withEvidence >= 2 && s.evidenceCoverage.withEvidence < s.evidenceCoverage.records);
  assert.equal(s.seal.policyId, "pol_nova");
  assert.ok(s.seal.changedSinceSeal >= 3, "records changed after the policy pinned its facts");
  assert.deepEqual(s.seal.signatures.map((x: any) => x.role).sort(), ["ACTIVATOR", "EDITOR", "WORK_APPROVER"]);
});

test("disposal: only after the retention period, never while a supporting record is under an open dispute", async () => {
  assert.equal((await json("POST", `/ops/documents/${masterDoc}/versions/1/dispose`, "usr_ops", 409)).code, "RETENTION_NOT_OVER");
  const old = await upload("usr_rights", pdf("old contract"), { kind: "EVIDENCE", title: "옛 계약", effectiveTo: "2010-01-01T00:00:00.000Z" });
  const oldId = old.json().documentId;
  assert.equal((await call("POST", `/ops/documents/${oldId}/versions/1/dispose`, "usr_rights")).statusCode, 403, "operations only");
  const d = await json("POST", `/ops/documents/${oldId}/versions/1/dispose`, "usr_ops", 200);
  assert.ok(d.versions[0].disposedAt);
  assert.equal(d.versions[0].sha256, sha(pdf("old contract")), "hash and metadata stay");
  assert.equal((await call("GET", `/ops/documents/${oldId}/versions/1/file`, "usr_ops")).statusCode, 410);
  // 열린 분쟁(dsp_doc)의 기록이 근거로 삼은 문서는 기한이 지나도 보존한다.
  await w.db.tx((tx) => withSystemScope(tx, () => tx.query("UPDATE source_document SET retention_until = '2020-01-01' WHERE document_id = $1 AND version = 1", [masterDoc])));
  assert.equal((await json("POST", `/ops/documents/${masterDoc}/versions/1/dispose`, "usr_ops", 409)).code, "LEGAL_HOLD");
});

test("a stored file that no longer matches its hash is reported, not served", async () => {
  const lying: DocumentStore = { ...store, get: async () => new Uint8Array(Buffer.from("tampered")) };
  const app2 = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs(), documents: lying });
  try {
    const r = await app2.inject({ method: "GET", url: `/ops/documents/${agencyDoc}/versions/1/file`, headers: { "x-actor": "usr_rights" } });
    assert.equal(r.statusCode, 500);
    assert.equal(r.json().code, "DOCUMENT_CORRUPT");
  } finally { await app2.close(); }
});
