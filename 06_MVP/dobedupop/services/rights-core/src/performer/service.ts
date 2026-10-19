import { randomBytes } from "node:crypto";
import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import { openDispute } from "../registry/disputes.ts";
import { notifyUser } from "./notifications.ts";

/**
 * 곡 전체를 봐야 하는 실연자 앱 작업(내 보이스 찾기·이의제기)을 system 범위로 하되, 새로 생기는 행(분쟁·주장 새 버전)은
 * 그 곡을 소유한 테넌트 소유가 되게 한다(rc.tenant_id를 곡 소유 테넌트로 잠시 바꾼다). 끝나면 원래 범위로 돌린다.
 */
async function asScopeOwner<T>(tx: Tx, scopeId: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = (await tx.query("SELECT current_setting('rc.scope', true) AS s, current_setting('rc.tenant_id', true) AS t")).rows[0];
  await tx.query("SELECT set_config('rc.scope', 'system', true)");
  try {
    if (scopeId !== null) {
      const owner = (await tx.query("SELECT owner_tenant_id FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rows[0]?.owner_tenant_id;
      if (owner !== undefined) await tx.query("SELECT set_config('rc.tenant_id', $1, true)", [owner]);
    }
    return await fn();
  } finally {
    await tx.query("SELECT set_config('rc.scope', $1, true), set_config('rc.tenant_id', $2, true)", [prev.s ?? "", prev.t ?? ""]);
  }
}

/** 내 보이스: 내 파티가 OWNED_BY로 소유한 보이스, 그 곡, 그리고 최근 실연 동의 상태(없음·서명·철회). */
export async function myVoices(tx: Tx, partyId: string) {
  return asScopeOwner(tx, null, async () => (await tx.query(
    `SELECT v.voice_id, v.facts_scope_id, w.work_id, w.title,
            (SELECT CASE WHEN c.revoked_at IS NULL THEN 'SIGNED' ELSE 'REVOKED' END FROM consent_agreement c
              WHERE c.asset_id = v.voice_id AND c.party_id = $1 AND c.right_type = 'PERFORMER' ORDER BY c.signed_at DESC LIMIT 1) AS consent
       FROM voice v JOIN right_claim rc ON rc.source_id = v.voice_id AND rc.edge = 'OWNED_BY' AND rc.superseded_at IS NULL AND rc.status IN ('VERIFIED','ASSERTED','DISPUTED')
       JOIN facts_scope f ON f.facts_scope_id = v.facts_scope_id JOIN work w ON w.work_id = f.work_id
      WHERE rc.target_id = $1 ORDER BY w.title, v.voice_id`, [partyId])).rows.map((r) => ({
    voiceId: r.voice_id as string, factsScopeId: r.facts_scope_id as string, workId: r.work_id as string, title: r.title as string, consent: (r.consent as string | null) ?? "NONE",
  })));
}

/** 나와 관련된 권리 주장인가: 내 보이스 소유(OWNED_BY → 나), 내 스템 실연(PERFORMED_BY, 스템 실연자 = 나 또는 보이스 소유자 = 나). */
async function concernsMe(tx: Tx, claimId: string, partyId: string): Promise<{ scopeId: string } | null> {
  const c = (await tx.query("SELECT facts_scope_id, edge, source_id, target_id FROM right_claim WHERE claim_id = $1 AND superseded_at IS NULL", [claimId])).rows[0];
  if (c === undefined) return null;
  if (c.edge === "OWNED_BY" && c.target_id === partyId) return { scopeId: c.facts_scope_id };
  if (c.edge === "PERFORMED_BY") {
    const stem = (await tx.query("SELECT performer_party_id FROM stem WHERE stem_id = $1", [c.source_id])).rows[0];
    const owner = (await tx.query("SELECT 1 FROM right_claim WHERE source_id = $1 AND edge = 'OWNED_BY' AND target_id = $2 AND superseded_at IS NULL", [c.target_id, partyId])).rowCount;
    if (stem?.performer_party_id === partyId || owner !== 0) return { scopeId: c.facts_scope_id };
  }
  return null;
}

/**
 * 이의제기: 실연자가 자기와 관련된 권리 주장에 분쟁을 연다. 분쟁이 열리면 그 곡의 활성 팩이 멈추고(분쟁 처리 규칙),
 * 곡 소유 권리자의 포털에 분쟁이 보인다. 판정은 권리자·플랫폼이 한다.
 */
export async function openObjection(tx: Tx, clock: Clock, actor: Actor, input: { claimId?: string; reason?: string }) {
  if (actor.partyId === undefined) throw new DomainError("PARTY_REQUIRED", 403, "objections are filed by a performer account linked to a party");
  if (typeof input.claimId !== "string" || typeof input.reason !== "string" || input.reason.trim().length < 5) {
    throw new DomainError("BAD_REQUEST", 400, "claimId and a reason (5+ characters) are required");
  }
  const target = await asScopeOwner(tx, null, () => concernsMe(tx, input.claimId!, actor.partyId!));
  if (target === null) throw notFound("claim concerning you", input.claimId);
  const disputeId = `dsp_obj_${Date.parse(clock.now())}_${randomBytes(3).toString("hex")}`;
  await asScopeOwner(tx, target.scopeId, () => openDispute(tx, clock, { disputeId, targetType: "RIGHT_CLAIM", targetId: input.claimId!, reason: input.reason!.trim(), openedBy: actor.userId }));
  await audit(tx, clock, { actor: actor.userId, action: "OBJECTION_OPENED", entityType: "dispute", entityId: disputeId, after: { claimId: input.claimId } });
  await notifyUser(tx, clock, actor.userId, { kind: "OBJECTION", title: "이의제기를 접수했습니다", body: `권리 주장 ${input.claimId}에 대한 이의가 분쟁 ${disputeId}로 열렸습니다.`, ref: { disputeId } });
  return { disputeId, status: "OPEN" };
}

/**
 * 나를 가리키는 현재 권리 주장(이의제기 대상): 내 보이스 소유(OWNED_BY), 내 스템·내 보이스의 실연(PERFORMED_BY).
 * 시스템 범위로 우회하지 않고 개인 범위 RLS의 공유 규칙(0037 names_me — 테넌트 정책 TN7)이 보여 주는 행만 읽는다.
 */
export async function myClaims(tx: Tx, partyId: string) {
  const scope = (await tx.query("SELECT current_setting('rc.scope', true) AS s, current_setting('rc.party_id', true) AS p")).rows[0];
  if (scope.s !== "party" || scope.p !== partyId) throw new Error("myClaims runs in the person's own (party) scope");
  return (await tx.query(
    `SELECT c.claim_id, c.edge, c.source_id, c.target_id, c.share_bps, c.status, w.title FROM right_claim c
       JOIN facts_scope f ON f.facts_scope_id = c.facts_scope_id JOIN work w ON w.work_id = f.work_id
      WHERE c.superseded_at IS NULL AND c.edge IN ('OWNED_BY', 'PERFORMED_BY')
      ORDER BY w.title, c.edge, c.claim_id`)).rows.map((r) => ({
    claimId: r.claim_id as string, edge: r.edge as string, sourceId: r.source_id as string, targetId: r.target_id as string,
    shareBps: r.share_bps as number, status: r.status as string, title: r.title as string,
  }));
}

export async function myObjections(tx: Tx, userId: string) {
  return asScopeOwner(tx, null, async () => (await tx.query(
    "SELECT dispute_id, target_id, dispute_reason, status, opened_at, closed_at FROM dispute WHERE opened_by = $1 ORDER BY opened_at DESC", [userId])).rows.map((r) => ({
    disputeId: r.dispute_id as string, claimId: r.target_id as string, reason: r.dispute_reason as string, status: r.status as string,
    openedAt: iso(r.opened_at)!, ...(r.closed_at !== null && { closedAt: iso(r.closed_at)! }),
  })));
}
