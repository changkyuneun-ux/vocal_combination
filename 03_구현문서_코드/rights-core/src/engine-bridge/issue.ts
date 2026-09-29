import { projectToIr, type FactsDocument } from "vcrl/facts";
import { iso, type Tx } from "../platform/db.ts";
import { invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadFacts } from "./facts.ts";
import { sealDocument } from "./seal-store.ts";
import { digestOf, formatRatio, fromBps } from "vcrl/core";

export type IssueSeal = {
  snapshotId: string; factsDigest: string; policyDigest: string; projectionDigest: string; membersDigest: string; asOf: string; knownAt: string;
};

const toStrings = (o: Record<string, number>) =>
  Object.fromEntries(Object.keys(o).sort().map((k) => [k, String(o[k])]));

/** 멤버 봉인 = 엔진 Snapshot 형식(`{members: {party: "n/d"}}`, 합 1). 행의 bps를 유리수 문자열로 바꾼다(0 bps 멤버는 뺀다). */
export function membersIr(members: Record<string, number>): { members: Record<string, string> } {
  return { members: Object.fromEntries(Object.keys(members).sort().filter((k) => members[k]! > 0).map((k) => [k, formatRatio(fromBps(members[k]!))])) };
}

function buildProjection(facts: FactsDocument, usageMs: Record<string, number>, at: string) {
  const r = projectToIr(facts, toStrings(usageMs), at, at);
  if (!r.ok) throw invalid("PROJECTION_FAILED", "projection failed", r.errors);
  return r.value;
}

/** S3: 정책이 고정한 facts와 스냅샷 사용량·멤버 비율로 투영을 만들고 봉인한다. as_of = known_at = 발행 시각(9.3-6). */
export async function sealIssue(
  ctx: BridgeCtx, tx: Tx,
  input: { snapshotId: string; factsDigest: string; policyDigest: string; usageMs: Record<string, number>; members: Record<string, number>; issuedAt: string },
): Promise<IssueSeal> {
  const facts = await loadFacts(ctx, tx, input.factsDigest);
  const projection = buildProjection(facts, input.usageMs, input.issuedAt);
  const p = await sealDocument(ctx, tx, { kind: "projection", value: projection, docId: facts.id, format: projection.format });
  const m = await sealDocument(ctx, tx, { kind: "members", value: membersIr(input.members) });
  await tx.query(
    "INSERT INTO issue_seal (snapshot_id, facts_digest, policy_digest, projection_digest, members_digest, as_of, known_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [input.snapshotId, input.factsDigest, input.policyDigest, p.digest, m.digest, input.issuedAt],
  );
  return { snapshotId: input.snapshotId, factsDigest: input.factsDigest, policyDigest: input.policyDigest, projectionDigest: p.digest, membersDigest: m.digest, asOf: input.issuedAt, knownAt: input.issuedAt };
}

/**
 * 감사: 스냅샷 행과 봉인된 facts로 투영·멤버 IR을 다시 만들어 발행 봉인과 대조한다. 봉인을 새로 쓰지 않는다.
 * 발행 봉인의 facts·정책 digest가 스냅샷이 가리키는 정책 버전(rights_snapshot → policy_version)의 digest와 같은지도 본다(policyMatch).
 */
export async function rederiveIssue(ctx: BridgeCtx, tx: Tx, snapshotId: string) {
  const s = (await tx.query(
    `SELECT i.*, p.facts_digest AS pv_facts_digest, p.policy_digest AS pv_policy_digest
       FROM issue_seal i JOIN rights_snapshot r ON r.snapshot_id = i.snapshot_id
       JOIN policy_version p ON p.policy_id = r.policy_id AND p.version = r.policy_version
      WHERE i.snapshot_id = $1`,
    [snapshotId],
  )).rows[0];
  if (s === undefined) throw notFound("issue seal", snapshotId);
  const policyMatch = s.facts_digest === s.pv_facts_digest && s.policy_digest === s.pv_policy_digest;
  const expected: IssueSeal = {
    snapshotId, factsDigest: s.facts_digest, policyDigest: s.policy_digest, projectionDigest: s.projection_digest,
    membersDigest: s.members_digest, asOf: iso(s.as_of)!, knownAt: iso(s.known_at)!,
  };
  const usageMs: Record<string, number> = {};
  for (const r of (await tx.query("SELECT stem_id, duration_ms FROM snapshot_stem_assignment WHERE snapshot_id = $1 AND rights_bearing", [snapshotId])).rows) {
    usageMs[r.stem_id] = (usageMs[r.stem_id] ?? 0) + r.duration_ms;
  }
  const members: Record<string, number> = {};
  for (const r of (await tx.query("SELECT party_id, pct_bps FROM snapshot_member_pct WHERE snapshot_id = $1", [snapshotId])).rows) members[r.party_id] = r.pct_bps;
  const facts = await loadFacts(ctx, tx, expected.factsDigest);
  const recomputed = {
    projectionDigest: digestOf(buildProjection(facts, usageMs, expected.asOf)),
    membersDigest: digestOf(membersIr(members)),
  };
  const ok = policyMatch && recomputed.projectionDigest === expected.projectionDigest && recomputed.membersDigest === expected.membersDigest;
  return { ok, policyMatch, expected, recomputed };
}
