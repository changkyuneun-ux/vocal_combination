import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { sealFacts } from "../engine-bridge/facts.ts";
import { compilePolicyText } from "../engine-bridge/policy.ts";
import { attest, signersOf } from "../engine-bridge/attest.ts";
import { checkPackActivation } from "../engine-bridge/activation.ts";
import { declaredClaimants, packRow } from "../issuance/service.ts";

export type PolicyVersionRef = { policyId: string; version: number };
type Row = { policyId: string; version: number; status: string; policyDigest: string; factsDigest: string; factsKnownAt: string; packId: string };

async function versionRow(tx: Tx, ref: PolicyVersionRef, lock = true): Promise<Row> {
  const r = (await tx.query(
    `SELECT * FROM policy_version WHERE policy_id = $1 AND version = $2${lock ? " FOR UPDATE" : ""}`, [ref.policyId, ref.version],
  )).rows[0];
  if (r === undefined) throw notFound("policy version", `${ref.policyId}@${ref.version}`);
  return { policyId: r.policy_id, version: r.version, status: r.status, policyDigest: r.policy_digest, factsDigest: r.facts_digest, factsKnownAt: iso(r.facts_known_at)!, packId: r.pack_id };
}

/** 이미 이 정책 digest에 서명한 사람은 다른 역할로 다시 서명할 수 없다(통합 설계 6.5). */
async function requireNotSigned(tx: Tx, digest: string, actor: Actor): Promise<void> {
  if ((await signersOf(tx, digest)).some((s) => s.signerId === actor.userId)) {
    throw new DomainError("SOD_VIOLATION", 403, `${actor.userId} already signed ${digest}`);
  }
}

export async function compilePolicy(
  ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, input: { policyId: string; packId: string; sourceText: string },
): Promise<PolicyVersionRef & { policyDigest: string; factsDigest: string; canonicalText: string }> {
  requireRole(actor, "EDITOR");
  const pack = await packRow(tx, input.packId);
  const knownAt = clock.now();
  const facts = await sealFacts(ctx, tx, pack.factsScopeId, knownAt);
  const version = ((await tx.query("SELECT COALESCE(MAX(version), 0) AS v FROM policy_version WHERE policy_id = $1", [input.policyId])).rows[0].v as number) + 1;
  const { sealed, canonicalText } = await compilePolicyText(ctx, tx, { ...input, version, facts });
  await tx.query(
    `INSERT INTO policy_version (policy_id, version, source_text, policy_digest, facts_digest, facts_known_at, status, pack_id, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'COMPILED',$7,$8,$9)`,
    [input.policyId, version, canonicalText, sealed.digest, facts.digest, knownAt, input.packId, actor.userId, clock.now()],
  );
  await attest(ctx, tx, clock, { userId: actor.userId, role: "EDITOR", digest: sealed.digest });
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_COMPILED", entityType: "policy_version", entityId: `${input.policyId}@${version}`, after: { policyDigest: sealed.digest, factsDigest: facts.digest } });
  return { policyId: input.policyId, version, policyDigest: sealed.digest, factsDigest: facts.digest, canonicalText };
}

export async function approvePolicy(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, ref: PolicyVersionRef): Promise<void> {
  requireRole(actor, "WORK_APPROVER");
  const row = await versionRow(tx, ref);
  if (row.status !== "COMPILED") throw conflict("INVALID_STATE", `${ref.policyId}@${ref.version} is ${row.status}`);
  await requireNotSigned(tx, row.policyDigest, actor);
  await attest(ctx, tx, clock, { userId: actor.userId, role: "WORK_APPROVER", digest: row.policyDigest });
  await tx.query("UPDATE policy_version SET status = 'APPROVED' WHERE policy_id = $1 AND version = $2", [ref.policyId, ref.version]);
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_APPROVED", entityType: "policy_version", entityId: `${ref.policyId}@${ref.version}` });
}

/** 활성 정책 교체: 같은 정책의 이전 ACTIVE는 SUPERSEDED. 다른 정책이 이미 이 팩에서 ACTIVE면 거부. */
export async function supersedeAndActivate(tx: Tx, clock: Clock, row: Row): Promise<void> {
  const other = (await tx.query(
    "SELECT policy_id FROM policy_version WHERE pack_id = $1 AND status = 'ACTIVE' AND policy_id <> $2", [row.packId, row.policyId],
  )).rows[0];
  if (other !== undefined) throw conflict("PACK_HAS_ACTIVE_POLICY", `pack ${row.packId} already has active policy ${other.policy_id}`);
  await tx.query("UPDATE policy_version SET status = 'SUPERSEDED' WHERE policy_id = $1 AND status = 'ACTIVE'", [row.policyId]);
  await tx.query("UPDATE policy_version SET status = 'ACTIVE', activated_at = $3 WHERE policy_id = $1 AND version = $2", [row.policyId, row.version, clock.now()]);
}

export async function activatePolicy(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, ref: PolicyVersionRef): Promise<void> {
  requireRole(actor, "ACTIVATOR");
  const row = await versionRow(tx, ref);
  if (row.status !== "APPROVED") throw conflict("INVALID_STATE", `${ref.policyId}@${ref.version} is ${row.status}`);
  await requireNotSigned(tx, row.policyDigest, actor);
  await packRow(tx, row.packId, "SHARE"); // 판정과 활성화 사이에 청구권자 교체를 막는다
  const diags = await checkPackActivation(ctx, tx, { factsDigest: row.factsDigest, declared: await declaredClaimants(tx, row.packId), at: clock.now() });
  if (diags.length > 0) throw invalid("ACTIVATION_BLOCKED", `${ref.policyId}@${ref.version} cannot be activated`, diags);
  await attest(ctx, tx, clock, { userId: actor.userId, role: "ACTIVATOR", digest: row.policyDigest });
  await supersedeAndActivate(tx, clock, row);
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_ACTIVATED", entityType: "policy_version", entityId: `${ref.policyId}@${ref.version}` });
}

export async function activePolicyForPack(tx: Tx, packId: string): Promise<Omit<Row, "status" | "packId"> | undefined> {
  const r = (await tx.query("SELECT * FROM policy_version WHERE pack_id = $1 AND status = 'ACTIVE'", [packId])).rows[0];
  if (r === undefined) return undefined;
  return { policyId: r.policy_id, version: r.version, policyDigest: r.policy_digest, factsDigest: r.facts_digest, factsKnownAt: iso(r.facts_known_at)! };
}

export { versionRow };
