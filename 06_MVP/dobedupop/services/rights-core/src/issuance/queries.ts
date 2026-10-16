import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { cursorKey, pageOf, ts, type Page } from "../platform/paging.ts";

const packOut = (r: Record<string, any>) => ({
  packId: r.pack_id as string, packCode: r.pack_code as string, title: r.title as string, factsScopeId: r.facts_scope_id as string,
  status: r.status as string, createdAt: ts(r.created_at)!,
});

export async function listPacks(tx: Tx, _f: Record<string, never>, page: Page) {
  const after = cursorKey(page, ["s"]);
  const p: unknown[] = [];
  let where = "";
  if (after) { p.push(after[0]); where = "WHERE pack_id > $1"; }
  p.push(page.limit + 1);
  const rows = (await tx.query(`SELECT * FROM vocal_pack ${where} ORDER BY pack_id LIMIT $${p.length}`, p)).rows;
  return pageOf(rows.map(packOut), page, (r) => [r.packId]);
}

export async function getPack(tx: Tx, packId: string) {
  const r = (await tx.query("SELECT * FROM vocal_pack WHERE pack_id = $1", [packId])).rows[0];
  if (r === undefined) throw notFound("pack", packId);
  const claimants = (await tx.query("SELECT party_id, claimant_role FROM pack_claimant WHERE pack_id = $1 ORDER BY party_id, claimant_role", [packId])).rows;
  const active = (await tx.query("SELECT policy_id, version FROM policy_version WHERE pack_id = $1 AND status = 'ACTIVE'", [packId])).rows[0];
  return {
    ...packOut(r),
    claimants: claimants.map((c) => ({ partyId: c.party_id as string, claimantRole: c.claimant_role as string })),
    activePolicy: active === undefined ? null : { policyId: active.policy_id as string, version: active.version as number },
  };
}

/**
 * created_at DESC, snapshot_id ASC. quarantined는 풀리지 않은 격리가 있는지(quarantine 테이블은 정산 쪽 것이지만 SQL로만 읽는다).
 */
export async function listIssues(tx: Tx, f: { pack?: string; vc?: string }, page: Page) {
  const after = cursorKey(page, ["t", "s"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.pack !== undefined) { p.push(f.pack); w.push(`s.pack_id = $${p.length}`); }
  if (f.vc !== undefined) { p.push(f.vc); w.push(`s.vc_id = $${p.length}`); }
  if (after) {
    p.push(after[0], after[1]);
    w.push(`(s.created_at < $${p.length - 1}::timestamptz OR (s.created_at = $${p.length - 1}::timestamptz AND s.snapshot_id > $${p.length}))`);
  }
  p.push(page.limit + 1);
  const rows = (await tx.query(
    `SELECT s.*, i.facts_digest, i.policy_digest, i.projection_digest, i.members_digest, i.as_of, i.known_at,
            EXISTS (SELECT 1 FROM quarantine q WHERE q.snapshot_id = s.snapshot_id AND q.released_at IS NULL) AS quarantined
       FROM rights_snapshot s LEFT JOIN issue_seal i ON i.snapshot_id = s.snapshot_id
       ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY s.created_at DESC, s.snapshot_id LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    snapshotId: r.snapshot_id as string, vcId: r.vc_id as string, packId: r.pack_id as string, policyId: r.policy_id as string,
    policyVersion: r.policy_version as number, createdAt: ts(r.created_at)!,
    factsDigest: r.facts_digest as string | null, policyDigest: r.policy_digest as string | null,
    projectionDigest: r.projection_digest as string | null, membersDigest: r.members_digest as string | null,
    asOf: ts(r.as_of), knownAt: ts(r.known_at), quarantined: r.quarantined as boolean,
  })), page, (r) => [r.createdAt, r.snapshotId]);
}
