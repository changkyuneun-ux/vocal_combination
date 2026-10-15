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
import { dueForSweep } from "../../src/validation/service.ts";
import { runValidationSweep, sweepIntervalFromEnv } from "../../src/validation/sweeper.ts";
import { settlementWorld } from "../settlement-fixtures.ts";

// 연관성 재검사(원천 문서 설계 S3b): 문서가 바뀌면(새 문서·개정·해지·거부) 그 문서가 닿는 곡을 바로 다시 검사하고,
// 정기 검사는 오래된 곡과 마지막 검사 뒤 기한·만료가 지난 곡만 다시 검사한다.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-sweep-"));
const documents = createFsDocumentStore(dir, Buffer.alloc(32, 6));
const clock = fixedClock("2026-03-01T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs(), documents });
after(async () => { await app.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_lbl', 'LABEL', 'label', $1)", [c0.now()]);
  await registerParty(tx, c0, { partyId: "pty_lbl_y", partyType: "LABEL", displayName: "레이블 Y", tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_lbl", displayName: "label", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
});
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const T0 = "2026-01-01T00:00:00.000Z";
const put = async (path: string, title: string, kind: string, effectiveTo?: string) => {
  const r = await app.inject({ method: "POST", url: `/portal${path}?kind=${kind}&title=${encodeURIComponent(title)}&parties=pty_lbl_y${effectiveTo ? `&effectiveTo=${effectiveTo}` : ""}`,
    headers: { "x-actor": "usr_lbl", "content-type": "application/pdf" }, payload: Buffer.from(`%PDF-1.4\n% ${title}\n%%EOF\n`) });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
};
// 화면을 열지 않고(재검사 API를 부르지 않고) 저장된 이슈만 본다.
const stored = async () => (await w.db.tx(async (tx) => (await tx.query(
  "SELECT severity, rule_code, subject_id FROM validation_issue WHERE facts_scope_id = 'fsc_y' AND status = 'OPEN' ORDER BY rule_code, subject_id")).rows))
  .map((r) => `${r.severity} ${r.rule_code} ${r.subject_id}`);

const contract = (await put("/documents", "Y 녹음 계약", "MASTER_CONTRACT", "2027-12-31T00:00:00.000Z")).documentId as string;
for (const [path, body] of [
  ["/portal/works", { workId: "wrk_y", title: "Y" }], ["/portal/scopes", { factsScopeId: "fsc_y", workId: "wrk_y" }],
  ["/portal/recordings", { recordingId: "rcd_y", workId: "wrk_y", masterOwnerPartyId: "pty_lbl_y", versionTitle: "Main" }],
  ["/portal/claims", { claimId: "c_y_master", factsScopeId: "fsc_y", sourceId: "rcd_y", edge: "CONTROLLED_BY", targetId: "pty_lbl_y", shareBps: 10000, status: "VERIFIED", validFrom: T0,
    evidenceDocuments: [{ documentId: contract, version: 1 }] }],
] as const) await json("POST", path, "usr_lbl", 201, body);

test("a party-level document closes its issue as soon as it is uploaded", async () => {
  assert.ok((await stored()).includes("BLOCK DOC_PLATFORM_CONTRACT_MISSING pty_lbl_y"));
  await put("/documents", "플랫폼 계약 Y", "PLATFORM_CONTRACT");
  assert.ok(!(await stored()).includes("BLOCK DOC_PLATFORM_CONTRACT_MISSING pty_lbl_y"), "the upload re-checks every scope where the party holds rights");
});

test("a revision that terminates the contract flags the record citing the old version and brings the end date forward", async () => {
  await put(`/documents/${contract}/versions`, "Y 녹음 계약(해지 합의)", "MASTER_CONTRACT", "2026-03-20T00:00:00.000Z");
  const s = await stored();
  assert.ok(s.includes(`WARN DOC_NEWER_VERSION CLAIM:c_y_master@${contract}`), s.join("\n"));
  assert.ok(s.includes(`WARN DOC_PERIOD_EXPIRING ${contract}@1`), "the newest version's end date governs the cited version");
});

test("rejecting the revision withdraws it: the record is current again and the old end date applies", async () => {
  await json("POST", `/portal/documents/${contract}/versions/2/reject`, "usr_lbl", 200, { reason: "잘못 올림" });
  const s = await stored();
  assert.ok(!s.some((x) => x.includes("DOC_NEWER_VERSION") || x.includes("DOC_PERIOD_EXPIRING")), s.join("\n"));
});

test("the sweep re-checks only stale scopes and scopes whose dates crossed since the last check", async () => {
  await put(`/documents/${contract}/versions`, "Y 녹음 계약(해지 확정)", "MASTER_CONTRACT", "2026-03-20T00:00:00.000Z");
  const now = clock.now();
  assert.ok(!(await w.db.tx((tx) => dueForSweep(tx, now, 100))).includes("fsc_y"), "just checked, nothing crossed yet");
  // 3/21: 해지일이 지났다 → 다시 검사해 만료(BLOCK)로 바뀐다. 하루가 지나지 않았어도 날짜가 넘어간 곡은 고른다.
  const at = fixedClock("2026-03-21T00:00:00.000Z", 1000);
  assert.ok((await w.db.tx((tx) => dueForSweep(tx, at.now(), 100))).includes("fsc_y"));
  assert.ok(await runValidationSweep(w.db, at) >= 1);
  assert.ok((await stored()).includes(`BLOCK DOC_PERIOD_EXPIRED ${contract}@1`));
  assert.ok(!(await w.db.tx((tx) => dueForSweep(tx, at.now(), 100))).includes("fsc_y"), "checked again: not due until the next day");
  const nextDay = fixedClock("2026-03-22T01:00:00.000Z", 1000);
  assert.ok((await w.db.tx((tx) => dueForSweep(tx, nextDay.now(), 100))).includes("fsc_y"), "stale after 24 hours");
});

test("the sweep endpoint is for platform operators; the interval comes from the environment", async () => {
  const r = await json("POST", "/ops/validation/sweep", "usr_ops", 200);
  assert.ok(Array.isArray(r.checked));
  await json("POST", "/portal/validation/sweep", "usr_lbl", 403);
  assert.equal(sweepIntervalFromEnv({}), 3_600_000);
  assert.equal(sweepIntervalFromEnv({ RC_VALIDATION_SWEEP_MS: "0" }), 0);
  assert.throws(() => sweepIntervalFromEnv({ RC_VALIDATION_SWEEP_MS: "-1" }));
});
