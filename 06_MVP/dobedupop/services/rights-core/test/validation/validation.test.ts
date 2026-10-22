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
import { assertActivationAllowed } from "../../src/validation/service.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { setSodRules } from "../helpers.ts";

// 정합성 검증(원천 문서 설계 S3a, 결정 D7·D8): 곡 단위로 빠진 근거·문서와 기록의 불일치를 찾아 이슈로 남기고, 고치면 시스템이 닫는다.
// BLOCK은 활성화를 막고(적용 테넌트), WARN은 기한이 지나면 BLOCK으로 오르며 위험 수용은 운영 요청 + 컴플라이언스 승인이다.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-val-"));
const documents = createFsDocumentStore(dir, Buffer.alloc(32, 5));
const clock = fixedClock("2026-03-01T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs(), documents });
const laterClock = fixedClock("2026-04-01T00:00:00.000Z", 1000);
const later = buildServer({ db: w.db, ctx: w.ctx, clock: laterClock, jobs: recordingJobs(), documents });
after(async () => { await app.close(); await later.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_lbl', 'LABEL', 'label', $1)", [c0.now()]);
  await registerParty(tx, c0, { partyId: "pty_lbl_x", partyType: "LABEL", displayName: "레이블 X", tenantId: "tnt_lbl" });
  await registerParty(tx, c0, { partyId: "pty_writer", partyType: "AUTHOR", displayName: "작가 W" });
  await createUser(tx, c0, { userId: "usr_lbl", displayName: "label", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_compliance", displayName: "compliance", roles: ["COMPLIANCE"] });
});
const call = (srv: typeof app, method: "GET" | "POST" | "PUT", url: string, actor: string, payload?: object) =>
  srv.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST" | "PUT", url: string, actor: string, status: number, payload?: object, srv = app): Promise<any> => {
  const r = await call(srv, method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const T0 = "2026-01-01T00:00:00.000Z";
const upload = async (title: string, kind: string, parties: string, effectiveTo?: string) => {
  const r = await app.inject({ method: "POST", url: `/portal/documents?kind=${kind}&title=${encodeURIComponent(title)}&parties=${parties}${effectiveTo ? `&effectiveTo=${effectiveTo}` : ""}`,
    headers: { "x-actor": "usr_lbl", "content-type": "application/pdf" }, payload: Buffer.from(`%PDF-1.4\n% ${title}\n%%EOF\n`) });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().documentId as string;
};
const open = (v: any) => v.issues.filter((i: any) => i.status === "OPEN").map((i: any) => `${i.severity} ${i.rule} ${i.subjectId}`).sort();

for (const [path, body] of [
  ["/portal/works", { workId: "wrk_x", title: "X" }], ["/portal/scopes", { factsScopeId: "fsc_x", workId: "wrk_x" }],
  ["/portal/recordings", { recordingId: "rcd_x", workId: "wrk_x", masterOwnerPartyId: "pty_lbl_x", versionTitle: "Main" }],
  ["/portal/claims", { claimId: "c_x_master", factsScopeId: "fsc_x", sourceId: "rcd_x", edge: "CONTROLLED_BY", targetId: "pty_lbl_x", shareBps: 10000, status: "VERIFIED", validFrom: T0 }],
  ["/portal/claims", { claimId: "c_x_work", factsScopeId: "fsc_x", sourceId: "wrk_x", edge: "WRITTEN_BY", targetId: "pty_writer", shareBps: 10000, status: "ASSERTED", validFrom: T0 }],
] as const) await json("POST", path, "usr_lbl", 201, body);

test("missing evidence, consents and platform contract are BLOCK; pending confirmation and payout info are WARN", async () => {
  const v = await json("GET", "/portal/scopes/fsc_x/validation", "usr_lbl", 200);
  assert.equal(v.enforced, true, "a rights-holder tenant is enforced by default");
  assert.deepEqual(open(v), [
    "BLOCK DOC_CONSENT_MISSING MASTER:rcd_x", "BLOCK DOC_CONSENT_MISSING WORK:wrk_x",
    "BLOCK DOC_EVIDENCE_MISSING CLAIM:c_x_master", "BLOCK DOC_EVIDENCE_MISSING CLAIM:c_x_work",
    "BLOCK DOC_PLATFORM_CONTRACT_MISSING pty_lbl_x",
    "WARN DOC_CONFIRMATION_PENDING CLAIM:c_x_work", "WARN DOC_PAYOUT_PROFILE_MISSING pty_lbl_x", "WARN DOC_PAYOUT_PROFILE_MISSING pty_writer",
  ]);
  const warn = v.issues.find((i: any) => i.rule === "DOC_PAYOUT_PROFILE_MISSING");
  assert.equal(Date.parse(warn.dueAt) - Date.parse(warn.openedAt), 14 * 86_400_000);
  assert.ok(v.issues.every((i: any) => i.hint.length > 0));
});

test("BLOCK issues stop activation for an enforced tenant; operations can switch enforcement", async () => {
  await assert.rejects(w.db.tx((tx) => assertActivationAllowed(tx, clock, "fsc_x")), (e: any) => e.code === "VALIDATION_BLOCKED" && e.diagnostics.length === 5);
  await json("PUT", "/ops/tenants/tnt_lbl/validation", "usr_ops", 200, { enforced: false });
  await w.db.tx((tx) => assertActivationAllowed(tx, clock, "fsc_x"));
  await json("PUT", "/ops/tenants/tnt_lbl/validation", "usr_ops", 200, { enforced: true });
  assert.equal((await call(app, "PUT", "/portal/tenants/tnt_lbl/validation", "usr_lbl", { enforced: false })).statusCode, 403);
});

test("fixing the cause closes the issue automatically; a document whose parties do not include the right holder is a mismatch", async () => {
  const master = await upload("X 녹음 계약", "MASTER_CONTRACT", "pty_lbl_x");
  await json("POST", "/portal/claims", "usr_lbl", 201, {
    claimId: "c_x_master", factsScopeId: "fsc_x", sourceId: "rcd_x", edge: "CONTROLLED_BY", targetId: "pty_lbl_x", shareBps: 10000, status: "VERIFIED", validFrom: T0,
    evidenceDocuments: [{ documentId: master, version: 1 }],
  });
  const c = await json("POST", `/portal/documents/${master}/versions/1/clauses`, "usr_lbl", 201, { quote: "레이블 X가 녹음 100%", clauseType: "RIGHT_HOLDER" });
  await json("POST", `/portal/clauses/${c.clauseId}/links`, "usr_lbl", 201, { recordType: "CLAIM", recordId: "c_x_work" });
  const v = await json("GET", "/portal/scopes/fsc_x/validation", "usr_lbl", 200);
  const resolved = v.issues.find((i: any) => i.rule === "DOC_EVIDENCE_MISSING" && i.subjectId === "CLAIM:c_x_master");
  assert.equal(resolved.status, "RESOLVED");
  assert.ok(resolved.closedAt);
  assert.ok(open(v).includes(`BLOCK DOC_PARTY_MISMATCH CLAIM:c_x_work@${master}`));
  assert.ok(!open(v).includes("BLOCK DOC_EVIDENCE_MISSING CLAIM:c_x_work"), "the work claim now has evidence, just the wrong one");
});

test("expiring documents warn with the expiry as due date; expired ones block", async () => {
  const contract = await upload("X 플랫폼 계약", "PLATFORM_CONTRACT", "pty_lbl_x", "2026-03-20T00:00:00.000Z");
  const v = await json("GET", "/portal/scopes/fsc_x/validation", "usr_lbl", 200);
  assert.ok(!open(v).some((x: string) => x.includes("DOC_PLATFORM_CONTRACT_MISSING")), "a current platform contract satisfies the rule");
  const v2 = await json("GET", "/portal/scopes/fsc_x/validation", "usr_lbl", 200, undefined, later);
  assert.ok(open(v2).includes("BLOCK DOC_PLATFORM_CONTRACT_MISSING pty_lbl_x"), `expired after 3/20: ${contract}`);
});

test("an overdue WARN escalates to BLOCK", async () => {
  const v = await json("GET", "/portal/scopes/fsc_x/validation", "usr_lbl", 200, undefined, later);
  const payout = v.issues.find((i: any) => i.rule === "DOC_PAYOUT_PROFILE_MISSING" && i.subjectId === "pty_writer");
  assert.equal(payout.severity, "BLOCK");
  assert.equal(payout.status, "OPEN");
});

test("risk acceptance: WARN only, operations requests and compliance approves (not the same person); dismissal by compliance sticks", async () => {
  await w.db.tx((tx) => registerParty(tx, fixedClock("2026-01-01T00:00:00.000Z", 0), { partyId: "pty_writer2", partyType: "AUTHOR", displayName: "작가 W2" }));
  await json("POST", "/portal/claims", "usr_lbl", 201, { claimId: "c_x_work2", factsScopeId: "fsc_x", sourceId: "wrk_x", edge: "WRITTEN_BY", targetId: "pty_writer2", shareBps: 10000, status: "ASSERTED", validFrom: T0 });
  const list = await json("GET", "/ops/validation-issues?status=OPEN&scope=fsc_x", "usr_ops", 200);
  const warn = list.find((i: any) => i.rule === "DOC_PAYOUT_PROFILE_MISSING" && i.subjectId === "pty_writer2");
  const block = list.find((i: any) => i.severity === "BLOCK");
  assert.equal((await json("POST", `/ops/validation-issues/${block.issueId}/acceptance-request`, "usr_ops", 409, { reason: "x" })).code, "NOT_ACCEPTABLE");
  await json("POST", `/ops/validation-issues/${warn.issueId}/acceptance-request`, "usr_ops", 200, { reason: "작가 계좌 등록 중" });
  assert.equal((await call(app, "POST", `/ops/validation-issues/${warn.issueId}/accept`, "usr_ops")).statusCode, 403, "operations cannot approve");
  const ok = await json("POST", `/ops/validation-issues/${warn.issueId}/accept`, "usr_compliance", 200);
  assert.equal(ok.status, "ACCEPTED");
  const span = Date.parse(ok.acceptUntil) - Date.parse("2026-03-01T00:00:00.000Z");
  assert.ok(span > 30 * 86_400_000 && span < 31 * 86_400_000, "accepted for 30 days from the approval");
  const pend = list.find((i: any) => i.rule === "DOC_CONFIRMATION_PENDING" && i.subjectId === "CLAIM:c_x_work2");
  await json("POST", `/ops/validation-issues/${pend.issueId}/dismiss`, "usr_compliance", 200, { reason: "작가가 서면으로 확인함(시스템 밖)" });
  const v = await json("GET", "/portal/scopes/fsc_x/validation", "usr_lbl", 200);
  assert.ok(!open(v).includes("WARN DOC_CONFIRMATION_PENDING CLAIM:c_x_work2"), "a dismissed issue with the same content is not reopened");
  assert.ok(v.issues.some((i: any) => i.issueId === warn.issueId && i.status === "ACCEPTED"));
});

test("validation.request-approve: when enabled the requester cannot approve; disabled (MVP 총괄 운영, 결정 RD6) the same person may", async () => {
  await w.db.tx(async (tx) => {
    const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
    await registerParty(tx, c0, { partyId: "pty_writer3", partyType: "AUTHOR", displayName: "작가 W3" });
    await createUser(tx, c0, { userId: "usr_ops_comp", displayName: "운영+컴플라이언스", roles: ["SPACE_OPS", "COMPLIANCE"] });
  });
  await json("POST", "/portal/claims", "usr_lbl", 201, { claimId: "c_x_work3", factsScopeId: "fsc_x", sourceId: "wrk_x", edge: "WRITTEN_BY", targetId: "pty_writer3", shareBps: 10000, status: "ASSERTED", validFrom: T0 });
  const list = await json("GET", "/ops/validation-issues?status=OPEN&scope=fsc_x", "usr_ops", 200);
  const warn = list.find((i: any) => i.rule === "DOC_PAYOUT_PROFILE_MISSING" && i.subjectId === "pty_writer3");
  await json("POST", `/ops/validation-issues/${warn.issueId}/acceptance-request`, "usr_ops_comp", 200, { reason: "작가 계좌 등록 중" });
  await setSodRules(w.adminUrl, ["validation.request-approve"]);
  try {
    assert.equal((await json("POST", `/ops/validation-issues/${warn.issueId}/accept`, "usr_ops_comp", 403)).code, "SOD_VIOLATION");
  } finally {
    await setSodRules(w.adminUrl, ["validation.request-approve"], false);
  }
  assert.equal((await json("POST", `/ops/validation-issues/${warn.issueId}/accept`, "usr_ops_comp", 200)).status, "ACCEPTED");
});

test("⑧ registry stage shows blocking and overdue validation issues; another tenant cannot see them", async () => {
  const sig = await json("GET", "/ops/pipeline/signals", "usr_ops", 200);
  const reg = Object.fromEntries(sig.stages.find((s: any) => s.stage === "registry").signals.map((s: any) => [s.key, s.value]));
  assert.ok(reg["validation-block"] > 0);
  await w.db.tx(async (tx) => {
    await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_other', 'LABEL', 'other', '2026-01-01T00:00:00Z')");
    await createUser(tx, fixedClock("2026-01-01T00:00:00.000Z", 0), { userId: "usr_other", displayName: "other", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_other" });
  });
  assert.deepEqual(await json("GET", "/portal/validation-issues", "usr_other", 200), []);
  assert.equal((await call(app, "GET", "/portal/scopes/fsc_x/validation", "usr_other")).statusCode, 404);
});
