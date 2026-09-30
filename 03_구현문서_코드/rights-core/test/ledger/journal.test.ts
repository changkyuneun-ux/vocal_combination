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
