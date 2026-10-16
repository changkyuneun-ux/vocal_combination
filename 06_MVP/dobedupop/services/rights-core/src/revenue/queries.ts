import type { Tx } from "../platform/db.ts";
import { cursorKey, pageOf, ts, type Page } from "../platform/paging.ts";

/** recorded_at DESC, event_id ASC. recorded_at은 밀리초 CHECK가 있어 커서(ISO 밀리초)와 정확히 비교된다. supersededBy는 revenue_supersede의 새 이벤트. */
export async function listRevenueEvents(tx: Tx, f: { type?: string; vc?: string }, page: Page) {
  const after = cursorKey(page, ["t", "s"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.type !== undefined) { p.push(f.type); w.push(`e.event_type = $${p.length}`); }
  if (f.vc !== undefined) { p.push(f.vc); w.push(`e.vc_id = $${p.length}`); }
  if (after) {
    p.push(after[0], after[1]);
    w.push(`(e.recorded_at < $${p.length - 1}::timestamptz OR (e.recorded_at = $${p.length - 1}::timestamptz AND e.event_id > $${p.length}))`);
  }
  p.push(page.limit + 1);
  const rows = (await tx.query(
    `SELECT e.*, s.new_event_id AS superseded_by FROM revenue_event e LEFT JOIN revenue_supersede s ON s.old_event_id = e.event_id
      ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY e.recorded_at DESC, e.event_id LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    eventId: r.event_id as string, sourceSystem: r.source_system as string, sourceEventId: r.source_event_id as string,
    sourceRevision: r.source_revision as number, eventType: r.event_type as string, vcId: r.vc_id as string | null,
    relatedEventId: r.related_event_id as string | null, netAmountKrw: String(r.net_amount_krw), currency: (r.currency as string).trim(),
    integrityStatus: r.integrity_status as string, occurredAt: ts(r.occurred_at)!, recordedAt: ts(r.recorded_at)!,
    supersededBy: r.superseded_by as string | null,
  })), page, (r) => [r.recordedAt, r.eventId]);
}
