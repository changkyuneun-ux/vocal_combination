import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { issueCombo, ledgerFlow, purchase, settlementWorld } from "../settlement-fixtures.ts";

// ⑧ 권리 파이프라인 관제(다음 작업 8): 단계별 신호, 한 건 추적, 영향 분석. 원장 흐름(확정·보류 해제·역분개·지급 실패·재지급)을 돌린 세계에서 본다.
const w = await settlementWorld();
await issueCombo(w, "vc_1");
await ledgerFlow(w);
await purchase(w, "ev_after", "vc_1", "20000", "2026-07-05T00:00:00.000Z"); // 아직 정산되지 않은 매출
const clock = fixedClock("2026-07-10T00:00:00.000Z", 1);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });

const call = (url: string, actor = "usr_ops", method: "GET" | "POST" = "GET", payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const ok = async (url: string, actor = "usr_ops"): Promise<any> => {
  const r = await call(url, actor);
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  return r.json();
};

test("a gate rejection is kept for monitoring even though the issue transaction rolls back", async () => {
  const r = await call("/ops/issues", "usr_issuer", "POST", {
    packId: "pak_nova", vcId: "vc_rejected", members: { pty_member_a: 10000 },
    assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_2", stemId: "stm_a2" }, { slotId: "slt_mr", stemId: "stm_mr" }],
  });
  assert.equal(r.statusCode, 422, r.body);
  const rows = (await w.db.pool.query("SELECT channel, actor_user_id, vc_id, code FROM issue_rejection")).rows;
  assert.deepEqual(rows, [{ channel: "ops", actor_user_id: "usr_issuer", vc_id: "vc_rejected", code: "ISSUE_NOT_SETTLEABLE" }]);
});

test("signals: nine pipeline stages with values from every module", async () => {
  const s = await ok("/ops/pipeline/signals");
  assert.deepEqual(s.stages.map((x: any) => x.stage), ["registry", "audio", "policy", "pack", "issuance", "revenue", "settlement", "payout", "dispute"]);
  const v = (stage: string, key: string) => s.stages.find((x: any) => x.stage === stage).signals.find((y: any) => y.key === key);
  assert.equal(v("revenue", "flagged").value, 2);
  assert.equal(v("revenue", "unsettled").value, 1);
  assert.equal(v("revenue", "unsettled-krw").value, "20000");
  assert.equal(v("issuance", "rejected-7d").value, 1);
  assert.equal(v("issuance", "rejected-ISSUE_NOT_SETTLEABLE").severity, "warn");
  assert.equal(v("pack", "active").value, 1);
  assert.ok(v("payout", "payout-failed") !== undefined);
});

test("trace from a combination: seal digests, revenue, runs, lines, refunds and payouts in one answer", async () => {
  const t = await ok("/ops/trace?vc=vc_1");
  assert.equal(t.issue.snapshotId, "snp_vc_1");
  assert.match(t.issue.seal.facts, /^mdrl:sha256:/);
  assert.equal(t.issue.policy, "pol_nova@1");
  const ev = t.revenue.find((e: any) => e.eventId === "ev_c");
  assert.equal(ev.run.status, "CONFIRMED");
  assert.ok(ev.lines.some((l: any) => l.kind === "SETTLE") && ev.lines.some((l: any) => l.kind === "REVERSAL"), JSON.stringify(ev.lines));
  assert.deepEqual(ev.refunds.map((r: any) => r.eventId), ["rf_c"]);
  assert.equal(t.revenue.find((e: any) => e.eventId === "ev_after").run, undefined);
  assert.ok(t.payouts.length > 0);
});

test("trace from a refund goes back to its purchase; trace from a party lists its combinations and money", async () => {
  const t = await ok("/ops/trace?event=rf_c");
  assert.deepEqual(t.revenue.map((e: any) => e.eventId), ["ev_c"]);
  const p = await ok("/ops/trace?party=pty_member_b");
  assert.deepEqual(p.performedIn.map((x: any) => x.vcId), ["vc_1"]);
  assert.ok(p.lines.some((l: any) => l.kind === "SETTLE"));
  assert.ok(p.payouts.some((x: any) => x.status === "FAILED"), JSON.stringify(p.payouts));
});

test("impact of a consent revocation: affected combinations, unsettled revenue to hold, settled lines to review", async () => {
  const consent = (await w.db.pool.query("SELECT consent_id FROM consent_agreement WHERE party_id = 'pty_member_a' AND right_type = 'PERFORMER'")).rows[0].consent_id;
  const i = await ok(`/ops/impact?consent=${consent}`);
  assert.deepEqual(i.combinations.map((c: any) => c.vcId), ["vc_1"]);
  assert.deepEqual(i.hold.events, ["ev_after"]);
  assert.equal(i.hold.amountKrw, "20000");
  assert.ok(i.reverseReview.count >= 1 && i.reverseReview.byParty.length > 0, JSON.stringify(i.reverseReview));
  const byClaim = await ok("/ops/impact?claim=c_master");
  assert.deepEqual(byClaim.combinations.map((c: any) => c.vcId), ["vc_1"]);
  assert.equal((await call("/ops/impact")).statusCode, 400);
});

test("monitoring lives on the ops channel only", async () => {
  assert.equal((await call("/portal/pipeline/signals", "usr_rights")).statusCode, 404);
  assert.equal((await call("/ops/pipeline/signals", "usr_settle")).statusCode, 200);
});
