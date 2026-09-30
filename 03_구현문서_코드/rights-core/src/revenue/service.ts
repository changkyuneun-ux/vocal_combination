import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";

export type RevenueType = "PURCHASE" | "RESALE" | "REFUND";
export type RevenueInput = {
  eventId: string; sourceSystem: string; sourceEventId: string; sourceRevision?: number; eventType: RevenueType;
  vcId?: string; relatedEventId?: string; amountKrw: string; currency: "KRW"; integrity?: "CLEAR" | "FLAGGED"; occurredAt: string;
};
export type RevenueRow = RevenueInput & { sourceRevision: number; integrity: "CLEAR" | "FLAGGED"; recordedAt: string };
export type RefundHook = (tx: Tx, refundEventId: string) => Promise<void>;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AMOUNT = /^[1-9]\d*$/;
const bad = (m: string) => invalid("INVALID_REVENUE", m);

function validate(i: RevenueInput): void {
  if (!["PURCHASE", "RESALE", "REFUND"].includes(i.eventType)) throw bad(`eventType ${String(i.eventType)}`);
  if (typeof i.amountKrw !== "string" || !AMOUNT.test(i.amountKrw)) throw bad("amountKrw must be a positive integer string");
  if (i.currency !== "KRW") throw bad("only KRW is supported");
  if (typeof i.occurredAt !== "string" || !INSTANT.test(i.occurredAt) || new Date(i.occurredAt).toISOString() !== i.occurredAt) throw bad("occurredAt must be ms UTC ISO");
  if (i.integrity !== undefined && i.integrity !== "CLEAR" && i.integrity !== "FLAGGED") throw bad("integrity");
  if (i.eventType === "REFUND") {
    if (i.relatedEventId === undefined) throw bad("refund requires relatedEventId");
    if (i.vcId !== undefined) throw bad("refund must not carry vcId (it follows the original)");
  } else {
    if (i.vcId === undefined) throw bad(`${i.eventType} requires vcId`);
    if (i.relatedEventId !== undefined) throw bad(`${i.eventType} must not carry relatedEventId`);
  }
}

function toRow(r: any): RevenueRow {
  return {
    eventId: r.event_id, sourceSystem: r.source_system, sourceEventId: r.source_event_id, sourceRevision: r.source_revision,
    eventType: r.event_type, amountKrw: String(r.net_amount_krw), currency: r.currency, integrity: r.integrity_status,
    occurredAt: iso(r.occurred_at)!, recordedAt: iso(r.recorded_at)!,
    ...(r.vc_id !== null && { vcId: r.vc_id }), ...(r.related_event_id !== null && { relatedEventId: r.related_event_id }),
  };
}

export async function revenueRow(tx: Tx, eventId: string): Promise<RevenueRow> {
  const r = (await tx.query("SELECT * FROM revenue_event WHERE event_id = $1", [eventId])).rows[0];
  if (r === undefined) throw notFound("revenue event", eventId);
  return toRow(r);
}

export async function refundedTotal(tx: Tx, originalEventId: string): Promise<bigint> {
  const r = await tx.query("SELECT COALESCE(SUM(net_amount_krw), 0)::text AS s FROM revenue_event WHERE related_event_id = $1", [originalEventId]);
  return BigInt(r.rows[0].s);
}

const samePayload = (a: RevenueRow, b: RevenueInput) =>
  a.eventId === b.eventId && a.eventType === b.eventType && a.amountKrw === b.amountKrw && a.currency === b.currency &&
  a.occurredAt === b.occurredAt && a.integrity === (b.integrity ?? "CLEAR") && a.vcId === b.vcId && a.relatedEventId === b.relatedEventId;

/**
 * 멱등 수집(통합 설계 10.2-2): 같은 source 키·같은 내용이면 기존 id, 다른 내용이면 409.
 * 환불은 원 이벤트별 advisory lock으로 직렬화하고 누적 ≤ 원 금액을 강제한 뒤, 새로 기록된 경우에만 onRefund를 호출한다.
 */
export async function ingestRevenue(tx: Tx, clock: Clock, actor: Actor, input: RevenueInput, onRefund?: RefundHook): Promise<{ eventId: string; created: boolean }> {
  requireRole(actor, "SYSTEM");
  validate(input);
  const revision = input.sourceRevision ?? 1;
  const existing = (await tx.query(
    "SELECT * FROM revenue_event WHERE source_system = $1 AND source_event_id = $2 AND source_revision = $3",
    [input.sourceSystem, input.sourceEventId, revision],
  )).rows[0];
  if (existing !== undefined) {
    if (!samePayload(toRow(existing), input)) throw conflict("IDEMPOTENCY_MISMATCH", `source key ${input.sourceSystem}/${input.sourceEventId}/${revision} was recorded with different content`);
    return { eventId: existing.event_id, created: false };
  }
  if (input.eventType === "REFUND") {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('refund:' || $1, 0))", [input.relatedEventId]);
    const original = await revenueRow(tx, input.relatedEventId!);
    if (original.eventType === "REFUND") throw bad("a refund must reference a PURCHASE or RESALE");
    const total = (await refundedTotal(tx, original.eventId)) + BigInt(input.amountKrw);
    if (total > BigInt(original.amountKrw)) {
      throw new DomainError("REFUND_EXCEEDS_ORIGINAL", 422, `refunds ${total} exceed original ${original.amountKrw} of ${original.eventId}`);
    }
  }
  await tx.query(
    `INSERT INTO revenue_event (event_id, source_system, source_event_id, source_revision, event_type, vc_id, related_event_id,
       net_amount_krw, currency, integrity_status, occurred_at, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [input.eventId, input.sourceSystem, input.sourceEventId, revision, input.eventType, input.vcId ?? null, input.relatedEventId ?? null,
      input.amountKrw, input.currency, input.integrity ?? "CLEAR", input.occurredAt, clock.now()],
  );
  await audit(tx, clock, { actor: actor.userId, action: "REVENUE_RECORDED", entityType: "revenue_event", entityId: input.eventId, after: { type: input.eventType, amount: input.amountKrw } });
  if (input.eventType === "REFUND" && onRefund !== undefined) await onRefund(tx, input.eventId);
  return { eventId: input.eventId, created: true };
}
