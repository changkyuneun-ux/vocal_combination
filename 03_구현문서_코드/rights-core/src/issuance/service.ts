import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, invalid, notFound } from "../platform/errors.ts";
import { checkPackActivation, type Declared } from "../engine-bridge/activation.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { sealIssue, type IssueSeal } from "../engine-bridge/issue.ts";
import { activePolicyForPack } from "../policy/service.ts";
import type { OutboxHandlers } from "../platform/outbox.ts";

export async function createPack(tx: Tx, clock: Clock, actor: Actor, p: { packId: string; packCode: string; title: string; factsScopeId: string }): Promise<void> {
  requireRole(actor, "RIGHTS_EDITOR");
  await tx.query("INSERT INTO vocal_pack (pack_id, pack_code, title, facts_scope_id, created_at) VALUES ($1,$2,$3,$4,$5)",
    [p.packId, p.packCode, p.title, p.factsScopeId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "PACK_CREATED", entityType: "vocal_pack", entityId: p.packId });
}

export type PackLock = "NONE" | "SHARE" | "UPDATE";

/** 팩 행을 읽는다. 청구권자를 바꾸는 쪽은 UPDATE, 청구권자를 읽고 판정하는 쪽은 SHARE로 잠근다. */
export async function packRow(tx: Tx, packId: string, lock: PackLock = "NONE"): Promise<{ packId: string; factsScopeId: string; status: string }> {
  const suffix = lock === "UPDATE" ? " FOR UPDATE" : lock === "SHARE" ? " FOR SHARE" : "";
  const r = (await tx.query(`SELECT pack_id, facts_scope_id, status FROM vocal_pack WHERE pack_id = $1${suffix}`, [packId])).rows[0];
  if (r === undefined) throw notFound("pack", packId);
  return { packId: r.pack_id, factsScopeId: r.facts_scope_id, status: r.status };
}

/** 선언 청구권자 교체. 활성 팩은 바꿀 수 없다(일시정지 또는 초안에서만). */
export async function setPackClaimants(tx: Tx, clock: Clock, actor: Actor, packId: string, entries: Declared[]): Promise<void> {
  requireRole(actor, "RIGHTS_EDITOR");
  const pack = await packRow(tx, packId, "UPDATE");
  if (pack.status === "ACTIVE") throw conflict("INVALID_STATE", `pack ${packId} is ACTIVE`);
  await tx.query("DELETE FROM pack_claimant WHERE pack_id = $1", [packId]);
  for (const e of entries) {
    await tx.query("INSERT INTO pack_claimant (pack_id, party_id, claimant_role) VALUES ($1,$2,$3)", [packId, e.party, e.role]);
  }
  await audit(tx, clock, { actor: actor.userId, action: "PACK_CLAIMANTS_SET", entityType: "vocal_pack", entityId: packId, after: entries });
}

export async function declaredClaimants(tx: Tx, packId: string): Promise<Declared[]> {
  const r = await tx.query("SELECT claimant_role, party_id FROM pack_claimant WHERE pack_id = $1 ORDER BY claimant_role, party_id", [packId]);
  return r.rows.map((x) => ({ role: x.claimant_role, party: x.party_id }));
}

export async function openDisputeInScope(tx: Tx, scopeId: string): Promise<boolean> {
  return ((await tx.query("SELECT 1 FROM dispute WHERE facts_scope_id = $1 AND status = 'OPEN' LIMIT 1", [scopeId])).rowCount ?? 0) > 0;
}

/**
 * 활성 정책의 facts 고정 이후에 종결된 분쟁. 종결은 대상의 새 버전을 기록하므로 고정된 facts는 낡았고,
 * 재고정(rebindPolicy) 또는 새 정책 버전 없이 팩을 다시 켜면 분쟁 이전 facts로 발행하게 된다.
 */
async function disputeClosedAfter(tx: Tx, scopeId: string, knownAt: string): Promise<{ disputeId: string; closedAt: string } | undefined> {
  const r = (await tx.query(
    "SELECT dispute_id, closed_at FROM dispute WHERE facts_scope_id = $1 AND closed_at > $2 ORDER BY closed_at DESC, dispute_id LIMIT 1", [scopeId, knownAt],
  )).rows[0];
  return r === undefined ? undefined : { disputeId: r.dispute_id, closedAt: iso(r.closed_at)! };
}

function rebindRequired(packId: string, active: { policyId: string; version: number; factsKnownAt: string }, stale: { disputeId: string; closedAt: string }) {
  return conflict("REBIND_REQUIRED", `pack ${packId}: policy ${active.policyId}@${active.version} pins facts known at ${active.factsKnownAt}, before dispute ${stale.disputeId} closed at ${stale.closedAt}; rebind first`);
}

/** F2(통합 설계 5.2): 활성 정책이 있고, 범위에 열린 분쟁이 없고, 정책의 facts가 마지막 분쟁 종결 이후에 고정됐고, 활성화 검사를 통과해야 한다. */
export async function activatePack(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, packId: string): Promise<void> {
  requireRole(actor, "ACTIVATOR");
  const pack = await packRow(tx, packId, "UPDATE");
  if (pack.status === "ACTIVE") throw conflict("INVALID_STATE", `pack ${packId} is already ACTIVE`);
  const active = await activePolicyForPack(tx, packId);
  if (active === undefined) throw conflict("NO_ACTIVE_POLICY", `pack ${packId} has no active policy`);
  if (await openDisputeInScope(tx, pack.factsScopeId)) throw conflict("FACTS_DISPUTE_OPEN", `facts scope ${pack.factsScopeId} has an open dispute`);
  const stale = await disputeClosedAfter(tx, pack.factsScopeId, active.factsKnownAt);
  if (stale !== undefined) throw rebindRequired(packId, active, stale);
  const diags = await checkPackActivation(ctx, tx, { factsDigest: active.factsDigest, declared: await declaredClaimants(tx, packId), at: clock.now() });
  if (diags.length > 0) throw invalid("ACTIVATION_BLOCKED", `pack ${packId} cannot be activated`, diags);
  await tx.query("UPDATE vocal_pack SET status = 'ACTIVE' WHERE pack_id = $1", [packId]);
  await audit(tx, clock, { actor: actor.userId, action: "PACK_ACTIVATED", entityType: "vocal_pack", entityId: packId, after: { policy: `${active.policyId}@${active.version}` } });
}

export type IssueInput = { packId: string; vcId: string; assignments: { slotId: string; stemId: string }[]; members: Record<string, number> };

/** F3(통합 설계 5.3, 9.3-6·7): 한 트랜잭션에서 스냅샷을 쓰고 발행 봉인을 만든다. 하나라도 실패하면 아무것도 남지 않는다. */
export async function issue(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, input: IssueInput): Promise<IssueSeal> {
  requireRole(actor, "ISSUER");
  const pack = await packRow(tx, input.packId, "SHARE");
  if (pack.status !== "ACTIVE") throw conflict("PACK_NOT_ACTIVE", `pack ${input.packId} is ${pack.status}`);
  if (await openDisputeInScope(tx, pack.factsScopeId)) throw conflict("FACTS_DISPUTE_OPEN", `facts scope ${pack.factsScopeId} has an open dispute`);
  const active = await activePolicyForPack(tx, input.packId);
  if (active === undefined) throw conflict("NO_ACTIVE_POLICY", `pack ${input.packId} has no active policy`);
  // Outbox가 팩을 멈추기 전에 분쟁이 열리고 닫혔으면 팩은 ACTIVE로 남는다. 고정된 facts가 분쟁 이전이면 발행하지 않는다.
  const stale = await disputeClosedAfter(tx, pack.factsScopeId, active.factsKnownAt);
  if (stale !== undefined) throw rebindRequired(input.packId, active, stale);

  const bad = (m: string) => invalid("INVALID_ISSUE", m);
  if (input.assignments.length === 0) throw bad("assignments must not be empty");
  if (new Set(input.assignments.map((a) => a.slotId)).size !== input.assignments.length) throw bad("duplicate slot in assignments");
  const stems = (await tx.query(
    `SELECT st.stem_id, st.slot_id, st.performer_party_id, st.rights_bearing, sl.start_ms, sl.end_ms, sl.duration_ms, s.facts_scope_id
       FROM stem st JOIN part_slot sl ON sl.slot_id = st.slot_id
       JOIN recording_version r ON r.recording_id = st.recording_id JOIN facts_scope s ON s.work_id = r.work_id
      WHERE st.stem_id = ANY($1)`,
    [input.assignments.map((a) => a.stemId)],
  )).rows;
  const byStem = new Map(stems.map((s) => [s.stem_id as string, s]));
  for (const a of input.assignments) {
    const s = byStem.get(a.stemId);
    if (s === undefined || s.slot_id !== a.slotId || s.facts_scope_id !== pack.factsScopeId) throw bad(`stem ${a.stemId} is not in slot ${a.slotId} of this song`);
  }
  const memberEntries = Object.entries(input.members);
  if (memberEntries.some(([, v]) => !Number.isInteger(v) || v < 0 || v > 10000)) throw bad("member bps must be integers 0..10000");
  if (memberEntries.reduce((acc, [, v]) => acc + v, 0) !== 10000) throw bad("member bps must sum to 10000");
  const known = (await tx.query("SELECT party_id FROM party WHERE party_id = ANY($1)", [memberEntries.map(([p]) => p)])).rows.length;
  if (known !== memberEntries.length) throw bad("unknown member party");
  // 멤버는 배정된 정산 대상 스템을 실연한 party여야 한다(레이블·작가 등은 멤버 비율을 받을 수 없다).
  const performers = new Set(input.assignments.map((a) => byStem.get(a.stemId)!).filter((s) => s.rights_bearing && s.performer_party_id !== null).map((s) => s.performer_party_id as string));
  const outsiders = memberEntries.map(([p]) => p).filter((p) => !performers.has(p));
  if (outsiders.length > 0) throw bad(`members must perform an assigned rights-bearing stem: ${outsiders.sort().join(", ")}`);

  const issuedAt = clock.now();
  const snapshotId = `snp_${input.vcId}`;
  await tx.query("INSERT INTO rights_snapshot (snapshot_id, vc_id, pack_id, policy_id, policy_version, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [snapshotId, input.vcId, input.packId, active.policyId, active.version, issuedAt]);
  const usageMs: Record<string, number> = {};
  for (const a of input.assignments) {
    const s = byStem.get(a.stemId)!;
    await tx.query(
      "INSERT INTO snapshot_stem_assignment (snapshot_id, slot_id, stem_id, party_id, start_ms, end_ms, duration_ms, rights_bearing) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [snapshotId, a.slotId, a.stemId, s.performer_party_id, s.start_ms, s.end_ms, s.duration_ms, s.rights_bearing],
    );
    if (s.rights_bearing) usageMs[a.stemId] = (usageMs[a.stemId] ?? 0) + (s.duration_ms as number);
  }
  for (const [party, bps] of memberEntries) {
    await tx.query("INSERT INTO snapshot_member_pct (snapshot_id, party_id, pct_bps) VALUES ($1,$2,$3)", [snapshotId, party, bps]);
  }
  const seal = await sealIssue(ctx, tx, { snapshotId, factsDigest: active.factsDigest, policyDigest: active.policyDigest, usageMs, members: input.members, issuedAt });
  await audit(tx, clock, { actor: actor.userId, action: "ISSUED", entityType: "rights_snapshot", entityId: snapshotId, after: { projection: seal.projectionDigest } });
  return seal;
}

/** Outbox 핸들러: 분쟁이 열리면 그 facts 범위의 ACTIVE 팩을 일시정지한다(통합 설계 5.6-1). 재활성화는 수동이다. */
export const OUTBOX_HANDLERS: OutboxHandlers = {
  async dispute_opened(tx, payload: { factsScopeId: string; disputeId: string }, clock) {
    // openDispute와 같은 순서(pack_id)로 먼저 잠근다. UPDATE의 행 순서는 정해져 있지 않아 교착할 수 있다.
    await tx.query("SELECT pack_id FROM vocal_pack WHERE facts_scope_id = $1 ORDER BY pack_id FOR UPDATE", [payload.factsScopeId]);
    const paused = (await tx.query(
      "UPDATE vocal_pack SET status = 'PAUSED' WHERE facts_scope_id = $1 AND status = 'ACTIVE' RETURNING pack_id", [payload.factsScopeId],
    )).rows;
    for (const p of paused) {
      await audit(tx, clock, { actor: "system:outbox", action: "PACK_PAUSED", entityType: "vocal_pack", entityId: p.pack_id, after: { disputeId: payload.disputeId } });
    }
  },
};
