import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { createFsDocumentStore } from "../../src/documents/store.ts";
import { settlementWorld } from "../settlement-fixtures.ts";

// 근거 연결과 상대 당사자 확인(원천 문서 설계 S3, 결정 D5): 돈의 흐름을 바꾸는 기록은 상대가 확인해야 VERIFIED,
// 거절하면 분쟁, 상대가 플랫폼 밖이면 기한 뒤 플랫폼이 원문을 대조해 확인한다. 조항을 근거로 연결하면 증빙이 봉인 대상이 된다.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-cfm-"));
const documents = createFsDocumentStore(dir, Buffer.alloc(32, 4));
const app = buildServer({ db: w.db, ctx: w.ctx, clock: fixedClock("2026-03-01T00:00:00.000Z", 1000), jobs: recordingJobs(), documents });
const later = buildServer({ db: w.db, ctx: w.ctx, clock: fixedClock("2026-04-01T00:00:00.000Z", 1000), jobs: recordingJobs(), documents });
after(async () => { await app.close(); await later.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_lbl', 'LABEL', 'label', $1)", [c0.now()]);
  await registerParty(tx, c0, { partyId: "pty_lbl_x", partyType: "LABEL", displayName: "레이블 X", tenantId: "tnt_lbl" });
  await registerParty(tx, c0, { partyId: "pty_writer", partyType: "AUTHOR", displayName: "작가 W" });
  await registerParty(tx, c0, { partyId: "pty_singer", partyType: "MEMBER", displayName: "가수 S", tenantId: "tnt_platform_default" });
  await createUser(tx, c0, { userId: "usr_lbl", displayName: "label", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_singer", displayName: "singer", roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: "pty_singer" });
});

const call = (srv: typeof app, method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  srv.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object, srv = app): Promise<any> => {
  const r = await call(srv, method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const T0 = "2026-01-01T00:00:00.000Z";
const claim = (claimId: string, sourceId: string, edge: string, targetId: string, status: string) =>
  ({ claimId, factsScopeId: "fsc_x", sourceId, edge, targetId, shareBps: 10000, status, validFrom: T0 });

// 레이블 테넌트가 자기 곡을 등록한다.
for (const [path, body] of [
  ["/portal/works", { workId: "wrk_x", title: "X" }], ["/portal/scopes", { factsScopeId: "fsc_x", workId: "wrk_x" }],
  ["/portal/recordings", { recordingId: "rcd_x", workId: "wrk_x", masterOwnerPartyId: "pty_lbl_x", versionTitle: "Main" }],
  ["/portal/voices", { voiceId: "voc_s", factsScopeId: "fsc_x", kind: "HUMAN" }],
] as const) await json("POST", path, "usr_lbl", 201, body);

let writerRequest = 0;
let singerRequest = 0;

test("the label may record its own master right as VERIFIED, but not another party's right", async () => {
  await json("POST", "/portal/claims", "usr_lbl", 201, claim("c_x_master", "rcd_x", "CONTROLLED_BY", "pty_lbl_x", "VERIFIED"));
  assert.equal((await json("POST", "/portal/claims", "usr_lbl", 422, claim("c_x_work", "wrk_x", "WRITTEN_BY", "pty_writer", "VERIFIED"))).code, "CONFIRMATION_REQUIRED");
});

test("recording another party's right as ASSERTED sends that party a confirmation request with a 14-day due date", async () => {
  await json("POST", "/portal/claims", "usr_lbl", 201, claim("c_x_work", "wrk_x", "WRITTEN_BY", "pty_writer", "ASSERTED"));
  await json("POST", "/portal/claims", "usr_lbl", 201, claim("c_x_voice", "voc_s", "OWNED_BY", "pty_singer", "ASSERTED"));
  const open = await json("GET", "/portal/confirmations?status=OPEN", "usr_lbl", 200);
  const byRecord = Object.fromEntries(open.map((r: any) => [r.recordId, r]));
  assert.equal(byRecord.c_x_work.counterpartyId, "pty_writer");
  assert.equal(byRecord.c_x_voice.counterpartyId, "pty_singer");
  assert.equal(Date.parse(byRecord.c_x_work.dueAt) - Date.parse(byRecord.c_x_work.requestedAt), 14 * 86_400_000);
  writerRequest = byRecord.c_x_work.requestId;
  singerRequest = byRecord.c_x_voice.requestId;
  const notices = (await w.db.pool.query("SELECT kind FROM notification WHERE user_id = 'usr_singer'")).rows;
  assert.deepEqual(notices.map((n) => n.kind), ["CONFIRMATION"]);
});

test("the counterparty confirms in the performer app → the claim becomes VERIFIED; nobody else can confirm", async () => {
  assert.equal((await json("POST", `/portal/confirmations/${singerRequest}/confirm`, "usr_lbl", 403)).code, "NOT_COUNTERPARTY");
  const mine = await json("GET", "/performer/confirmations", "usr_singer", 200);
  assert.deepEqual(mine.map((r: any) => r.recordId), ["c_x_voice"]);
  const done = await json("POST", `/performer/confirmations/${singerRequest}/confirm`, "usr_singer", 200);
  assert.equal(done.status, "CONFIRMED");
  const rows = (await w.db.pool.query("SELECT version, status FROM right_claim WHERE claim_id = 'c_x_voice' ORDER BY version")).rows;
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, "ASSERTED"], [2, "VERIFIED"]]);
});

test("declining opens a dispute on the record", async () => {
  await json("POST", "/portal/mandates", "usr_lbl", 201, {
    mandateId: "m_x_singer", factsScopeId: "fsc_x", fromPartyId: "pty_singer", toPartyId: "pty_lbl_x", rightKind: "PERFORMER", shareBps: 10000, status: "ASSERTED", validFrom: T0,
  });
  const req = (await json("GET", "/performer/confirmations", "usr_singer", 200)).find((r: any) => r.recordId === "m_x_singer");
  assert.equal(req.status, "OPEN");
  assert.equal((await json("POST", `/performer/confirmations/${req.requestId}/decline`, "usr_singer", 400, {})).code, "BAD_REQUEST");
  const d = await json("POST", `/performer/confirmations/${req.requestId}/decline`, "usr_singer", 200, { reason: "위임한 적 없음" });
  assert.equal(d.status, "DECLINED");
  const dispute = (await w.db.pool.query("SELECT status, opened_by FROM dispute WHERE dispute_id = $1", [d.disputeId])).rows[0];
  assert.deepEqual(dispute, { status: "OPEN", opened_by: "usr_singer" });
  const m = (await w.db.pool.query("SELECT status FROM mandate WHERE mandate_id = 'm_x_singer' AND superseded_at IS NULL")).rows[0];
  assert.equal(m.status, "DISPUTED");
});

test("clause evidence: mark a clause in the contract and link it; a record without that document gets a new version citing it", async () => {
  const pdf = Buffer.from("%PDF-1.4\n% publishing contract wrk_x, writer W 100%\n%%EOF\n");
  const doc = await app.inject({ method: "POST", url: `/portal/documents?kind=PUBLISHING&title=${encodeURIComponent("X 퍼블리싱 계약")}&parties=pty_writer`, headers: { "x-actor": "usr_lbl", "content-type": "application/pdf" }, payload: pdf });
  assert.equal(doc.statusCode, 201, doc.body);
  const docId = doc.json().documentId;
  const c = await json("POST", `/portal/documents/${docId}/versions/1/clauses`, "usr_lbl", 201, { page: 2, quote: "작가 W는 작품 X의 저작권 100%를 가진다", clauseType: "SHARE" });
  assert.equal((await json("POST", `/portal/documents/${docId}/versions/1/clauses`, "usr_lbl", 422, { quote: "x", clauseType: "BOGUS" })).code, "INVALID_DOCUMENT");
  const linked = await json("POST", `/portal/clauses/${c.clauseId}/links`, "usr_lbl", 201, { recordType: "CLAIM", recordId: "c_x_work" });
  assert.equal(linked.version, 2, "the claim did not cite the document yet, so a new version cites it");
  const d = await json("GET", `/portal/documents/${docId}`, "usr_lbl", 200);
  assert.deepEqual(d.versions[0].clauses[0].records, [{ type: "CLAIM", id: "c_x_work", version: 2 }]);
  assert.equal(d.versions[0].clauses[0].page, 2);
  const old = await json("GET", "/portal/confirmations", "usr_lbl", 200);
  assert.equal(old.find((r: any) => r.requestId === writerRequest).status, "SUPERSEDED", "the request was for version 1");
});

test("a counterparty off the platform: after the due date the platform verifies against the source document", async () => {
  const req = await json("POST", "/portal/confirmations", "usr_lbl", 201, { recordType: "CLAIM", recordId: "c_x_work" });
  assert.equal(req.recordVersion, 2);
  assert.equal((await json("POST", `/ops/confirmations/${req.requestId}/platform-verify`, "usr_ops", 409, { reason: "원문 대조" })).code, "NOT_DUE");
  assert.equal((await json("POST", `/ops/confirmations/${singerRequest}/platform-verify`, "usr_ops", 409, { reason: "x" }, later)).code, "REQUEST_CLOSED");
  const v = await json("POST", `/ops/confirmations/${req.requestId}/platform-verify`, "usr_ops", 200, { reason: "퍼블리싱 계약 p.2 대조" }, later);
  assert.equal(v.status, "PLATFORM_VERIFIED");
  const rows = (await w.db.pool.query("SELECT version, status, evidence_digest IS NOT NULL AS ev FROM right_claim WHERE claim_id = 'c_x_work' ORDER BY version")).rows;
  assert.deepEqual(rows.map((r) => [r.version, r.status, r.ev]), [[1, "ASSERTED", false], [2, "ASSERTED", true], [3, "VERIFIED", true]]);
  const clauseLinks = (await w.db.pool.query("SELECT record_version FROM record_clause WHERE record_id = 'c_x_work' ORDER BY record_version")).rows;
  assert.deepEqual(clauseLinks.map((r) => r.record_version), [2, 3], "the clause link carries to the verified version");
});

test("the platform cannot verify for a counterparty who uses the platform, or without a source document", async () => {
  await json("POST", "/portal/claims", "usr_lbl", 201, claim("c_x_voice2", "voc_s", "OWNED_BY", "pty_singer", "ASSERTED"));
  const req = (await json("GET", "/portal/confirmations?status=OPEN", "usr_lbl", 200)).find((r: any) => r.recordId === "c_x_voice2");
  assert.equal((await json("POST", `/ops/confirmations/${req.requestId}/platform-verify`, "usr_ops", 409, { reason: "x" }, later)).code, "COUNTERPARTY_ON_PLATFORM");
  await w.db.tx((tx) => registerParty(tx, fixedClock("2026-01-01T00:00:00.000Z", 0), { partyId: "pty_writer2", partyType: "AUTHOR", displayName: "작가 W2" }));
  await json("POST", "/portal/claims", "usr_lbl", 201, { ...claim("c_x_work2", "wrk_x", "WRITTEN_BY", "pty_writer2", "ASSERTED"), claimId: "c_x_work2" });
  const req2 = (await json("GET", "/portal/confirmations?status=OPEN", "usr_lbl", 200)).find((r: any) => r.recordId === "c_x_work2");
  assert.equal((await json("POST", `/ops/confirmations/${req2.requestId}/platform-verify`, "usr_ops", 422, { reason: "x" }, later)).code, "EVIDENCE_REQUIRED");
});
