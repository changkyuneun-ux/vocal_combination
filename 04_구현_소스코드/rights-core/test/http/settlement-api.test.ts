import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
const jobs = recordingJobs();
const app = buildServer({ db: w.db, ctx: w.ctx, clock: w.clock, jobs });
after(async () => { await app.close(); await w.drop(); });
await issueCombo(w, "vc_1");
const post = (url: string, actor: string | undefined, payload: unknown) => app.inject({ method: "POST", url, ...(actor !== undefined && { headers: { "x-actor": actor } }), payload: payload as object });
const ev = (id: string, extra: object = {}) => ({ eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "PURCHASE", vcId: "vc_1", amountKrw: "10000", currency: "KRW", occurredAt: "2026-03-01T10:00:00.000Z", ...extra });
const handlers = () => jobHandlers({ db: w.db, ctx: w.ctx, clock: w.clock, jobs });

test("revenue → batch → jobs → confirm → refund → reversal over HTTP", async () => {
  assert.equal((await post("/revenue-events", "usr_ops", ev("ev_h1"))).statusCode, 403);
  assert.equal((await post("/revenue-events", "sys_ingest", ev("ev_h1"))).statusCode, 201);
  assert.equal((await post("/revenue-events", "sys_ingest", ev("ev_h1"))).statusCode, 200);
  assert.equal((await post("/revenue-events", "sys_ingest", { ...ev("ev_h1"), amountKrw: "1" })).statusCode, 409);
  const b = await post("/batches", "usr_ops", { batchId: "bat_h", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
  assert.equal(b.statusCode, 201, b.body);
  assert.equal(b.json().runs.length, 1);
  await jobs.drain(handlers());
  const view = await app.inject({ method: "GET", url: "/batches/bat_h", headers: { "x-actor": "usr_ops" } });
  assert.equal(view.json().progress, "READY");
  assert.equal((await post("/batches/bat_h/confirm", "usr_ops", {})).statusCode, 403);
  const c = await post("/batches/bat_h/confirm", "usr_settle", {});
  assert.equal(c.statusCode, 200, c.body);
  assert.match(c.json().manifestDigest, /^mdrl:sha256:[0-9a-f]{64}$/);
  const runId = view.json().runs[0].runId;
  const run = await app.inject({ method: "GET", url: `/runs/${runId}`, headers: { "x-actor": "usr_ops" } });
  assert.equal(run.json().status, "CONFIRMED");
  const rf = await post("/revenue-events", "sys_ingest", { eventId: "rf_h1", sourceSystem: "app", sourceEventId: "rf_h1", eventType: "REFUND", relatedEventId: "ev_h1", amountKrw: "10000", currency: "KRW", occurredAt: "2026-03-02T00:00:00.000Z" });
  assert.equal(rf.statusCode, 201, rf.body);
  await jobs.drain(handlers());
  const after2 = await app.inject({ method: "GET", url: `/runs/${runId}`, headers: { "x-actor": "usr_ops" } });
  assert.equal(after2.json().lines.net, "0");
  assert.equal((await post("/revenue-events", "sys_ingest", { eventId: "rf_h2", sourceSystem: "app", sourceEventId: "rf_h2", eventType: "REFUND", relatedEventId: "ev_h1", amountKrw: "1", currency: "KRW", occurredAt: "2026-03-02T00:00:00.000Z" })).statusCode, 422);
});

test("GET /batches/:id and /runs/:id need an identity (401) and a settlement role (403)", async () => {
  const g = (url: string, actor?: string) => app.inject({ method: "GET", url, ...(actor !== undefined && { headers: { "x-actor": actor } }) });
  for (const url of ["/batches/bat_h", "/runs/nope"]) {
    assert.equal((await g(url)).statusCode, 401);
    assert.equal((await g(url, "usr_editor")).statusCode, 403);
    assert.notEqual((await g(url, "usr_settle")).statusCode, 403);
  }
});

test("unknown run/batch are 404; /batches validates its body after authentication", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/runs/nope", headers: { "x-actor": "usr_ops" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/batches/nope", headers: { "x-actor": "usr_ops" } })).statusCode, 404);
  assert.equal((await post("/batches", undefined, { batchId: 1 })).statusCode, 401);
  for (const body of [{}, { batchId: 1, periodStart: "a", periodEnd: "b" }, { batchId: "x", periodStart: "a" }, { batchId: "x", periodStart: "a", periodEnd: null }]) {
    const r = await post("/batches", "usr_ops", body);
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().code, "BAD_REQUEST");
  }
});

test("POST /revenue-events without an object body is a client error, not 500", async () => {
  const none = await app.inject({ method: "POST", url: "/revenue-events", headers: { "x-actor": "sys_ingest" } });
  assert.equal(none.statusCode, 422, none.body);
  assert.equal(none.json().code, "INVALID_REVENUE");
  for (const payload of ["null", "[]", "5", "\"x\""]) {
    const r = await app.inject({ method: "POST", url: "/revenue-events", headers: { "x-actor": "sys_ingest", "content-type": "application/json" }, payload });
    assert.equal(r.statusCode, 422, `${payload}: ${r.body}`);
    assert.equal(r.json().code, "INVALID_REVENUE");
  }
});
