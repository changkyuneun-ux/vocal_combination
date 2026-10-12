import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { cursorKey, pageOf, ts, type Page } from "../platform/paging.ts";

/** account_id ASC. balance는 전기 합(문자열). 정렬과 커서 비교는 COLLATE "C"로 맞춘다. */
export async function listAccounts(tx: Tx, page: Page) {
  const after = cursorKey(page, ["s"]);
  const p: unknown[] = [];
  let where = "";
  if (after) { p.push(after[0]); where = `WHERE a.account_id COLLATE "C" > $1 COLLATE "C"`; }
  p.push(page.limit + 1);
  const rows = (await tx.query(
    `SELECT a.*, COALESCE((SELECT SUM(amount_krw) FROM posting x WHERE x.account_id = a.account_id), 0)::text AS balance
       FROM ledger_account a ${where} ORDER BY a.account_id COLLATE "C" LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    accountId: r.account_id as string, kind: r.kind as string, partyId: r.party_id as string | null, reason: r.reason as string | null,
    bucket: r.bucket as string | null, balance: r.balance as string,
  })), page, (r) => [r.accountId]);
}

const entryOut = (r: Record<string, any>) => ({
  entryId: Number(r.entry_id), kind: r.kind as string, sourceRef: r.source_ref as string, occurredAt: ts(r.occurred_at)!,
  createdBy: r.created_by as string, total: r.total as string,
});

/** entry_id DESC. total은 분개 전체의 차변(양수 전기) 합이라 account·party 필터와 무관하다. */
export async function listEntries(tx: Tx, f: { kind?: string; account?: string; party?: string }, page: Page) {
  const after = cursorKey(page, ["n"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.kind !== undefined) { p.push(f.kind); w.push(`e.kind = $${p.length}`); }
  if (f.account !== undefined) { p.push(f.account); w.push(`EXISTS (SELECT 1 FROM posting x WHERE x.entry_id = e.entry_id AND x.account_id = $${p.length})`); }
  if (f.party !== undefined) {
    p.push(f.party);
    w.push(`EXISTS (SELECT 1 FROM posting x JOIN ledger_account a ON a.account_id = x.account_id WHERE x.entry_id = e.entry_id AND a.party_id = $${p.length})`);
  }
  if (after) { p.push(after[0]); w.push(`e.entry_id < $${p.length}::bigint`); }
  p.push(page.limit + 1);
  const rows = (await tx.query(
    `SELECT e.*, COALESCE((SELECT SUM(amount_krw) FROM posting x WHERE x.entry_id = e.entry_id AND x.amount_krw > 0), 0)::text AS total
       FROM journal_entry e ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY e.entry_id DESC LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map(entryOut), page, (r) => [r.entryId]);
}

/** 분개 한 건과 전기들(posting_id 순). id가 정수가 아니거나 없으면 404. */
export async function getEntry(tx: Tx, id: string) {
  if (!/^[0-9]{1,15}$/.test(id)) throw notFound("journal entry", id);
  const e = (await tx.query(
    `SELECT e.*, COALESCE((SELECT SUM(amount_krw) FROM posting x WHERE x.entry_id = e.entry_id AND x.amount_krw > 0), 0)::text AS total
       FROM journal_entry e WHERE e.entry_id = $1::bigint`, [id],
  )).rows[0];
  if (e === undefined) throw notFound("journal entry", id);
  const postings = (await tx.query("SELECT * FROM posting WHERE entry_id = $1::bigint ORDER BY posting_id", [id])).rows;
  return {
    ...entryOut(e),
    postings: postings.map((r) => ({
      postingId: Number(r.posting_id), accountId: r.account_id as string, amountKrw: String(r.amount_krw),
      eventId: r.event_id as string | null, runId: r.run_id as string | null,
    })),
  };
}
