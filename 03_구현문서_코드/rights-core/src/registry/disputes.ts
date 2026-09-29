import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, notFound } from "../platform/errors.ts";
import { enqueue } from "../platform/outbox.ts";
import { currentClaim, currentMandate, recordClaim, recordMandate } from "./service.ts";

/**
 * 범위의 팩을 모두 FOR UPDATE로 잠근다. 발행(issuance.issue)은 팩을 FOR SHARE로 잠근 뒤 열린 분쟁을 확인하므로,
 * 이 잠금으로 진행 중인 발행은 먼저 끝나거나(분쟁 개시가 기다림) 커밋된 분쟁을 보게 된다(발행이 기다림).
 * registry는 issuance를 import하지 않으므로 packRow 대신 직접 질의한다.
 */
async function lockScopePacks(tx: Tx, scopeId: string): Promise<void> {
  await tx.query("SELECT pack_id FROM vocal_pack WHERE facts_scope_id = $1 ORDER BY pack_id FOR UPDATE", [scopeId]);
}

/** 분쟁 개시(통합 설계 5.6): 대상의 새 버전을 DISPUTED로 기록하고 dispute 행과 Outbox 이벤트를 남긴다. */
export async function openDispute(tx: Tx, clock: Clock, input: { disputeId: string; targetType: "RIGHT_CLAIM" | "MANDATE"; targetId: string; reason: string }): Promise<void> {
  let scopeId: string;
  if (input.targetType === "RIGHT_CLAIM") {
    const { version: _v, ...cur } = await currentClaim(tx, input.targetId);
    scopeId = cur.factsScopeId;
    await lockScopePacks(tx, scopeId);
    await recordClaim(tx, clock, { ...cur, status: "DISPUTED" });
  } else {
    const { version: _v, ...cur } = await currentMandate(tx, input.targetId);
    scopeId = cur.factsScopeId;
    await lockScopePacks(tx, scopeId);
    await recordMandate(tx, clock, { ...cur, status: "DISPUTED" });
  }
  await tx.query(
    "INSERT INTO dispute (dispute_id, target_type, target_id, facts_scope_id, dispute_reason, opened_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [input.disputeId, input.targetType, input.targetId, scopeId, input.reason, clock.now()],
  );
  await enqueue(tx, clock, "dispute_opened", { disputeId: input.disputeId, factsScopeId: scopeId });
}

/** 분쟁 종결: 대상의 새 VERIFIED 버전(해결안이 있으면 지분·대상을 고친다)을 기록하고 dispute를 닫는다. 팩 재활성화는 수동이다. */
export async function closeDispute(tx: Tx, clock: Clock, input: { disputeId: string; resolution?: { shareBps?: number; targetId?: string } }): Promise<void> {
  const d = (await tx.query("SELECT * FROM dispute WHERE dispute_id = $1 FOR UPDATE", [input.disputeId])).rows[0];
  if (d === undefined) throw notFound("dispute", input.disputeId);
  if (d.status !== "OPEN") throw conflict("INVALID_STATE", `dispute ${input.disputeId} is ${d.status}`);
  const res = input.resolution ?? {};
  if (d.target_type === "RIGHT_CLAIM") {
    const { version: _v, ...cur } = await currentClaim(tx, d.target_id);
    await recordClaim(tx, clock, { ...cur, status: "VERIFIED", ...(res.shareBps !== undefined && { shareBps: res.shareBps }), ...(res.targetId !== undefined && { targetId: res.targetId }) });
  } else {
    const { version: _v, ...cur } = await currentMandate(tx, d.target_id);
    await recordMandate(tx, clock, { ...cur, status: "VERIFIED", ...(res.shareBps !== undefined && { shareBps: res.shareBps }), ...(res.targetId !== undefined && { toPartyId: res.targetId }) });
  }
  await tx.query("UPDATE dispute SET status = 'CLOSED', closed_at = $2 WHERE dispute_id = $1", [input.disputeId, clock.now()]);
  await enqueue(tx, clock, "dispute_closed", { disputeId: input.disputeId, factsScopeId: d.facts_scope_id });
}
