import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import * as policy from "../../src/policy/service.ts";
import { batchView, createBatch, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { splitByPlays } from "../../src/revenue/traffic.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";
import { POLICY_TEXT } from "../fixtures.ts";

// 감상 매출(다음 작업 13): 재생 보고 → 기간 수익 풀(구독·광고)을 조합별 유효 재생 비중으로 배정 → TRAFFIC 매출 → 정산.
const w = await settlementWorld();
const jobs = recordingJobs();
const clock = fixedClock("2026-03-10T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs });
after(async () => { await app.close(); await w.drop(); });

// 정책 v1은 구매(PRIMARY)만 받는다. v1으로 발행한 조합의 재생은 감상 매출 배정에서 빠진다.
await issueCombo(w, "vc_old");
await w.db.tx(async (tx) => {
  const text = POLICY_TEXT.replace('"pol_nova" version 1', '"pol_nova" version 2').replace("events: [PRIMARY]", "events: [PRIMARY, TRAFFIC]");
  const r = await policy.compilePolicy(w.ctx, tx, w.clock, w.users.editor, { policyId: "pol_nova", packId: "pak_nova", sourceText: text });
  await policy.approvePolicy(w.ctx, tx, w.clock, w.users.approver, r);
  await policy.activatePolicy(w.ctx, tx, w.clock, w.users.activator, r);
});
await issueCombo(w, "vc_t1");
await issueCombo(w, "vc_t2", "b", "a");
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  for (const n of ["1", "2"]) {
    await registerParty(tx, c0, { partyId: `pty_fan_${n}`, partyType: "FAN", displayName: `fan ${n}`, tenantId: "tnt_platform_default" });
    await createUser(tx, c0, { userId: `usr_fan_${n}`, displayName: `fan ${n}`, roles: [], tenantId: "tnt_platform_default", partyId: `pty_fan_${n}` });
  }
});

const call = (method: "GET" | "POST", url: string, actor: string, payload?: object) =>
  app.inject({ method, url, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST", url: string, actor: string, status: number, payload?: object): Promise<any> => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
let seq = 0;
const play = (user: string, vcId: string, durationMs = 31_000) => json("POST", "/fan/plays", user, 201, { playId: `ply_${++seq}`, vcId, durationMs });

test("largest-remainder split by plays sums to the pool", () => {
  const s = splitByPlays(100000n, [{ vcId: "a", plays: 13 }, { vcId: "b", plays: 1 }]);
  assert.deepEqual([...s], [["a", 92857n], ["b", 7143n]]);
  const even = splitByPlays(10n, [{ vcId: "x", plays: 1 }, { vcId: "y", plays: 1 }, { vcId: "z", plays: 1 }]);
  assert.deepEqual([...even], [["x", 4n], ["y", 3n], ["z", 3n]], "ties go to the smaller id");
});

test("plays: 30 s or more counts, ids are idempotent, repeat plays beyond the daily limit are FLAGGED", async () => {
  const p = await play("usr_fan_1", "vc_t1");
  assert.equal(p.counted, true);
  assert.equal(p.integrity, "CLEAR");
  assert.equal(p.playedAt.slice(0, 10), "2026-03-10", "core clock, not the device's");
  const again = await json("POST", "/fan/plays", "usr_fan_1", 201, { playId: p.playId, vcId: "vc_t1", durationMs: 31_000 });
  assert.equal(again.playedAt, p.playedAt);
  assert.equal((await call("POST", "/fan/plays", "usr_fan_1", { playId: p.playId, vcId: "vc_t2", durationMs: 31_000 })).statusCode, 409);
  assert.equal((await call("POST", "/fan/plays", "usr_fan_1", { playId: "ply_x", vcId: "vc_missing", durationMs: 31_000 })).statusCode, 404);
  assert.equal((await play("usr_fan_1", "vc_t1", 10_000)).counted, false);
  await play("usr_fan_1", "vc_t1");
  await play("usr_fan_1", "vc_t1");
  await play("usr_fan_1", "vc_t2");
  await play("usr_fan_1", "vc_old");
  await play("usr_fan_1", "vc_old");
  const fan2 = [];
  for (let i = 0; i < 12; i++) fan2.push((await play("usr_fan_2", "vc_t1")).integrity);
  assert.deepEqual(fan2.filter((x) => x === "FLAGGED").length, 2);
  assert.deepEqual(fan2.slice(0, 10), Array(10).fill("CLEAR"));
});

test("TRAFFIC revenue cannot be posted directly; it comes from allocating a pool", async () => {
  const r = await call("POST", "/ops/revenue-events", "sys_ingest", {
    eventId: "ev_tr_direct", sourceSystem: "x", sourceEventId: "x", eventType: "TRAFFIC", vcId: "vc_t1", amountKrw: "100", currency: "KRW", occurredAt: "2026-03-10T00:00:00.000Z",
  });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, "TRAFFIC_VIA_POOL");
});

test("allocating a subscription pool splits it by valid plays per combination and records one TRAFFIC event each", async () => {
  const body = { poolId: "pool_sub_2026_03", source: "SUBSCRIPTION", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z", amountKrw: "100000" };
  assert.equal((await call("POST", "/ops/traffic-pools", "usr_ops", body)).statusCode, 403, "settlement staff only");
  assert.equal((await json("POST", "/ops/traffic-pools", "usr_settle", 201, body)).status, "OPEN");
  const p = await json("POST", "/ops/traffic-pools/pool_sub_2026_03/allocate", "usr_settle", 200);
  assert.equal(p.status, "ALLOCATED");
  // vc_t1: 팬1 3회 + 팬2 10회(2회 FLAGGED 제외) = 13, vc_t2: 1. vc_old 2회는 정책이 TRAFFIC을 받지 않아 제외. 10초 재생은 세지 않는다.
  assert.deepEqual(p.allocations, [
    { vcId: "vc_t1", plays: 13, amountKrw: "92857", eventId: "ev_tr_pool_sub_2026_03_vc_t1" },
    { vcId: "vc_t2", plays: 1, amountKrw: "7143", eventId: "ev_tr_pool_sub_2026_03_vc_t2" },
  ]);
  assert.deepEqual(p.excluded, { FLAGGED: 2, POLICY_NO_TRAFFIC: 2 });
  const ev = await json("GET", "/ops/revenue-events?type=TRAFFIC", "usr_ops", 200);
  assert.deepEqual(ev.items.map((e: any) => [e.vcId, e.netAmountKrw, e.occurredAt]).sort(),
    [["vc_t1", "92857", "2026-03-31T23:59:59.999Z"], ["vc_t2", "7143", "2026-03-31T23:59:59.999Z"]]);
  assert.equal((await json("POST", "/ops/traffic-pools/pool_sub_2026_03/allocate", "usr_settle", 409)).code, "POOL_ALREADY_ALLOCATED");
});

test("TRAFFIC events settle like purchases: batched, evaluated under the sealed policy, verified and conserved", async () => {
  const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
  const b = await createBatch(d, w.users.ops, { batchId: "bat_traffic", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
  assert.equal(b.runs.length, 2);
  await jobs.drain(jobHandlers(d));
  const v = await w.db.tx((tx) => batchView(tx, "bat_traffic"));
  assert.ok(v.runs.every((r) => r.status === "VERIFIED"), JSON.stringify(v.runs));
  const sums = (await w.db.pool.query(
    `SELECT e.event_id, e.net_amount_krw::text AS net, (SELECT SUM(amount_krw) FROM pool_line p WHERE p.event_id = e.event_id)::text AS pool
       FROM revenue_event e WHERE e.event_type = 'TRAFFIC' ORDER BY e.event_id`)).rows;
  assert.deepEqual(sums.map((r) => [r.event_id, r.net, r.pool]), [
    ["ev_tr_pool_sub_2026_03_vc_t1", "92857", "92857"], ["ev_tr_pool_sub_2026_03_vc_t2", "7143", "7143"],
  ]);
});

test("a pool with no valid plays closes as NO_PLAYS and ⑧ shows plays and pools", async () => {
  await json("POST", "/ops/traffic-pools", "usr_settle", 201, { poolId: "pool_ad_2026_04", source: "AD", periodStart: "2026-04-01T00:00:00.000Z", periodEnd: "2026-05-01T00:00:00.000Z", amountKrw: "5000" });
  const p = await json("POST", "/ops/traffic-pools/pool_ad_2026_04/allocate", "usr_settle", 200);
  assert.equal(p.status, "NO_PLAYS");
  assert.deepEqual(p.allocations, []);
  assert.equal((await json("GET", "/ops/traffic-pools", "usr_ops", 200)).length, 2);
  const sig = await json("GET", "/ops/pipeline/signals", "usr_ops", 200);
  const rev = Object.fromEntries(sig.stages.find((s: any) => s.stage === "revenue").signals.map((s: any) => [s.key, s.value]));
  assert.equal(rev["plays-flagged-7d"], 2);
  assert.equal(rev["pools-no-plays"], 1);
  assert.equal(rev["plays-7d"], 18, "counted plays: fan 1 six, fan 2 twelve");
});
