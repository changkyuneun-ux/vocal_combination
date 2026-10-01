import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { cursorKey, pageOf, ts, type Page } from "../platform/paging.ts";

/** policy_id 순. packId는 그 정책의 최신 버전 팩, ?pack=은 그 팩에 버전이 하나라도 있는 정책. */
export async function listPolicies(tx: Tx, f: { pack?: string }, page: Page) {
  const after = cursorKey(page, ["s"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.pack !== undefined) { p.push(f.pack); w.push(`pack_id = $${p.length}`); }
  if (after) { p.push(after[0]); w.push(`policy_id > $${p.length}`); }
  p.push(page.limit + 1);
  const rows = (await tx.query(
    `SELECT policy_id, (array_agg(pack_id ORDER BY version DESC))[1] AS pack_id, MAX(version) AS latest_version,
            MAX(version) FILTER (WHERE status = 'ACTIVE') AS active_version
       FROM policy_version ${w.length ? "WHERE " + w.join(" AND ") : ""} GROUP BY policy_id ORDER BY policy_id LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    policyId: r.policy_id as string, packId: r.pack_id as string, latestVersion: r.latest_version as number,
    activeVersion: (r.active_version as number | null),
  })), page, (r) => [r.policyId]);
}

/** 승인 = 정책 digest에 대한 WORK_APPROVER 서명(approvePolicy가 남긴다). */
const APPROVER_ROLE = "WORK_APPROVER";

/** version DESC. source_text는 뺀다. */
export async function listVersions(tx: Tx, policyId: string, page: Page) {
  const after = cursorKey(page, ["n"]);
  if ((await tx.query("SELECT 1 FROM policy_version WHERE policy_id = $1 LIMIT 1", [policyId])).rowCount === 0) throw notFound("policy", policyId);
  const p: unknown[] = [policyId];
  let where = "v.policy_id = $1";
  if (after) { p.push(after[0]); where += ` AND v.version < $2`; }
  p.push(page.limit + 1);
  const rows = (await tx.query(
    `SELECT v.policy_id, v.version, v.policy_digest, v.facts_digest, v.facts_known_at, v.status, v.rebind_of_version, v.pack_id, v.created_by,
            v.created_at, v.activated_at,
            (SELECT a.signer_id FROM attestation a WHERE a.digest = v.policy_digest AND a.role = '${APPROVER_ROLE}' ORDER BY a.signed_at LIMIT 1) AS approved_by
       FROM policy_version v WHERE ${where} ORDER BY v.version DESC LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    policyId: r.policy_id as string, version: r.version as number, policyDigest: r.policy_digest as string, factsDigest: r.facts_digest as string,
    factsKnownAt: ts(r.facts_known_at)!, status: r.status as string, rebindOfVersion: r.rebind_of_version as number | null, packId: r.pack_id as string,
    createdBy: r.created_by as string, createdAt: ts(r.created_at)!, activatedAt: ts(r.activated_at),
    approved: r.approved_by !== null, approvedBy: r.approved_by as string | null,
  })), page, (r) => [r.version]);
}

/** policy_version 전 컬럼 + approvals(정책 digest에 서명한 모두: userId, role, at). */
export async function getVersion(tx: Tx, policyId: string, version: number) {
  const r = (await tx.query("SELECT * FROM policy_version WHERE policy_id = $1 AND version = $2", [policyId, version])).rows[0];
  if (r === undefined) throw notFound("policy version", `${policyId}@${version}`);
  const approvals = (await tx.query("SELECT signer_id, role, signed_at FROM attestation WHERE digest = $1 ORDER BY signed_at, role", [r.policy_digest])).rows;
  return {
    policyId: r.policy_id as string, version: r.version as number, sourceText: r.source_text as string, policyDigest: r.policy_digest as string,
    factsDigest: r.facts_digest as string, factsKnownAt: ts(r.facts_known_at)!, status: r.status as string,
    rebindOfVersion: r.rebind_of_version as number | null, packId: r.pack_id as string, createdBy: r.created_by as string,
    createdAt: ts(r.created_at)!, activatedAt: ts(r.activated_at),
    approvals: approvals.map((a) => ({ userId: a.signer_id as string, role: a.role as string, at: ts(a.signed_at)! })),
  };
}
