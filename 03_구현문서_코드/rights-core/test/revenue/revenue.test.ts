import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { createUser, loadActor } from "../../src/platform/actor.ts";
import { ingestRevenue, refundedTotal, revenueRow, type RevenueInput } from "../../src/revenue/service.ts";

const { db, drop } = await freshDb();
after(drop);
const clock = fixedClock("2026-03-01T00:00:00.000Z", 1);
const ingest = await db.tx(async (tx) => {
  await createUser(tx, clock, { userId: "sys_ingest", displayName: "ingest", roles: ["SYSTEM"] });
  await createUser(tx, clock, { userId: "usr_other", displayName: "other", roles: ["EDITOR"] });
  return loadActor(tx, "sys_ingest");
});
const purchase = (over: Partial<RevenueInput> = {}): RevenueInput => ({
  eventId: "ev_p1", sourceSystem: "app", sourceEventId: "pay_1", eventType: "PURCHASE", vcId: "vc_1",
  amountKrw: "10000", currency: "KRW", occurredAt: "2026-03-01T10:00:00.000Z", ...over,
});

test("ingest is idempotent on the source key and rejects a changed payload", async () => {
  const hooks: string[] = [];
  const first = await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase(), async (_tx, id) => { hooks.push(id); }));
  assert.deepEqual(first, { eventId: "ev_p1", created: true });
  const again = await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase()));
  assert.deepEqual(again, { eventId: "ev_p1", created: false });
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ amountKrw: "9999" }))), { code: "IDEMPOTENCY_MISMATCH", status: 409 });
  const rev2 = await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_p1r2", sourceRevision: 2, amountKrw: "9999" })));
  assert.equal(rev2.created, true);
  const row = await db.tx((tx) => revenueRow(tx, "ev_p1"));
  assert.equal(row.integrity, "CLEAR");
  assert.equal(row.sourceRevision, 1);
  assert.deepEqual(hooks, [], "the refund hook is not called for purchases");
});

test("only SYSTEM actors ingest; amounts, currency, instants and types are validated", async () => {
  const other = await db.tx((tx) => loadActor(tx, "usr_other"));
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, other, purchase({ eventId: "ev_x", sourceEventId: "x" }))), { code: "ROLE_REQUIRED" });
  for (const bad of [{ amountKrw: "0" }, { amountKrw: "-1" }, { amountKrw: "1.5" }, { currency: "USD" as never },
    { occurredAt: "2026-03-01T10:00:00Z" }, { eventType: "REFUND" as const }, { vcId: undefined }]) {
    await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_bad", sourceEventId: "bad", ...bad }))), { code: "INVALID_REVENUE", status: 422 });
  }
});

test("refunds reference a purchase, are capped by the original amount and call the hook once", async () => {
  const hooks: string[] = [];
  const hook = async (_tx: unknown, id: string) => { hooks.push(id); };
  const refund = (id: string, amountKrw: string) => ({
    eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "REFUND" as const, relatedEventId: "ev_p1",
    amountKrw, currency: "KRW" as const, occurredAt: "2026-03-02T00:00:00.000Z",
  });
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("ev_r1", "3000"), hook));
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("ev_r1", "3000"), hook));
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("ev_r2", "7000"), hook));
  assert.deepEqual(hooks, ["ev_r1", "ev_r2"]);
  assert.equal(await db.tx((tx) => refundedTotal(tx, "ev_p1")), 10000n);
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("ev_r3", "1"), hook)), { code: "REFUND_EXCEEDS_ORIGINAL", status: 422 });
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, { ...refund("ev_r4", "1"), relatedEventId: "ev_r1" }, hook)), { code: "INVALID_REVENUE" });
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, { ...refund("ev_r5", "1"), relatedEventId: "ev_nope" }, hook)), { code: "NOT_FOUND" });
});

test("revenue rows are immutable", async () => {
  await assert.rejects(db.pool.query("UPDATE revenue_event SET net_amount_krw = 1"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM revenue_event"), /append-only|permission denied/);
});
