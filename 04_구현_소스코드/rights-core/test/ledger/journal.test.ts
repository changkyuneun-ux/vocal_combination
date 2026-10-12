import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { balance, postEntry, trialBalance } from "../../src/ledger/journal.ts";
import { accountId, poolAccountFor } from "../../src/ledger/accounts.ts";

const { db, adminUrl, drop } = await freshDb();
after(drop);
const clock = fixedClock("2026-04-01T00:00:00.000Z", 1);
// PARTY_PAYABLE 계정은 party를 참조한다.
await db.pool.query("INSERT INTO party (party_id, party_type, display_name, created_at) VALUES ('pty_a','ARTIST','A','2026-01-01T00:00:00.000Z')");

test("accounts have deterministic ids and tier1 buckets map to pool accounts", () => {
  assert.equal(accountId({ kind: "PARTY_PAYABLE", partyId: "pty_a" }), "PARTY_PAYABLE:pty_a");
  assert.equal(accountId({ kind: "HOLD", reason: "FRAUD_REVIEW" }), "HOLD:FRAUD_REVIEW");
  assert.deepEqual(poolAccountFor("platform"), { kind: "POOL_PLATFORM" });
  assert.deepEqual(poolAccountFor("ops"), { kind: "POOL_OPS" });
  assert.deepEqual(poolAccountFor("fan"), { kind: "POOL_FAN" });
  assert.deepEqual(poolAccountFor("marketing"), { kind: "POOL_OTHER", bucket: "marketing" });
});

test("a balanced entry posts once per source_ref; balances are sums", async () => {
  const e = { kind: "ADJUSTMENT" as const, sourceRef: "adj:1", createdBy: "sys_settler", postings: [
    { account: { kind: "RECEIVABLE" as const }, amount: 1000n },
    { account: { kind: "PARTY_PAYABLE" as const, partyId: "pty_a" }, amount: -700n },
    { account: { kind: "POOL_PLATFORM" as const }, amount: -300n },
    { account: { kind: "POOL_OPS" as const }, amount: 0n },
  ] };
  const first = await db.tx((tx) => postEntry(tx, clock, e));
  assert.equal(first.created, true);
  const again = await db.tx((tx) => postEntry(tx, clock, e));
  assert.deepEqual(again, { entryId: first.entryId, created: false });
  assert.equal(await db.tx((tx) => balance(tx, { kind: "PARTY_PAYABLE", partyId: "pty_a" })), -700n);
  const n = await db.pool.query("SELECT count(*)::int AS n FROM posting WHERE entry_id = $1", [first.entryId]);
  assert.equal(n.rows[0].n, 3, "zero-amount postings are not written");
  const tb = await db.tx((tx) => trialBalance(tx));
  assert.equal(tb.reduce((a, r) => a + r.balance, 0n), 0n);
});

test("unbalanced entries are rejected by the service and by the deferred trigger", async () => {
  await assert.rejects(db.tx((tx) => postEntry(tx, clock, { kind: "ADJUSTMENT", sourceRef: "adj:bad", createdBy: "x", postings: [
    { account: { kind: "RECEIVABLE" }, amount: 5n }, { account: { kind: "CASH" }, amount: -4n },
  ] })), { code: "LEDGER_UNBALANCED", status: 422 });
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: (db.pool as any).options.connectionString });
  await c.connect();
  try {
    await c.query("BEGIN");
    const id = (await c.query("INSERT INTO journal_entry (kind, source_ref, occurred_at, created_by) VALUES ('ADJUSTMENT','adj:raw',now()::timestamptz(3),'x') RETURNING entry_id")).rows[0].entry_id;
    await c.query("INSERT INTO ledger_account (account_id, kind) VALUES ('CASH','CASH') ON CONFLICT DO NOTHING");
    await c.query("INSERT INTO posting (entry_id, account_id, amount_krw) VALUES ($1,'CASH',5)", [id]);
    await assert.rejects(c.query("COMMIT"), /RC001|unbalanced/);
  } finally {
    await c.end();
  }
  void adminUrl;
});

test("journal rows are immutable", async () => {
  await assert.rejects(db.pool.query("UPDATE posting SET amount_krw = 0"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM journal_entry"), /append-only|permission denied/);
});

test("the balance trigger checks each entry once: a 2000-posting entry commits quickly, unbalanced ones still fail", async () => {
  const postings = Array.from({ length: 2000 }, (_, i) => ({ account: { kind: i % 2 === 0 ? "RECEIVABLE" as const : "CASH" as const }, amount: i % 2 === 0 ? 1n : -1n }));
  const t0 = Date.now();
  const r = await db.tx((tx) => postEntry(tx, clock, { kind: "ADJUSTMENT", sourceRef: "adj:big", createdBy: "x", postings }));
  const ms = Date.now() - t0;
  assert.equal(r.created, true);
  assert.ok(ms < 3000, `2000-posting entry took ${ms}ms`);
  const n = await db.pool.query("SELECT count(*)::int AS n FROM posting WHERE entry_id = $1", [r.entryId]);
  assert.equal(n.rows[0].n, 2000);

  // 같은 트랜잭션의 균형 분개와 불균형 분개: 분개마다 따로 검사된다.
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN");
    const ok = (await c.query("INSERT INTO journal_entry (kind, source_ref, occurred_at, created_by) VALUES ('ADJUSTMENT','adj:raw-ok',now()::timestamptz(3),'x') RETURNING entry_id")).rows[0].entry_id;
    await c.query("INSERT INTO posting (entry_id, account_id, amount_krw) SELECT $1, CASE WHEN g % 2 = 0 THEN 'RECEIVABLE' ELSE 'CASH' END, CASE WHEN g % 2 = 0 THEN 1 ELSE -1 END FROM generate_series(1, 2000) g", [ok]);
    const bad = (await c.query("INSERT INTO journal_entry (kind, source_ref, occurred_at, created_by) VALUES ('ADJUSTMENT','adj:raw-bad',now()::timestamptz(3),'x') RETURNING entry_id")).rows[0].entry_id;
    await c.query("INSERT INTO posting (entry_id, account_id, amount_krw) SELECT $1, CASE WHEN g % 2 = 0 THEN 'RECEIVABLE' ELSE 'CASH' END, CASE WHEN g % 2 = 0 THEN 1 ELSE -1 END FROM generate_series(1, 2001) g", [bad]);
    await assert.rejects(c.query("COMMIT"), /RC001|unbalanced/);
  } finally {
    c.release();
  }
  const leaked = await db.pool.query("SELECT count(*)::int AS n FROM journal_entry WHERE source_ref LIKE 'adj:raw-%'");
  assert.equal(leaked.rows[0].n, 0);
});

test("concurrent postEntry with the same source_ref: one creates, the other returns it (no 23505)", async () => {
  const e = { kind: "ADJUSTMENT" as const, sourceRef: "adj:race", createdBy: "x", postings: [
    { account: { kind: "RECEIVABLE" as const }, amount: 7n }, { account: { kind: "CASH" as const }, amount: -7n },
  ] };
  const a = await db.pool.connect();
  const b = await db.pool.connect();
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");
    const ra = await postEntry(a, clock, e);
    const pb = postEntry(b, clock, e);   // a가 커밋할 때까지 INSERT에서 대기
    await new Promise((res) => setTimeout(res, 100));
    await a.query("COMMIT");
    const rb = await pb;
    await b.query("COMMIT");
    assert.equal(ra.created, true);
    assert.deepEqual(rb, { entryId: ra.entryId, created: false });
  } finally {
    a.release();
    b.release();
  }
  const n = await db.pool.query("SELECT count(*)::int AS n FROM posting p JOIN journal_entry j USING (entry_id) WHERE j.source_ref = 'adj:race'");
  assert.equal(n.rows[0].n, 2);
});
