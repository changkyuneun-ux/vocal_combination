import { withSystemScope } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";

/**
 * 동의 철회 후 노출 중지(다음 작업 17): 철회된 동의의 자산을 쓴 발행 조합에 노출 보류를 건다(outbox consent_revoked, system 범위).
 * - 실연(PERFORMER): 그 보이스를 실연한 스템이 배정된 조합
 * - 녹음(MASTER): 그 녹음의 스템이 배정된 조합
 * - 작품(WORK): 그 곡의 모든 조합
 * 이미 보류가 있으면 그대로 둔다(멱등). 보류를 건 조합 id를 돌려준다.
 */
export async function holdExposureForConsent(tx: Tx, clock: Clock, consentId: string): Promise<string[]> {
  const c = (await tx.query("SELECT facts_scope_id, party_id, right_type, asset_id, revoked_at FROM consent_agreement WHERE consent_id = $1", [consentId])).rows[0];
  if (c === undefined || c.revoked_at === null) return [];
  const stemFilter = c.right_type === "PERFORMER"
    ? `AND a.stem_id IN (SELECT source_id FROM right_claim WHERE facts_scope_id = $1 AND edge = 'PERFORMED_BY' AND target_id = $2 AND superseded_at IS NULL)`
    : c.right_type === "MASTER" ? "AND a.stem_id IN (SELECT stem_id FROM stem WHERE recording_id = $2)" : "AND $2::text IS NOT NULL";
  const snaps = (await tx.query(
    `SELECT DISTINCT s.snapshot_id FROM rights_snapshot s JOIN vocal_pack p ON p.pack_id = s.pack_id JOIN snapshot_stem_assignment a ON a.snapshot_id = s.snapshot_id
      WHERE p.facts_scope_id = $1 ${stemFilter} ORDER BY s.snapshot_id`, [c.facts_scope_id, c.asset_id],
  )).rows.map((r) => r.snapshot_id as string);
  const now = clock.now();
  const held: string[] = [];
  for (const s of snaps) {
    const r = await tx.query(
      `INSERT INTO exposure_hold (snapshot_id, consent_id, party_id, right_type, asset_id, held_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (snapshot_id, consent_id) DO NOTHING`,
      [s, consentId, c.party_id, c.right_type, c.asset_id, now]);
    if ((r.rowCount ?? 0) > 0) held.push(s);
  }
  return held;
}

/** 재동의: 같은 파티가 같은 자산에 다시 동의하면 그 파티가 건 보류를 푼다. 서명 트랜잭션 안에서 부른다. */
export async function releaseExposureOnConsent(tx: Tx, clock: Clock, userId: string, partyId: string, assetId: string): Promise<number> {
  return withSystemScope(tx, async () => (await tx.query(
    "UPDATE exposure_hold SET released_at = $3, released_by = $4, release_reason = 'RECONSENT' WHERE party_id = $1 AND asset_id = $2 AND released_at IS NULL",
    [partyId, assetId, clock.now(), userId])).rowCount ?? 0);
}

/** 이 조합이 지금 노출 중지 상태인가(풀리지 않은 보류가 하나라도 있다). */
export async function exposureStopped(tx: Tx, vcId: string): Promise<boolean> {
  return withSystemScope(tx, async () => ((await tx.query(
    "SELECT 1 FROM exposure_hold h JOIN rights_snapshot s ON s.snapshot_id = h.snapshot_id WHERE s.vc_id = $1 AND h.released_at IS NULL LIMIT 1", [vcId])).rowCount ?? 0) > 0);
}

export async function assertExposed(tx: Tx, vcId: string): Promise<void> {
  if (await exposureStopped(tx, vcId)) throw new DomainError("EXPOSURE_STOPPED", 410, `combination ${vcId} is not exposed: a consent it relies on was revoked`);
}

/** 운영 조회: 노출 보류(기본은 풀리지 않은 것만). */
export async function listExposureHolds(tx: Tx, all = false) {
  const rows = (await tx.query(
    `SELECT h.*, s.vc_id FROM exposure_hold h JOIN rights_snapshot s ON s.snapshot_id = h.snapshot_id
      ${all ? "" : "WHERE h.released_at IS NULL"} ORDER BY h.held_at DESC, h.hold_id`)).rows;
  return rows.map((r) => ({
    holdId: Number(r.hold_id), vcId: r.vc_id as string, snapshotId: r.snapshot_id as string, consentId: r.consent_id as string, partyId: r.party_id as string,
    rightType: r.right_type as string, assetId: r.asset_id as string, heldAt: iso(r.held_at)!,
    ...(r.released_at !== null && { releasedAt: iso(r.released_at)!, releasedBy: r.released_by as string, releaseReason: r.release_reason as string }),
  }));
}
