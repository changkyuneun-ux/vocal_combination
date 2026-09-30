import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock, type Clock } from "../../src/platform/clock.ts";
import type { Tx } from "../../src/platform/db.ts";
import { createUser, loadActor, type Actor } from "../../src/platform/actor.ts";
import {
  ingestRevenue as ingestWithHook, noRefundHook, noRevisionHook, refundedTotal, revenueRow, type RefundHook, type RevenueInput, type RevisionHook,
} from "../../src/revenue/service.ts";
// 테스트 편의: 훅을 생략하면 명시적 no-op을 넘긴다(서비스 자체는 두 훅을 필수로 요구한다).
const ingestRevenue = (tx: Tx, clock: Clock, actor: Actor, input: RevenueInput, hook: RefundHook = noRefundHook, onRevision: RevisionHook = noRevisionHook) =>
  ingestWithHook(tx, clock, actor, input, hook, onRevision);

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

test("concurrent duplicate deliveries serialize on the source key", async () => {
  const refund = { eventId: "ev_cr", sourceSystem: "app", sourceEventId: "ev_cr", eventType: "REFUND" as const, relatedEventId: "ev_c1",
    amountKrw: "500", currency: "KRW" as const, occurredAt: "2026-03-03T00:00:00.000Z" };
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_c1", sourceEventId: "pay_c1", amountKrw: "500" })));
  const rs = await Promise.all([1, 2].map(() => db.tx((tx) => ingestRevenue(tx, clock, ingest, refund))));
  assert.deepEqual(rs.map((r) => r.created).sort(), [false, true]);
  const ps = await Promise.all([1, 2].map(() => db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_cp", sourceEventId: "pay_cp" })))));
  assert.deepEqual(ps.map((r) => r.created).sort(), [false, true]);
});

test("identifiers and revision are validated", async () => {
  for (const bad of [{ sourceRevision: 0 }, { sourceRevision: 1.5 }, { sourceRevision: 2 ** 60 }, { eventId: "" }, { eventId: "a:b" },
    { sourceSystem: "" }, { sourceEventId: "x".repeat(201) }, { vcId: "" }]) {
    await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_v", sourceEventId: "v", ...bad }))), { code: "INVALID_REVENUE", status: 422 });
  }
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, { eventId: "ev_v", sourceSystem: "app", sourceEventId: "v", eventType: "REFUND", relatedEventId: "", amountKrw: "1", currency: "KRW", occurredAt: "2026-03-03T00:00:00.000Z" })), { code: "INVALID_REVENUE" });
});

test("replayed refund with other content mismatches; RESALE is refundable; FLAGGED round-trips", async () => {
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_s1", sourceEventId: "pay_s1", eventType: "RESALE", amountKrw: "100", integrity: "FLAGGED" })));
  assert.equal((await db.tx((tx) => revenueRow(tx, "ev_s1"))).integrity, "FLAGGED");
  const r = { eventId: "ev_sr", sourceSystem: "app", sourceEventId: "ev_sr", eventType: "REFUND" as const, relatedEventId: "ev_s1",
    amountKrw: "40", currency: "KRW" as const, occurredAt: "2026-03-03T00:00:00.000Z" };
  assert.equal((await db.tx((tx) => ingestRevenue(tx, clock, ingest, r))).created, true);
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, { ...r, amountKrw: "41" })), { code: "IDEMPOTENCY_MISMATCH", status: 409 });
});

test("external source identifiers may contain punctuation", async () => {
  const p = purchase({ eventId: "ev_ext", sourceEventId: "pay:2026/03=x" });
  assert.equal((await db.tx((tx) => ingestRevenue(tx, clock, ingest, p))).created, true);
  assert.equal((await db.tx((tx) => ingestRevenue(tx, clock, ingest, p))).created, false);
});

test("a higher revision supersedes the latest one; replays of either revision stay idempotent", async () => {
  const refunds: string[] = [];
  const revisions: string[] = [];
  const hook = async (_tx: unknown, id: string) => { refunds.push(id); };
  const onRevision = async (_tx: unknown, id: string) => { revisions.push(id); };
  const r1 = purchase({ eventId: "ev_rv1", sourceEventId: "pay_rv", amountKrw: "700" });
  const r2 = purchase({ eventId: "ev_rv2", sourceEventId: "pay_rv", sourceRevision: 2, amountKrw: "500" });
  const r5 = purchase({ eventId: "ev_rv5", sourceEventId: "pay_rv", sourceRevision: 5, amountKrw: "900" });
  assert.equal((await db.tx((tx) => ingestRevenue(tx, clock, ingest, r1, hook, onRevision))).created, true);
  assert.deepEqual(revisions, [], "a first revision supersedes nothing");
  assert.deepEqual(await db.tx((tx) => ingestRevenue(tx, clock, ingest, r2, hook, onRevision)), { eventId: "ev_rv2", created: true });
  assert.deepEqual(await db.tx((tx) => ingestRevenue(tx, clock, ingest, r2, hook, onRevision)), { eventId: "ev_rv2", created: false });
  assert.deepEqual(await db.tx((tx) => ingestRevenue(tx, clock, ingest, r1, hook, onRevision)), { eventId: "ev_rv1", created: false });
  // 번호는 건너뛸 수 있다(더 높기만 하면 된다).
  assert.equal((await db.tx((tx) => ingestRevenue(tx, clock, ingest, r5, hook, onRevision))).created, true);
  assert.deepEqual(revisions, ["ev_rv2", "ev_rv5"]);
  assert.deepEqual(refunds, []);
  const s = await db.pool.query("SELECT old_event_id, new_event_id FROM revenue_supersede WHERE new_event_id LIKE 'ev_rv%' ORDER BY old_event_id");
  assert.deepEqual(s.rows.map((r) => [r.old_event_id, r.new_event_id]), [["ev_rv1", "ev_rv2"], ["ev_rv2", "ev_rv5"]]);
  // 최신보다 낮거나 같은 번호의 새 revision은 순서 역전이다.
  for (const rev of [3, 4]) {
    await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: `ev_rvx${rev}`, sourceEventId: "pay_rv", sourceRevision: rev }), hook, onRevision)),
      { code: "REVISION_OUT_OF_ORDER", status: 422 });
  }
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, { ...r5, amountKrw: "901" }, hook, onRevision)), { code: "IDEMPOTENCY_MISMATCH", status: 409 });
});

test("a revision must keep the type and vc; refunds on the latest revision block it; superseded events take no refunds", async () => {
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_m1", sourceEventId: "pay_m", amountKrw: "1000" })));
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_m2", sourceEventId: "pay_m", sourceRevision: 2, eventType: "RESALE" }))),
    { code: "REVISION_MISMATCH", status: 422 });
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_m2", sourceEventId: "pay_m", sourceRevision: 2, vcId: "vc_other" }))),
    { code: "REVISION_MISMATCH", status: 422 });
  const refund = (id: string, relatedEventId: string, over: Partial<RevenueInput> = {}): RevenueInput => ({
    eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "REFUND", relatedEventId, amountKrw: "10", currency: "KRW", occurredAt: "2026-03-02T00:00:00.000Z", ...over,
  });
  // 환불 revision은 받지 않는다(환불은 원 이벤트를 따르므로 대체 대상이 아니다).
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("rf_m0", "ev_m1")));
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("rf_m0b", "ev_m1", { sourceEventId: "rf_m0", sourceRevision: 2 }))),
    { code: "REVISION_MISMATCH", status: 422 });
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_m2", sourceEventId: "pay_m", sourceRevision: 2, amountKrw: "900" }))),
    { code: "REVISION_HAS_REFUNDS", status: 422 });
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_n1", sourceEventId: "pay_n", amountKrw: "1000" })));
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_n2", sourceEventId: "pay_n", sourceRevision: 2, amountKrw: "800" })));
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("rf_n1", "ev_n1"))), { code: "EVENT_SUPERSEDED", status: 422 });
  assert.equal((await db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("rf_n2", "ev_n2")))).created, true, "the live revision is refundable");
  // 새 revision에 환불이 생기면 그 revision도 더는 대체할 수 없다.
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_n3", sourceEventId: "pay_n", sourceRevision: 3 }))),
    { code: "REVISION_HAS_REFUNDS", status: 422 });
});

test("concurrent deliveries of the same revision record one supersede and call the hook once", async () => {
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_rc1", sourceEventId: "pay_rc" })));
  const revisions: string[] = [];
  const onRevision = async (_tx: unknown, id: string) => { revisions.push(id); };
  const rs = await Promise.all([1, 2].map(() => db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_rc2", sourceEventId: "pay_rc", sourceRevision: 2, amountKrw: "1" }), noRefundHook, onRevision))));
  assert.deepEqual(rs.map((r) => r.created).sort(), [false, true]);
  assert.deepEqual(revisions, ["ev_rc2"]);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM revenue_supersede WHERE old_event_id = 'ev_rc1'")).rows[0].n, 1);
  // 같은 revision의 다른 내용 두 개가 동시에 오면 하나는 409다.
  const ms = await Promise.allSettled([["ev_rc3a", "5"], ["ev_rc3b", "6"]].map(([id, amt]) =>
    db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: id!, sourceEventId: "pay_rc", sourceRevision: 3, amountKrw: amt! }), noRefundHook, onRevision))));
  assert.deepEqual(ms.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(((ms.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).code, "IDEMPOTENCY_MISMATCH");
});

test("supersede rows are immutable", async () => {
  await assert.rejects(db.pool.query("UPDATE revenue_supersede SET recorded_at = recorded_at"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM revenue_supersede"), /append-only|permission denied/);
});

test("non-object input is INVALID_REVENUE, not a TypeError", async () => {
  for (const body of [null, undefined, "x", 5, []]) {
    await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, body as never)), { code: "INVALID_REVENUE", status: 422 });
  }
});
