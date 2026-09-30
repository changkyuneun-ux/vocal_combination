import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { lockBatching } from "../platform/locks.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";

export type RevenueType = "PURCHASE" | "RESALE" | "REFUND";
export type RevenueInput = {
  eventId: string; sourceSystem: string; sourceEventId: string; sourceRevision?: number; eventType: RevenueType;
  vcId?: string; relatedEventId?: string; amountKrw: string; currency: "KRW"; integrity?: "CLEAR" | "FLAGGED"; occurredAt: string;
};
export type RevenueRow = RevenueInput & { sourceRevision: number; integrity: "CLEAR" | "FLAGGED"; recordedAt: string };
export type RefundHook = (tx: Tx, refundEventId: string) => Promise<void>;
/** 환불 후속 작업이 필요 없는 호출자를 위한 명시적 no-op. */
export const noRefundHook: RefundHook = async () => {};
export type RevisionHook = (tx: Tx, newEventId: string) => Promise<void>;
/** 대체 후속 작업이 필요 없는 호출자를 위한 명시적 no-op. */
export const noRevisionHook: RevisionHook = async () => {};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AMOUNT = /^[1-9]\d*$/;
const bad = (m: string) => invalid("INVALID_REVENUE", m);

const ID = /^[A-Za-z0-9._-]+$/;
const isId = (v: unknown) => typeof v === "string" && ID.test(v);

function validate(i: RevenueInput): void {
  if (typeof i !== "object" || i === null || Array.isArray(i)) throw bad("body must be a JSON object");
  if (!isId(i.eventId)) throw bad(`eventId must match ${ID}`);
  for (const k of ["sourceSystem", "sourceEventId"] as const) if (typeof i[k] !== "string" || i[k].length < 1 || i[k].length > 200) throw bad(`${k} must be a non-empty string of at most 200 characters`);
  for (const k of ["vcId", "relatedEventId"] as const) if (i[k] !== undefined && !isId(i[k])) throw bad(`${k} must match ${ID}`);
  if (i.sourceRevision !== undefined && !(Number.isSafeInteger(i.sourceRevision) && i.sourceRevision >= 1)) throw bad("sourceRevision must be a positive safe integer");
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
 * source_revision 대체(11.2-11): 같은 source 이벤트의 더 높은 revision은 최신 revision을 대체한다 — 같은 유형·같은 vc_id(422 REVISION_MISMATCH,
 * 환불의 revision은 받지 않는다), 최신 revision에 환불이 없어야 한다(422 REVISION_HAS_REFUNDS). 낮거나 같은 번호의 새 revision은 422 REVISION_OUT_OF_ORDER.
 * 새로 기록된 대체에만 revenue_supersede를 남기고 onRevision을 호출한다.
 * 환불은 배치 잠금(SHARED)을 잡고, 원 이벤트별 advisory lock으로 직렬화하고, 대체된 원 이벤트는 거부(422 EVENT_SUPERSEDED)하고,
 * 누적 ≤ 원 금액을 강제한 뒤, 새로 기록된 경우에만 onRefund를 호출한다.
 */
export async function ingestRevenue(
  tx: Tx, clock: Clock, actor: Actor, input: RevenueInput, onRefund: RefundHook, onRevision: RevisionHook,
): Promise<{ eventId: string; created: boolean }> {
  requireRole(actor, "SYSTEM");
  validate(input);
  const revision = input.sourceRevision ?? 1;
  // 잠금은 revision을 뺀 source 키로 잡는다: 같은 source 이벤트의 다른 revision 동시 수집도 직렬화해야 아래 판단이 성립한다.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('rev:' || $1, 0))", [JSON.stringify([input.sourceSystem, input.sourceEventId])]);
  const recorded = (await tx.query(
    "SELECT * FROM revenue_event WHERE source_system = $1 AND source_event_id = $2 ORDER BY source_revision",
    [input.sourceSystem, input.sourceEventId],
  )).rows;
  const existing = recorded.find((r) => r.source_revision === revision);
  if (existing !== undefined) {
    if (!samePayload(toRow(existing), input)) throw conflict("IDEMPOTENCY_MISMATCH", `source key ${input.sourceSystem}/${input.sourceEventId}/${revision} was recorded with different content`);
    return { eventId: existing.event_id, created: false };
  }
  const latest = recorded.length > 0 ? toRow(recorded[recorded.length - 1]) : undefined;
  if (latest !== undefined) {
    const key = `${input.sourceSystem}/${input.sourceEventId}`;
    if (revision <= latest.sourceRevision) {
      throw new DomainError("REVISION_OUT_OF_ORDER", 422, `source event ${key} is at revision ${latest.sourceRevision}; revision ${revision} is not newer`);
    }
    if (latest.eventType === "REFUND" || input.eventType === "REFUND") {
      throw new DomainError("REVISION_MISMATCH", 422, `source event ${key}: refunds follow their original and cannot be revised`);
    }
    if (latest.eventType !== input.eventType || latest.vcId !== input.vcId) {
      throw new DomainError("REVISION_MISMATCH", 422,
        `source event ${key} revision ${revision} (${input.eventType} ${input.vcId}) must keep the type and vc of revision ${latest.sourceRevision} (${latest.eventType} ${latest.vcId})`);
    }
    // 환불 수집과 같은 원 이벤트 잠금: 대체 판단과 그 이벤트에 대한 환불 기록을 직렬화한다.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('refund:' || $1, 0))", [latest.eventId]);
    if ((await refundedTotal(tx, latest.eventId)) > 0n) {
      throw new DomainError("REVISION_HAS_REFUNDS", 422, `revision ${latest.sourceRevision} of ${key} (${latest.eventId}) has refunds and cannot be superseded`);
    }
  }
  if (input.eventType === "REFUND") {
    // 진행 중인 배치 생성이 있으면 끝날 때까지 기다린다(환불은 배치 순액에 포함되거나, 배치 커밋 뒤에 기록된다).
    await lockBatching(tx, "SHARED");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('refund:' || $1, 0))", [input.relatedEventId]);
    const original = await revenueRow(tx, input.relatedEventId!);
    if (original.eventType === "REFUND") throw bad("a refund must reference a PURCHASE or RESALE");
    const successor = (await tx.query("SELECT new_event_id FROM revenue_supersede WHERE old_event_id = $1", [original.eventId])).rows[0];
    if (successor !== undefined) {
      throw new DomainError("EVENT_SUPERSEDED", 422, `${original.eventId} was superseded by ${successor.new_event_id}; refund the live revision instead`);
    }
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
  if (latest !== undefined) {
    await tx.query("INSERT INTO revenue_supersede (old_event_id, new_event_id, recorded_at) VALUES ($1,$2,$3)", [latest.eventId, input.eventId, clock.now()]);
    await audit(tx, clock, { actor: actor.userId, action: "REVENUE_SUPERSEDED", entityType: "revenue_event", entityId: latest.eventId, after: { by: input.eventId, revision } });
    await onRevision(tx, input.eventId);
  }
  if (input.eventType === "REFUND") await onRefund(tx, input.eventId);
  return { eventId: input.eventId, created: true };
}
