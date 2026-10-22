import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, invalid, notFound } from "../platform/errors.ts";
import { postEntry, type PostingInput } from "../ledger/journal.ts";
import { postConfirmedRun } from "./posting.ts";
import type { SettleDeps } from "./service.ts";
import { requirePermission } from "../platform/permissions.ts";

const AMOUNT = /^[1-9]\d{0,17}$/;

/** 원 보류(line_seq = 1)와 그 보류의 역분개 행 합(음수)을 더한 남은 보류액. */
export async function remainingHold(tx: Tx, h: { runId: string; eventId: string; bucket: string; reason: string; amount: bigint }): Promise<bigint> {
  const r = (await tx.query(
    "SELECT COALESCE(SUM(amount_krw), 0)::text AS s FROM unallocated_holding WHERE run_id = $1 AND event_id = $2 AND bucket = $3 AND reason = $4 AND line_seq > 1",
    [h.runId, h.eventId, h.bucket, h.reason])).rows[0];
  return h.amount + BigInt(r.s);
}

/**
 * 보류 해제(통합 설계 11.2-5, settlement.operate): 확정 run의 원 보류를 운영자가 지정한 권리자별 배분으로 미지급금에 옮긴다.
 * 배분 합 = 남은 보류액(원 보류액 + 그 보류의 역분개 합). 분개 HOLD_RELEASE(source_ref = hold:<holding_id>).
 * 원 이벤트의 run_event 행을 잠가 같은 이벤트의 역분개(reverse-event도 이 행을 잠근다)와 직렬화한다.
 */
export async function releaseHold(d: SettleDeps, actor: Actor, input: { holdingId: string; allocation: Record<string, string> }) {
  requirePermission(actor, "settlement.operate");
  const entries = Object.entries(input.allocation).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [party, amt] of entries) {
    if (typeof amt !== "string" || !AMOUNT.test(amt)) throw invalid("INVALID_AMOUNT", `allocation for ${party} must be a positive integer string`);
  }
  if (!/^\d{1,18}$/.test(input.holdingId)) throw notFound("hold", input.holdingId);
  return d.db.tx(async (tx) => {
    const h = (await tx.query(
      `SELECT h.run_id, h.event_id, h.bucket, h.reason, h.line_seq, h.amount_krw::text AS a, r.status
         FROM unallocated_holding h JOIN settlement_run r USING (run_id) WHERE h.holding_id = $1`, [input.holdingId])).rows[0];
    if (h === undefined || h.line_seq !== 1) throw notFound("hold", input.holdingId);
    // CONFIRMED는 끝 상태(0011 가드)이므로 잠금 전에 읽어도 바뀌지 않는다.
    if (h.status !== "CONFIRMED") throw conflict("INVALID_STATE", `run ${h.run_id} is ${h.status}`);
    await tx.query("SELECT 1 FROM settlement_run_event WHERE run_id = $1 AND event_id = $2 FOR UPDATE", [h.run_id, h.event_id]);
    const done = await tx.query("SELECT 1 FROM hold_release WHERE holding_id = $1", [input.holdingId]);
    if ((done.rowCount ?? 0) > 0) throw conflict("HOLD_ALREADY_RELEASED", `hold ${input.holdingId} is already released`);
    const parties = entries.map(([p]) => p);
    const known = new Map((await tx.query("SELECT party_id, party_type FROM party WHERE party_id = ANY($1)", [parties])).rows.map((r) => [r.party_id as string, r.party_type as string]));
    for (const p of parties) {
      const t = known.get(p);
      if (t === undefined || t === "FAN" || t === "PLATFORM") throw invalid("INVALID_PARTY", `${p} is not a rights holder party`);
    }
    const remaining = await remainingHold(tx, { runId: h.run_id, eventId: h.event_id, bucket: h.bucket, reason: h.reason, amount: BigInt(h.a) });
    if (remaining <= 0n) throw conflict("HOLD_EMPTY", `hold ${input.holdingId} has nothing left to release`);
    const sum = entries.reduce((a, [, v]) => a + BigInt(v), 0n);
    if (sum !== remaining) throw invalid("ALLOCATION_MISMATCH", `allocation sums to ${sum}, hold ${input.holdingId} has ${remaining}`);
    const at = { eventId: h.event_id as string, runId: h.run_id as string };
    const postings: PostingInput[] = [{ account: { kind: "HOLD", reason: h.reason }, amount: remaining, ...at }];
    for (const [p, v] of entries) postings.push({ account: { kind: "PARTY_PAYABLE", partyId: p }, amount: -BigInt(v), ...at });
    // post-batch보다 먼저 올 수 있으므로 원 run의 SETTLEMENT 분개를 먼저 보장한다(멱등) — HOLD_RELEASE는 항상 SETTLEMENT 뒤.
    await postConfirmedRun(tx, d.clock, h.run_id);
    const e = await postEntry(tx, d.clock, { kind: "HOLD_RELEASE", sourceRef: `hold:${input.holdingId}`, createdBy: actor.userId, postings });
    const allocation = Object.fromEntries(entries);
    try {
      await tx.query("INSERT INTO hold_release (holding_id, released_by, released_at, allocation, entry_id) VALUES ($1,$2,$3,$4,$5)",
        [input.holdingId, actor.userId, d.clock.now(), JSON.stringify(allocation), e.entryId]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw conflict("HOLD_ALREADY_RELEASED", `hold ${input.holdingId} is already released`);
      throw err;
    }
    await audit(tx, d.clock, { actor: actor.userId, action: "HOLD_RELEASED", entityType: "unallocated_holding", entityId: input.holdingId, after: { amount: remaining.toString(), allocation, entry: e.entryId } });
    return { holdingId: input.holdingId, releasedKrw: remaining.toString(), entryId: e.entryId, allocation };
  });
}
