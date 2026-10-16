import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import * as policy from "../../src/policy/service.ts";
import { ingestRevenue, noRevisionHook } from "../../src/revenue/service.ts";
import { confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";
import { POLICY_TEXT } from "../fixtures.ts";

// 멤버별 기여분(다음 작업 16): 소속사에 실연 권리를 위임한 멤버가 위임 전 자기 몫을 실연자 앱에서 본다(엔진 시뮬레이션, 참고값).
const w = await settlementWorld();
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const app = buildServer({ db: w.db, ctx: w.ctx, clock: fixedClock("2026-05-01T00:00:00.000Z", 1000), jobs });
after(async () => { await app.close(); await w.drop(); });

// 정책 v2: 실연 몫을 위임대로 보낸다(멤버 a → 소속사). 멤버 b는 위임이 없어 직접 받는다.
await w.db.tx(async (tx) => {
  const text = POLICY_TEXT.replace('"pol_nova" version 1', '"pol_nova" version 2').replace("|> cap(50%) : 40%", "|> cap(50%) via mandate : 40%");
  const r = await policy.compilePolicy(w.ctx, tx, w.clock, w.users.editor, { policyId: "pol_nova", packId: "pak_nova", sourceText: text });
  await policy.approvePolicy(w.ctx, tx, w.clock, w.users.approver, r);
  await policy.activatePolicy(w.ctx, tx, w.clock, w.users.activator, r);
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  for (const m of ["a", "b"]) await createUser(tx, c0, { userId: `usr_perf_${m}`, displayName: m, roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: `pty_member_${m}` });
});
await issueCombo(w, "vc_k1");
await issueCombo(w, "vc_k2", "b", "a");
await purchase(w, "ev_k1a", "vc_k1", "10000");
await purchase(w, "ev_k1b", "vc_k1", "3300");
await purchase(w, "ev_k2a", "vc_k2", "5000");
await purchase(w, "ev_k2f", "vc_k2", "7000", "2026-03-02T00:00:00.000Z", "FLAGGED");
await createBatch(d, w.users.ops, { batchId: "bat_k", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
await jobs.drain(jobHandlers(d));
await confirmBatch(d, w.users.settle, "bat_k");
await jobs.drain(jobHandlers(d));
// 확정 뒤 전액 환불 → 역분개
await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
  eventId: "ev_k1b_rf", sourceSystem: "app", sourceEventId: "ev_k1b_rf", eventType: "REFUND", relatedEventId: "ev_k1b", amountKrw: "3300", currency: "KRW", occurredAt: "2026-04-05T00:00:00.000Z",
}, refundHook(jobs), noRevisionHook));
await jobs.drain(jobHandlers(d));

const contributions = async (user: string) => {
  const r = await app.inject({ method: "GET", url: "/performer/contributions?from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z", headers: { "x-actor": user } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const sumLines = async (party: string, bucket?: string) => BigInt((await w.db.pool.query(
  `SELECT COALESCE(sum(amount_krw), 0)::text AS s FROM allocation_line WHERE party_id = $1 AND ($2::text IS NULL OR bucket = $2)`, [party, bucket ?? null])).rows[0].s);

test("a member whose performer share goes to the agency sees the share before routing", async () => {
  assert.equal(await sumLines("pty_member_a"), 0n, "member a receives nothing directly");
  const c = await contributions("usr_perf_a");
  assert.deepEqual(c.items.map((i: any) => i.vcId), ["vc_k1", "vc_k2"]);
  // 위임은 a 한 명뿐이라, 소속사가 실연 버킷에서 받은 금액(역분개 포함) = a의 위임 전 몫.
  assert.equal(BigInt(c.total), await sumLines("pty_agency", "performer"));
  assert.ok(BigInt(c.total) > 0n);
});

test("refunds after confirmation and unreleased fraud holds are reflected", async () => {
  const c = await contributions("usr_perf_a");
  const k1 = c.items.find((i: any) => i.vcId === "vc_k1");
  const k2 = c.items.find((i: any) => i.vcId === "vc_k2");
  assert.equal(k1.events, 1, "the fully refunded purchase drops out");
  assert.equal(k2.events, 2);
  assert.equal(k2.heldEvents, 1, "the FLAGGED purchase is held, its rights pool is not distributed");
});

test("a member without a mandate: the contribution equals what they actually received", async () => {
  const c = await contributions("usr_perf_b");
  assert.equal(BigInt(c.total), await sumLines("pty_member_b", "performer"));
});

test("period is required and only the performer channel serves it", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/performer/contributions", headers: { "x-actor": "usr_perf_a" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/ops/contributions?from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z", headers: { "x-actor": "usr_ops" } })).statusCode, 404);
});
