import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { accountId, ensureAccounts, type AccountKey, type AccountKind } from "./accounts.ts";

export type EntryKind = "SETTLEMENT" | "REVERSAL" | "HOLD_RELEASE" | "PAYOUT" | "PAYOUT_SETTLED" | "PAYOUT_FAILED" | "ADJUSTMENT";
export type PostingInput = { account: AccountKey; amount: bigint; eventId?: string; runId?: string };

/**
 * 분개(통합 설계 11.2-2): 같은 source_ref면 기존 분개를 돌려준다(멱등). 합 ≠ 0이면 422.
 * 동시에 같은 source_ref를 쓰면 ON CONFLICT로 한쪽만 만들고, 다른 쪽은 기존 분개를 돌려준다(23505 없음).
 */
export async function postEntry(tx: Tx, clock: Clock, e: { kind: EntryKind; sourceRef: string; createdBy: string; postings: PostingInput[] }) {
  const existing = (await tx.query("SELECT entry_id FROM journal_entry WHERE source_ref = $1", [e.sourceRef])).rows[0];
  if (existing !== undefined) return { entryId: String(existing.entry_id), created: false };
  const postings = e.postings.filter((p) => p.amount !== 0n);
  const sum = postings.reduce((a, p) => a + p.amount, 0n);
  if (sum !== 0n) throw new DomainError("LEDGER_UNBALANCED", 422, `entry ${e.sourceRef} sums to ${sum}`);
  const ins = (await tx.query(
    "INSERT INTO journal_entry (kind, source_ref, occurred_at, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (source_ref) DO NOTHING RETURNING entry_id",
    [e.kind, e.sourceRef, clock.now(), e.createdBy])).rows[0];
  if (ins === undefined) {
    const other = (await tx.query("SELECT entry_id FROM journal_entry WHERE source_ref = $1", [e.sourceRef])).rows[0];
    return { entryId: String(other.entry_id), created: false };
  }
  const id = ins.entry_id;
  await ensureAccounts(tx, postings.map((p) => p.account));
  if (postings.length > 0) {
    await tx.query(
      `INSERT INTO posting (entry_id, account_id, amount_krw, event_id, run_id)
       SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::text[])`,
      [id, postings.map((p) => accountId(p.account)), postings.map((p) => p.amount.toString()),
        postings.map((p) => p.eventId ?? null), postings.map((p) => p.runId ?? null)],
    );
  }
  return { entryId: String(id), created: true };
}

export async function balance(tx: Tx, k: AccountKey, until?: string): Promise<bigint> {
  const r = await tx.query(
    `SELECT COALESCE(SUM(p.amount_krw), 0)::text AS s FROM posting p JOIN journal_entry j USING (entry_id)
      WHERE p.account_id = $1 AND ($2::timestamptz IS NULL OR j.occurred_at < $2)`, [accountId(k), until ?? null]);
  return BigInt(r.rows[0].s);
}

export async function trialBalance(tx: Tx): Promise<{ accountId: string; kind: AccountKind; balance: bigint }[]> {
  const r = await tx.query(
    "SELECT a.account_id, a.kind, COALESCE(SUM(p.amount_krw), 0)::text AS s FROM ledger_account a LEFT JOIN posting p USING (account_id) GROUP BY a.account_id, a.kind ORDER BY a.account_id");
  return r.rows.map((x) => ({ accountId: x.account_id, kind: x.kind, balance: BigInt(x.s) }));
}
