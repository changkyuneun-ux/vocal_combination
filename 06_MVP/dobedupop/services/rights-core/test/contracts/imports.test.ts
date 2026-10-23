import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { freshDb } from "../helpers.ts";
import { createUser, ensureSystemIdentities, withSystemScope, type Role } from "../../src/platform/actor.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { createFsDocumentStore } from "../../src/documents/store.ts";
import { devSignatureProvider } from "../../src/contracts/esign.ts";
import { providerSigned } from "../../src/contracts/service.ts";
import { devIdentityProvider } from "../../src/performer/identity.ts";
import { STEPS, type Driver } from "../../src/scenario/dynamite-personas.ts";
import { MASTER_FRAME, PUBLISHING_CLAUSES, PUBLISHING_FRAME } from "../../src/scenario/dynamite-frames.ts";

// 계약서 불러오기(3부-B, 결정 CT1~CT5; 3부-C 플랫폼 위탁 폐지 WD1~WD4): Dynamite를 멤버 확인 단계까지 돌린 뒤(작가 지분은 아직 확인 대기),
// 퍼블리싱 계약서를 읽기 틀로 불러와 권리 확인서를 보내고, 계정 없는 작가가 전자서명 링크로 서명하면 작가 지분이 확정된다.
const { db, adminUrl, drop } = await freshDb();
/** 트리거 확인용(권한 밖의 갱신·삭제도 트리거가 막는지): 관리자 연결. */
const asAdmin = async (sql: string) => { const c = new pg.Client({ connectionString: adminUrl }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
const dir = mkdtempSync(join(tmpdir(), "rc-import-"));
after(async () => { await app.close(); await drop(); rmSync(dir, { recursive: true, force: true }); });
let now = "2026-01-01T00:00:00.000Z";
const clock = { now: () => now };
const jobs = recordingJobs();
const app = buildServer({ db, ctx: createBridgeCtx(createFsBlobStore(join(dir, "blobs"))), clock, jobs, documents: createFsDocumentStore(join(dir, "docs"), Buffer.alloc(32, 5)),
  esign: devSignatureProvider, identity: devIdentityProvider });
await db.tx(async (tx) => {
  await ensureSystemIdentities(tx, clock);
  for (const [userId, role] of [["usr_ops", "SPACE_OPS"], ["usr_settle", "SPACE_SETTLE"], ["usr_settle2", "SPACE_SETTLE"], ["usr_legal", "LEGAL"]] as const) {
    await createUser(tx, clock, { userId, displayName: userId, roles: [role] });
  }
});
const reply = (r: Awaited<ReturnType<typeof app.inject>>) => { let body: unknown = r.body; try { body = r.json(); } catch { /* not json */ } return { status: r.statusCode, body }; };
const driver: Driver = {
  call: async (channel, actor, method, path, body) => reply(await app.inject({ method, url: `/${channel}${path}`, headers: actor ? { "x-actor": actor } : {}, ...(body === undefined ? {} : { payload: body as object }) })),
  upload: async (channel, actor, path, bytes, contentType) => reply(await app.inject({ method: "POST", url: `/${channel}${path}`, headers: { "x-actor": actor, "content-type": contentType }, payload: Buffer.from(bytes) })),
  setClock: async (at) => { now = at; },
  drain: async () => {},
  provisionUser: (u) => db.tx((tx) => createUser(tx, clock, { ...u, roles: u.roles as Role[] })),
  providerSigned: (id, party) => db.tx((tx) => withSystemScope(tx, () => providerSigned(tx, clock, devSignatureProvider, id, party))),
};
for (const st of STEPS) {
  await st.run(driver, {}, {});
  if (st.id === "members") break;
}
const call = async (channel: "portal" | "ops", actor: string, method: "GET" | "POST", path: string, status: number, body?: object): Promise<any> => {
  const r = await driver.call(channel, actor, method, path, body);
  assert.equal(r.status, status, `${method} ${path} as ${actor}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const BH = "usr_bh_rights";

test("migration: two rights-confirmation templates are seeded APPROVED, values and approved frames are immutable", async () => {
  const t = await call("portal", BH, "GET", "/contract-templates", 200);
  assert.deepEqual(t.filter((x: any) => x.recordKind === "CLAIM_CONFIRM").map((x: any) => `${x.templateId}@${x.version} ${x.status} ${x.seeded} ${x.clauses.length}`).sort(),
    ["tpl_claim_confirm_author@1 APPROVED true 5", "tpl_claim_confirm_label@1 APPROVED true 4"]);
  const author = t.find((x: any) => x.templateId === "tpl_claim_confirm_author");
  assert.deepEqual(author.clauses.map((c: any) => c.heading), ["대상", "작가와 지분", "이용 범위", "근거", "원본과의 관계"]);
  assert.match(author.clauses[4].text, /원본 계약을 대체하지 않는다/);
});

test("reading frames: the rights tenant registers, the platform approves; approved frames are replaced by a new version", async () => {
  assert.equal((await driver.call("ops", "usr_ops", "POST", "/reading-frames", PUBLISHING_FRAME)).status, 403, "platform staff do not register a tenant's contract form");
  const bad = await driver.call("portal", BH, "POST", "/reading-frames", { ...PUBLISHING_FRAME, fields: [{ ...PUBLISHING_FRAME.fields[0], irItem: "PRICE" }] });
  assert.equal(bad.status, 422);
  const f1 = await call("portal", BH, "POST", "/reading-frames", 201, PUBLISHING_FRAME);
  assert.equal(`${f1.version} ${f1.status}`, "1 DRAFT");
  assert.equal((await driver.call("portal", BH, "POST", "/reading-frames/frm_bighit_publishing/versions/1/approve")).status, 403, "the tenant does not approve its own frame");
  const a1 = await call("ops", "usr_legal", "POST", "/reading-frames/frm_bighit_publishing/versions/1/approve", 200);
  assert.equal(a1.status, "APPROVED");
  assert.equal((await driver.call("ops", "usr_legal", "POST", "/reading-frames/frm_bighit_publishing/versions/1/approve")).status, 409);
  // 승인된 틀은 DB에서도 바꿀 수 없다(트리거).
  await assert.rejects(asAdmin("UPDATE contract_reading_frame SET title = 'x' WHERE frame_id = 'frm_bighit_publishing'"), /rejected/);
  await assert.rejects(asAdmin("DELETE FROM contract_reading_frame WHERE frame_id = 'frm_bighit_publishing'"), /rejected/);
  const f2 = await call("portal", BH, "POST", "/reading-frames", 201, { ...PUBLISHING_FRAME, pages: 5 });
  assert.equal(f2.version, 2);
  await call("ops", "usr_legal", "POST", "/reading-frames/frm_bighit_publishing/versions/2/approve", 200);
  const list = await call("portal", BH, "GET", "/reading-frames", 200);
  assert.deepEqual(list.filter((x: any) => x.frameId === "frm_bighit_publishing").map((x: any) => `${x.version} ${x.status}`), ["2 APPROVED", "1 RETIRED"]);
  await call("portal", BH, "POST", "/reading-frames", 201, MASTER_FRAME);
  await call("ops", "usr_legal", "POST", "/reading-frames/frm_bighit_master/versions/1/approve", 200);
});

let importId = "";
test("import: a frame of another document kind is refused; marked clauses fill four candidates compared with the recorded rights", async () => {
  const wrong = await driver.call("portal", BH, "POST", "/scopes/fsc_dynamite/imports", { documentId: "doc_dynamite_publishing", frameId: "frm_bighit_master" });
  assert.equal(wrong.status, 422);
  assert.equal((wrong.body as any).code, "FRAME_KIND_MISMATCH");
  // 사람이 원천 문서에 조항을 표시한다(길 A). 서버는 PDF 글자를 뽑지 않는다(CT1).
  for (const c of PUBLISHING_CLAUSES) await call("portal", BH, "POST", "/documents/doc_dynamite_publishing/versions/1/clauses", 201, c);
  const v = await call("portal", BH, "POST", "/scopes/fsc_dynamite/imports", 201, { documentId: "doc_dynamite_publishing" });
  importId = v.importId;
  assert.equal(v.frame.frameId, "frm_bighit_publishing");
  assert.equal(v.frame.version, 2, "the latest approved version");
  assert.equal(v.step, "VALUES");
  assert.deepEqual(v.values.map((x: any) => [x.key, x.value, x.compared, x.confirmed]), [
    ["title", { text: "Dynamite" }, "SAME", false],
    ["author1", { partyId: "pty_david_stewart", shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" }, "SAME", false],
    ["author2", { partyId: "pty_jessica_agombar", shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" }, "SAME", false],
    ["effectiveFrom", { date: "2026-01-01" }, "NEW", false],
  ]);
  assert.equal(v.values[1].quote, "작가 갑의 지분은 50퍼센트");
  assert.deepEqual(v.document.parties.map((p: any) => [p.noAccount, p.manager]), [[true, "빅히트 뮤직"], [true, "빅히트 뮤직"]], "both authors: no account, managed by BigHit");
  await assert.rejects(asAdmin("UPDATE import_value SET quote = 'x'"), /append-only/);
});

test("candidates: a different value needs a choice; all confirmed moves to the gaps step, which blocks the confirmation until filled", async () => {
  const diff = await call("portal", BH, "POST", `/imports/${importId}/values/author1`, 200, { quote: "작가 갑의 지분은 60퍼센트" });
  assert.equal(diff.values[1].compared, "DIFFERENT");
  const choose = await driver.call("portal", BH, "POST", `/imports/${importId}/values/author1`, { confirm: true });
  assert.equal(choose.status, 409);
  assert.equal((choose.body as any).code, "CHOOSE_VALUE");
  const cur = await call("portal", BH, "POST", `/imports/${importId}/values/author1`, 200, { confirm: true, use: "CURRENT" });
  assert.deepEqual([cur.values[1].value.shareBps, cur.values[1].compared, cur.values[1].confirmed], [5000, "SAME", true]);
  for (const k of ["title", "author2"]) await call("portal", BH, "POST", `/imports/${importId}/values/${k}`, 200, { confirm: true });
  const gapsStep = await call("portal", BH, "POST", `/imports/${importId}/values/effectiveFrom`, 200, { confirm: true });
  assert.equal(gapsStep.step, "GAPS");
  assert.deepEqual(gapsStep.ir.map((r: any) => `${r.group}|${r.state}`), ["작품|FILLED", "작품|MISSING", "녹음|FILLED", "실연|FILLED", "수령 위임|IN_PROGRESS"]);
  const blocked = await driver.call("portal", BH, "POST", `/imports/${importId}/confirmation`, { kind: "AUTHOR" });
  assert.equal(blocked.status, 409);
  assert.equal((blocked.body as any).code, "IMPORT_GAPS");
  assert.equal((await driver.call("portal", BH, "POST", `/imports/${importId}/gaps`, { actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"], validTo: "2025-12-31" })).status, 422, "before the effective date");
  const ready = await call("portal", BH, "POST", `/imports/${importId}/gaps`, 200, { actions: ["PERSONAL_HOLD", "PREVIEW", "COMBINE"], territories: ["KR", "JP", "US"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"], validTo: "2030-12-31" });
  assert.equal(ready.step, "READY");
  assert.deepEqual(ready.gaps, { actions: ["PREVIEW", "COMBINE", "PERSONAL_HOLD"], territories: ["KR", "JP", "US"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"], validTo: "2030-12-31" });
  assert.equal((await driver.call("portal", BH, "POST", `/imports/${importId}/gaps`, { actions: ["RESELL"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"], validTo: "2030-12-31" })).status, 422, "the consent vocabulary only");
  assert.deepEqual(ready.missing, []);
});

test("author confirmation: preview fills the five clauses; shares must add up to 100%; the label kind needs a master contract", async () => {
  const p = await call("portal", BH, "GET", `/imports/${importId}/confirmation?kind=AUTHOR`, 200);
  assert.deepEqual(p.signers.sort(), ["pty_david_stewart", "pty_jessica_agombar"]);
  assert.deepEqual(p.signerParties.map((s: any) => s.noAccount), [true, true]);
  assert.deepEqual(p.records.map((r: any) => `${r.type} ${r.edge ?? r.rightType}`), ["CLAIM WRITTEN_BY", "CLAIM WRITTEN_BY", "CONSENT WORK", "CONSENT WORK"]);
  assert.equal(p.labels.usage, "이용 행위 미리듣기·조합 생성·개인 보관, 지역 대한민국·일본·미국, 매체 팬앱, 공개 대상 팬 커뮤니티");
  assert.equal(p.labels.period, "2026-01-01 ~ 2030-12-31");
  assert.match(p.labels.subject, /^작품 「Dynamite」, 녹음 Vocal Recombination\(/);
  assert.match(p.labels.source, /^Dynamite 작품 퍼블리싱 계약서 v1 제3조\(doc_dynamite_publishing, sha256 [0-9a-f]{4}…[0-9a-f]{4}\)$/);
  assert.match(p.html, /지분의 합은 100%다\.<table>/);
  assert.match(p.html, /작가 본인\(빅히트 뮤직 관리\)/);
  assert.doesNotMatch(p.html, /위탁/);
  assert.equal((await driver.call("portal", BH, "GET", `/imports/${importId}/confirmation?kind=LABEL`)).status, 422);
  const not100 = await driver.call("portal", BH, "POST", "/contracts/preview", { templateId: "tpl_claim_confirm_author", factsScopeId: "fsc_dynamite", answers: { ...p.answers,
    authors: [{ partyId: "pty_david_stewart", shareBps: 5000 }, { partyId: "pty_jessica_agombar", shareBps: 4000 }] } });
  assert.equal(not100.status, 422);
  assert.equal((not100.body as any).code, "SHARES_NOT_100");
});

test("send → both authors sign by e-signature link (no operator check) → complete: VERIFIED claims and consents recorded by BigHit, requests closed", async () => {
  const c = await call("portal", BH, "POST", `/imports/${importId}/confirmation`, 201, { kind: "AUTHOR" });
  assert.equal(c.status, "SENT");
  assert.deepEqual(c.signatures.map((s: any) => s.partyId).sort(), ["pty_david_stewart", "pty_jessica_agombar"]);
  assert.equal((await call("portal", BH, "GET", `/imports/${importId}`, 200)).step, "CONFIRM_SENT");
  assert.equal((await driver.call("portal", BH, "POST", `/imports/${importId}/values/title`, { confirm: true })).status, 409, "locked once sent");
  assert.equal((await driver.call("portal", BH, "POST", `/contracts/${c.contractId}/sign`, {})).status, 403, "the label cannot sign for the authors");
  // 플랫폼 원문 대조는 없다(결정 WD3): 경로가 없고, 운영은 작가 대신 서명하지 못한다. 빅히트도 작가(사람 당사자)를 대신 서명하지 못한다.
  assert.equal((await driver.call("ops", "usr_ops", "POST", `/contracts/${c.contractId}/platform-verify`, { partyId: "pty_david_stewart", reason: "x" })).status, 404);
  assert.equal((await driver.call("ops", "usr_ops", "POST", `/contracts/${c.contractId}/sign`, { partyId: "pty_david_stewart" })).status, 403);
  assert.equal((await driver.call("portal", "usr_bh_admin", "POST", `/contracts/${c.contractId}/complete`, {})).status, 403, "not a drafter");
  assert.equal((await driver.call("ops", "usr_ops", "POST", `/contracts/${c.contractId}/complete`, {})).status, 403, "the platform does not complete contracts");
  // 작가는 빅히트가 보낸 전자서명 링크로 서명한다(공급자 통지).
  for (const a of ["pty_david_stewart", "pty_jessica_agombar"]) await driver.providerSigned(c.contractId, a);
  const signed = await call("portal", BH, "GET", `/contracts/${c.contractId}`, 200);
  assert.equal(signed.status, "SIGNED");
  assert.deepEqual(signed.signatures.map((s: any) => s.method), ["DEV_ESIGN", "DEV_ESIGN"]);
  const done = await call("portal", BH, "POST", `/contracts/${c.contractId}/complete`, 200);
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(done.records.map((r: any) => `${r.type} ${r.id}`), ["CLAIM c_work_ds", "CLAIM c_work_ja", `CONSENT cns_${c.contractId}_1`, `CONSENT cns_${c.contractId}_2`]);
  // 기록 주체는 빅히트다(작가 관리 테넌트, 결정 WD1) — 플랫폼 이름의 기록은 없다.
  const owners = (await db.pool.query(`SELECT 'consent' AS t, owner_tenant_id FROM consent_agreement WHERE consent_id LIKE $1
    UNION ALL SELECT 'claim', owner_tenant_id FROM right_claim WHERE claim_id IN ('c_work_ds','c_work_ja') AND superseded_at IS NULL ORDER BY 1`, [`cns_${c.contractId}_%`])).rows;
  assert.deepEqual(owners.map((r) => `${r.t} ${r.owner_tenant_id}`), ["claim tnt_bighit", "claim tnt_bighit", "consent tnt_bighit", "consent tnt_bighit"]);
  const q = async (sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows;
  assert.deepEqual(await q("SELECT claim_id, version, status, share_bps FROM right_claim WHERE claim_id IN ('c_work_ds','c_work_ja') AND superseded_at IS NULL ORDER BY claim_id"),
    [{ claim_id: "c_work_ds", version: 2, status: "VERIFIED", share_bps: 5000 }, { claim_id: "c_work_ja", version: 2, status: "VERIFIED", share_bps: 5000 }]);
  assert.deepEqual((await q("SELECT document_id FROM record_evidence WHERE record_type = 'CLAIM' AND record_id = 'c_work_ds' AND record_version = 2 ORDER BY document_id")).map((r) => r.document_id),
    [`doc_${c.contractId}`, "doc_dynamite_publishing"], "the signed confirmation and the original contract");
  assert.equal((await q("SELECT count(*)::int AS n FROM record_clause WHERE record_type = 'CLAIM' AND record_id = 'c_work_ds' AND record_version = 2"))[0].n, 1, "the original clause 제3조 1항");
  assert.deepEqual((await q("SELECT status FROM confirmation_request WHERE record_id IN ('c_work_ds','c_work_ja') ORDER BY request_id")).map((r) => r.status), ["SUPERSEDED", "SUPERSEDED"]);
  assert.equal((await call("portal", BH, "GET", `/imports/${importId}`, 200)).step, "DONE");
  const v = await call("portal", BH, "GET", "/scopes/fsc_dynamite/validation", 200);
  assert.deepEqual(v.issues.filter((i: any) => i.status === "OPEN" && i.rule === "DOC_CONFIRMATION_PENDING"), [], "the two pending author confirmations closed");
  const cc = await call("portal", BH, "GET", "/scopes/fsc_dynamite/claim-confirmations", 200);
  assert.deepEqual(cc.map((x: any) => `${x.kind} ${x.contract?.status ?? "-"}`), ["LABEL -", "AUTHOR COMPLETED"]);
});

test("label confirmation from the master contract: the label signs itself and the master claim gets the signed copy as evidence", async () => {
  await call("portal", BH, "POST", "/documents/doc_dynamite_master/versions/1/clauses", 201, { page: 1, quote: "대상 녹음은 「Vocal Recombination」", clauseType: "OTHER" });
  await call("portal", BH, "POST", "/documents/doc_dynamite_master/versions/1/clauses", 201, { page: 2, quote: "마스터 권리는 빅히트 뮤직 — 레이블가 보유한다", clauseType: "RIGHT_HOLDER" });
  const v = await call("portal", BH, "POST", "/scopes/fsc_dynamite/imports", 201, { documentId: "doc_dynamite_master", quotes: { effectiveFrom: "2026년 1월 1일부터 효력" } });
  assert.deepEqual(v.values.map((x: any) => `${x.key} ${x.compared}`), ["recording SAME", "owner SAME", "effectiveFrom NEW"]);
  for (const k of ["recording", "owner"]) await call("portal", BH, "POST", `/imports/${v.importId}/values/${k}`, 200, { confirm: true });
  const ready = await call("portal", BH, "POST", `/imports/${v.importId}/values/effectiveFrom`, 200, { confirm: true });
  assert.equal(ready.step, "READY", "no usage input for a master contract");
  const c = await call("portal", BH, "POST", `/imports/${v.importId}/confirmation`, 201, { kind: "LABEL" });
  await call("portal", BH, "POST", `/contracts/${c.contractId}/sign`, 200);
  const done = await call("portal", BH, "POST", `/contracts/${c.contractId}/complete`, 200);
  assert.deepEqual(done.records.map((r: any) => `${r.type} ${r.id}`), ["CLAIM c_master"]);
  const ev = (await db.pool.query("SELECT document_id FROM record_evidence e JOIN right_claim c ON c.claim_id = e.record_id AND c.version = e.record_version AND c.superseded_at IS NULL WHERE e.record_id = 'c_master' ORDER BY 1")).rows;
  assert.deepEqual(ev.map((r) => r.document_id), [`doc_${c.contractId}`, "doc_dynamite_master"]);
  const ir = (await call("portal", BH, "GET", `/imports/${importId}`, 200)).ir;
  assert.match(ir.find((r: any) => r.group === "녹음").source, /레이블용 확인서 서명됨/);
});
