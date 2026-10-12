import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { cursorKey, pageOf, ts, type Page } from "../platform/paging.ts";

const RUN_STATUSES = ["PENDING", "CALCULATED", "VERIFIED", "FAILED", "VOIDED", "CONFIRMED"] as const;

/** 매출 이벤트가 걸린 정산 상태(revenue는 settlement를 모르므로 여기서 SQL로 읽는다). 이벤트가 없으면 404. */
export async function revenueEventSettlement(tx: Tx, eventId: string) {
  const e = await tx.query("SELECT 1 FROM revenue_event WHERE event_id = $1", [eventId]);
  if (e.rowCount === 0) throw notFound("revenue event", eventId);
  const runs = (await tx.query(
    `SELECT r.run_id, r.batch_id, r.status FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id WHERE x.event_id = $1 ORDER BY r.run_id`, [eventId],
  )).rows;
  const reversals = (await tx.query("SELECT reversal_id, created_at FROM reversal_run WHERE event_id = $1 ORDER BY sequence, reversal_id", [eventId])).rows;
  const refunds = (await tx.query("SELECT event_id, net_amount_krw FROM revenue_event WHERE related_event_id = $1 ORDER BY event_id", [eventId])).rows;
  return {
    runs: runs.map((r) => ({ runId: r.run_id as string, batchId: r.batch_id as string, status: r.status as string })),
    reversals: reversals.map((r) => ({ reversalId: r.reversal_id as string, createdAt: ts(r.created_at)! })),
    refunds: refunds.map((r) => ({ eventId: r.event_id as string, netAmountKrw: String(r.net_amount_krw) })),
  };
}

/** created_at DESC, batch_id ASC. runCounts는 필터와 무관하게 배치의 전체 run 수다. */
export async function listBatches(tx: Tx, f: { status?: string }, page: Page) {
  const after = cursorKey(page, ["t", "s"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.status !== undefined) { p.push(f.status); w.push(`b.status = $${p.length}`); }
  if (after) {
    p.push(after[0], after[1]);
    w.push(`(b.created_at < $${p.length - 1}::timestamptz OR (b.created_at = $${p.length - 1}::timestamptz AND b.batch_id > $${p.length}))`);
  }
  p.push(page.limit + 1);
  const counts = RUN_STATUSES.map((s) => `count(*) FILTER (WHERE r.status = '${s}')::int AS "${s}"`).join(", ");
  const rows = (await tx.query(
    `SELECT b.*, c.* FROM settlement_batch b
       CROSS JOIN LATERAL (SELECT ${counts} FROM settlement_run r WHERE r.batch_id = b.batch_id) c
      ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY b.created_at DESC, b.batch_id LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    batchId: r.batch_id as string, periodStart: ts(r.period_start)!, periodEnd: ts(r.period_end)!, status: r.status as string,
    executedBy: r.executed_by as string, createdAt: ts(r.created_at)!, confirmedBy: r.confirmed_by as string | null,
    confirmedAt: ts(r.confirmed_at), batchManifestDigest: r.batch_manifest_digest as string | null,
    runCounts: Object.fromEntries(RUN_STATUSES.map((s) => [s, r[s] as number])) as Record<(typeof RUN_STATUSES)[number], number>,
  })), page, (r) => [r.createdAt, r.batchId]);
}

/** run_id ASC. 배치가 없으면 404. eventCount는 settlement_run_event 행 수(batchView와 같다). */
export async function listBatchRuns(tx: Tx, batchId: string, f: { status?: string }, page: Page) {
  const after = cursorKey(page, ["s"]);
  const b = await tx.query("SELECT 1 FROM settlement_batch WHERE batch_id = $1", [batchId]);
  if (b.rowCount === 0) throw notFound("batch", batchId);
  const p: unknown[] = [batchId];
  const w: string[] = ["r.batch_id = $1"];
  if (f.status !== undefined) { p.push(f.status); w.push(`r.status = $${p.length}`); }
  if (after) { p.push(after[0]); w.push(`r.run_id > $${p.length}`); }
  p.push(page.limit + 1);
  const rows = (await tx.query(
    `SELECT r.*, (SELECT count(*) FROM settlement_run_event e WHERE e.run_id = r.run_id)::int AS event_count
       FROM settlement_run r WHERE ${w.join(" AND ")} ORDER BY r.run_id LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    runId: r.run_id as string, batchId: r.batch_id as string, snapshotId: r.snapshot_id as string, status: r.status as string,
    eventsDigest: r.events_digest as string | null, resultDigest: r.result_digest as string | null, diagnostics: r.diagnostics as unknown,
    executedBy: r.executed_by as string, verifiedBy: r.verified_by as string | null, verifiedAt: ts(r.verified_at), createdAt: ts(r.created_at)!,
    eventCount: r.event_count as number,
  })), page, (r) => [r.runId]);
}

/** quarantine_id DESC. open=true면 풀리지 않은 격리만, false면 풀린 것만. */
export async function listQuarantine(tx: Tx, f: { open?: boolean }, page: Page) {
  const after = cursorKey(page, ["n"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.open !== undefined) w.push(f.open ? "released_at IS NULL" : "released_at IS NOT NULL");
  if (after) { p.push(after[0]); w.push(`quarantine_id < $${p.length}::bigint`); }
  p.push(page.limit + 1);
  const rows = (await tx.query(`SELECT * FROM quarantine ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY quarantine_id DESC LIMIT $${p.length}`, p)).rows;
  return pageOf(rows.map((r) => ({
    quarantineId: Number(r.quarantine_id), snapshotId: r.snapshot_id as string, reason: r.reason as string, diagnostics: r.diagnostics as unknown,
    createdAt: ts(r.created_at)!, releasedBy: r.released_by as string | null, releasedAt: ts(r.released_at),
  })), page, (r) => [r.quarantineId]);
}

/** holding_id DESC. release는 hold_release(보류당 최대 1건). */
export async function listHolds(tx: Tx, f: { status?: string; reason?: string }, page: Page) {
  const after = cursorKey(page, ["n"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.status !== undefined) { p.push(f.status); w.push(`h.status = $${p.length}`); }
  if (f.reason !== undefined) { p.push(f.reason); w.push(`h.reason = $${p.length}`); }
  if (after) { p.push(after[0]); w.push(`h.holding_id < $${p.length}::bigint`); }
  p.push(page.limit + 1);
  const rows = (await tx.query(
    `SELECT h.*, r.release_id, r.released_by, r.released_at FROM unallocated_holding h LEFT JOIN hold_release r ON r.holding_id = h.holding_id
      ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY h.holding_id DESC LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    holdingId: Number(r.holding_id), runId: r.run_id as string, eventId: r.event_id as string, bucket: r.bucket as string,
    reason: r.reason as string, lineSeq: r.line_seq as number, amountKrw: String(r.amount_krw), reversalId: r.reversal_id as string | null,
    status: r.status as string,
    release: r.release_id === null ? null : { releaseId: Number(r.release_id), releasedBy: r.released_by as string, releasedAt: ts(r.released_at)! },
  })), page, (r) => [r.holdingId]);
}

/** created_at DESC, reversal_id ASC. */
export async function listReversals(tx: Tx, page: Page) {
  const after = cursorKey(page, ["t", "s"]);
  const p: unknown[] = [];
  let where = "";
  if (after) {
    p.push(after[0], after[1]);
    where = `WHERE (created_at < $1::timestamptz OR (created_at = $1::timestamptz AND reversal_id > $2))`;
  }
  p.push(page.limit + 1);
  const rows = (await tx.query(`SELECT * FROM reversal_run ${where} ORDER BY created_at DESC, reversal_id LIMIT $${p.length}`, p)).rows;
  return pageOf(rows.map((r) => ({
    reversalId: r.reversal_id as string, originalRunId: r.original_run_id as string, eventId: r.event_id as string, sequence: r.sequence as number,
    refundEventId: r.refund_event_id as string, resultDigest: r.result_digest as string, createdAt: ts(r.created_at)!,
  })), page, (r) => [r.createdAt, r.reversalId]);
}
