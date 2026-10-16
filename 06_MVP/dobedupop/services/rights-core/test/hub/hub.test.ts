import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import * as policy from "../../src/policy/service.ts";
import { hubEventId } from "../../src/hub/service.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";
import { POLICY_TEXT } from "../fixtures.ts";

// 연동 허브(다음 작업 14): 파트너 리포트 파일 → integration-hub 번역 → 원본 보관·줄별 적용·거부 큐 → 매출 이벤트.
const w = await settlementWorld();
const clock = fixedClock("2026-04-02T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });

await issueCombo(w, "vc_h1"); // 정책 v1: 구매만
await w.db.tx(async (tx) => {
  const text = POLICY_TEXT.replace('"pol_nova" version 1', '"pol_nova" version 2').replace("events: [PRIMARY]", "events: [PRIMARY, TRAFFIC]");
  const r = await policy.compilePolicy(w.ctx, tx, w.clock, w.users.editor, { policyId: "pol_nova", packId: "pak_nova", sourceText: text });
  await policy.approvePolicy(w.ctx, tx, w.clock, w.users.approver, r);
  await policy.activatePolicy(w.ctx, tx, w.clock, w.users.activator, r);
});
await issueCombo(w, "vc_h2"); // 정책 v2: 구매·감상
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  for (const [t, u] of [["tnt_dist", "usr_dist"], ["tnt_dist2", "usr_dist2"]]) {
    await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ($1, 'B2B_PARTNER', $2, $3)", [t, t, c0.now()]);
    await createUser(tx, c0, { userId: u!, displayName: u!, roles: [], tenantId: t });
  }
});

const call = (method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const send = (content: string, format = "DISTRIBUTOR_CSV", actor = "usr_dist", status = 201) =>
  json("POST", "/partner/inbound", actor, status, { format, fileName: "report.csv", content });
const codes = (f: any) => f.records.map((r: any) => [r.line, r.status, r.rejectCode ?? null]);

const CSV = [
  "transaction_id,type,asset_id,amount_krw,occurred_at,original_transaction_id",
  "tx1,SALE,DBP0001,1200,2026-03-02,",
  "tx2,REFUND,,200,2026-03-05,tx1",
  "tx3,STREAM_REVENUE,DBP0002,4000,2026-03-31,",
  "tx4,STREAM_REVENUE,DBP0001,900,2026-03-31,",
  "tx5,SALE,DBP0009,1200,2026-03-03,",
  "tx6,SALE,DBP0001,12.5,2026-03-03,",
  "tx7,REFUND,,100,2026-03-06,tx99",
].join("\n");
let fileId = "";

test("the platform maps partner asset ids to issued combinations", async () => {
  await json("POST", "/ops/hub/assets", "usr_ops", 201, { tenantId: "tnt_dist", externalId: "DBP0001", vcId: "vc_h1" });
  await json("POST", "/ops/hub/assets", "usr_ops", 201, { tenantId: "tnt_dist", externalId: "DBP0002", vcId: "vc_h2" });
  assert.equal((await json("POST", "/ops/hub/assets", "usr_ops", 422, { tenantId: "tnt_platform", externalId: "X", vcId: "vc_h1" })).code, "NOT_A_PARTNER");
  assert.equal((await call("POST", "/ops/hub/assets", "usr_ops", { tenantId: "tnt_dist", externalId: "X", vcId: "vc_missing" })).statusCode, 404);
  assert.deepEqual((await json("GET", "/partner/assets", "usr_dist", 200)).map((a: any) => [a.externalId, a.vcId]), [["DBP0001", "vc_h1"], ["DBP0002", "vc_h2"]]);
  assert.deepEqual(await json("GET", "/partner/assets", "usr_dist2", 200), []);
});

test("a distributor CSV is kept verbatim and applied line by line; each bad line is rejected with its reason", async () => {
  const f = await send(CSV);
  fileId = f.fileId;
  assert.equal(f.status, "APPLIED");
  assert.equal(f.sha256, createHash("sha256").update(CSV).digest("hex"));
  assert.deepEqual(codes(f), [
    [2, "ACCEPTED", null], [3, "ACCEPTED", null], [4, "ACCEPTED", null],
    [5, "REJECTED", "POLICY_NO_TRAFFIC"], [6, "REJECTED", "UNKNOWN_ASSET"], [7, "REJECTED", "INVALID_AMOUNT"], [8, "REJECTED", "UNKNOWN_ORIGINAL"],
  ]);
  assert.deepEqual(f.counts, { ACCEPTED: 3, DUPLICATE: 0, REJECTED: 4 });
  const raw = (await w.db.pool.query("SELECT raw_bytes FROM inbound_file WHERE file_id = $1", [fileId])).rows[0].raw_bytes as Buffer;
  assert.equal(raw.toString("utf8"), CSV);
  const ev = (await w.db.pool.query("SELECT event_id, event_type, vc_id, related_event_id, net_amount_krw::text AS krw, source_system FROM revenue_event WHERE source_system = 'partner:tnt_dist' ORDER BY occurred_at")).rows;
  assert.deepEqual(ev.map((e) => [e.event_type, e.vc_id, e.krw]), [["PURCHASE", "vc_h1", "1200"], ["REFUND", null, "200"], ["TRAFFIC", "vc_h2", "4000"]]);
  assert.equal(ev[0]!.event_id, hubEventId("tnt_dist", "tx1"));
  assert.equal(ev[1]!.related_event_id, hubEventId("tnt_dist", "tx1"));
});

test("re-sending the same file returns the first result; the same transaction in another file is a DUPLICATE or a mismatch", async () => {
  const again = await send(CSV, "DISTRIBUTOR_CSV", "usr_dist", 200);
  assert.equal(again.fileId, fileId);
  const f = await send("transaction_id,type,asset_id,amount_krw,occurred_at\ntx1,SALE,DBP0001,1200,2026-03-02\ntx3,STREAM_REVENUE,DBP0002,4100,2026-03-31\n");
  assert.deepEqual(codes(f), [[2, "DUPLICATE", null], [3, "REJECTED", "IDEMPOTENCY_MISMATCH"]]);
});

test("the reject queue: after the missing mapping is registered, a retry applies only the fixable lines", async () => {
  await json("POST", "/ops/hub/assets", "usr_ops", 201, { tenantId: "tnt_dist", externalId: "DBP0009", vcId: "vc_h2" });
  assert.equal((await call("POST", `/ops/hub/files/${fileId}/retry`, "usr_settle")).statusCode, 403, "operations staff only");
  const r = await json("POST", `/ops/hub/files/${fileId}/retry`, "usr_ops", 200);
  assert.equal(r.retried, 2);
  assert.equal(r.fixed, 1);
  assert.deepEqual(codes(r.file).slice(3), [[5, "REJECTED", "POLICY_NO_TRAFFIC"], [6, "ACCEPTED", null], [7, "REJECTED", "INVALID_AMOUNT"], [8, "REJECTED", "UNKNOWN_ORIGINAL"]]);
  const byLine = new Map<number, any>(r.file.records.map((x: any) => [x.line, x]));
  assert.equal(byLine.get(6).attempts, 2);
  assert.equal(byLine.get(8).retriable, true, "UNKNOWN_ORIGINAL can be retried once the original arrives");
  assert.equal(byLine.get(5).retriable, false, "POLICY_NO_TRAFFIC is not fixed by retrying");
});

test("a truncated DDEX DSR is rejected as a whole; a complete one is applied", async () => {
  const dsr = (foot: number) => [
    "HEAD\tflat-dsr/1.0\tDPID_DIST\t2026-03-01\t2026-03-31",
    "SU01\tS-1\tDBP0001\tPermanentDownload\t1\t1500\tKRW\t2026-03-10",
    "SU01\tS-2\tDBP0002\tOnDemandStream\t812\t3000\tKRW\t2026-03-31",
    `FOOT\t${foot}`,
  ].join("\n");
  const bad = await send(dsr(5), "DDEX_DSR");
  assert.equal(bad.status, "REJECTED");
  assert.deepEqual(bad.fileErrors.map((e: any) => e.code), ["COUNT_MISMATCH"]);
  assert.deepEqual(bad.records, []);
  const good = await send(dsr(2), "DDEX_DSR");
  assert.equal(good.status, "APPLIED");
  assert.deepEqual(codes(good), [[2, "ACCEPTED", null], [3, "ACCEPTED", null]]);
});

test("partners see only their own files; other identities cannot use the partner channel", async () => {
  assert.equal((await json("GET", "/partner/inbound", "usr_dist", 200)).length, 4);
  assert.deepEqual(await json("GET", "/partner/inbound", "usr_dist2", 200), []);
  assert.equal((await call("GET", `/partner/inbound/${fileId}`, "usr_dist2")).statusCode, 404);
  assert.equal((await call("POST", "/partner/inbound", "usr_ops", { format: "DISTRIBUTOR_CSV", content: CSV })).statusCode, 403);
  assert.equal((await json("POST", "/partner/inbound", "usr_dist", 422, { format: "XML", content: "x" })).code, "INVALID_FILE");
  assert.equal((await json("GET", "/ops/hub/files", "usr_ops", 200)).length, 4);
});

test("⑧ shows the reject queue and wholly rejected files", async () => {
  const sig = await json("GET", "/ops/pipeline/signals", "usr_ops", 200);
  const rev = Object.fromEntries(sig.stages.find((s: any) => s.stage === "revenue").signals.map((s: any) => [s.key, s.value]));
  assert.equal(rev["hub-rejected"], 4);
  assert.equal(rev["hub-files-rejected-30d"], 1);
});
