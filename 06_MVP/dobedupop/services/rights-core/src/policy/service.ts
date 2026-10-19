import { requireRole, type Actor } from "../platform/actor.ts";
import { assertOwnerTenantActive } from "../platform/tenants.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { sealFacts } from "../engine-bridge/facts.ts";
import { compilePolicyText, repinPolicy } from "../engine-bridge/policy.ts";
import { attest, signersOf } from "../engine-bridge/attest.ts";
import { checkPackActivation, claimantSet } from "../engine-bridge/activation.ts";
import { declaredClaimants, openDisputeInScope, packRow } from "../issuance/service.ts";
import { assertActivationAllowed } from "../validation/service.ts";

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
  // 잠금 순서는 팩 → 범위(openDispute·rebind와 같다). 팩을 먼저 잡지 않으면 봉인의 범위 FOR UPDATE와 분쟁 개시의 팩 FOR UPDATE가 교착한다.
  const pack = await packRow(tx, input.packId, "SHARE");
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
  const pack = await packRow(tx, row.packId, "SHARE"); // 판정과 활성화 사이에 청구권자 교체를 막는다
  // checkActivation은 조합 지분 경로 위의 분쟁만 본다. 범위에 열린 분쟁이 하나라도 있으면 경로와 무관하게 거부한다.
  if (await openDisputeInScope(tx, pack.factsScopeId)) throw conflict("FACTS_DISPUTE_OPEN", `facts scope ${pack.factsScopeId} has an open dispute`);
  const diags = await checkPackActivation(ctx, tx, { factsDigest: row.factsDigest, declared: await declaredClaimants(tx, row.packId), at: clock.now() });
  if (diags.length > 0) throw invalid("ACTIVATION_BLOCKED", `${ref.policyId}@${ref.version} cannot be activated`, diags);
  await assertActivationAllowed(tx, clock, pack.factsScopeId); // 정합성 검증(원천 문서 설계 S3a)
  await assertOwnerTenantActive(tx, pack.factsScopeId, "activate"); // 테넌트 수명주기(결정 TD7): 활성 테넌트만
  await attest(ctx, tx, clock, { userId: actor.userId, role: "ACTIVATOR", digest: row.policyDigest });
  await supersedeAndActivate(tx, clock, row);
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_ACTIVATED", entityType: "policy_version", entityId: `${ref.policyId}@${ref.version}` });
}

export async function activePolicyForPack(tx: Tx, packId: string): Promise<Omit<Row, "status" | "packId"> | undefined> {
  const r = (await tx.query("SELECT * FROM policy_version WHERE pack_id = $1 AND status = 'ACTIVE'", [packId])).rows[0];
  if (r === undefined) return undefined;
  return { policyId: r.policy_id, version: r.version, policyDigest: r.policy_digest, factsDigest: r.facts_digest, factsKnownAt: iso(r.facts_known_at)! };
}

/**
 * 가벼운 재고정(통합 설계 3.3): 현재 ACTIVE 버전의 본문을 새 facts 봉인에 다시 고정한 새 버전을 만들어 곧바로 ACTIVE로 한다.
 * 조건: facts가 실제로 바뀌었고, 청구권자 집합이 같고, 활성화 검사가 통과한다. 아니면 전체 재승인이 필요하다.
 */
export async function rebindPolicy(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, policyId: string): Promise<{ version: number; factsDigest: string; policyDigest: string }> {
  requireRole(actor, "ACTIVATOR");
  const cur = (await tx.query("SELECT version FROM policy_version WHERE policy_id = $1 AND status = 'ACTIVE' FOR UPDATE", [policyId])).rows[0];
  if (cur === undefined) throw conflict("INVALID_STATE", `${policyId} has no ACTIVE version`);
  const row = await versionRow(tx, { policyId, version: cur.version });
  const pack = await packRow(tx, row.packId, "SHARE"); // 판정과 교체 사이에 청구권자 교체를 막는다
  if (await openDisputeInScope(tx, pack.factsScopeId)) {
    throw new DomainError("REBIND_REQUIRES_APPROVAL", 409, `${policyId}: facts scope ${pack.factsScopeId} has an open dispute; full approval required after it closes`);
  }
  const now = clock.now();
  const facts = await sealFacts(ctx, tx, pack.factsScopeId, now);
  if (facts.digest === row.factsDigest) throw conflict("REBIND_NOT_NEEDED", `${policyId} is already pinned to the current facts`);
  const diags = await checkPackActivation(ctx, tx, { factsDigest: facts.digest, declared: await declaredClaimants(tx, row.packId), at: now });
  const before = await claimantSet(ctx, tx, row.factsDigest, now);
  const after = diags.length === 0 ? await claimantSet(ctx, tx, facts.digest, now) : [];
  if (diags.length > 0 || before.join("|") !== after.join("|")) {
    throw new DomainError("REBIND_REQUIRES_APPROVAL", 409, `${policyId}: claimants changed or activation blocked; full approval required`, diags);
  }
  const version = ((await tx.query("SELECT MAX(version) AS v FROM policy_version WHERE policy_id = $1", [policyId])).rows[0].v as number) + 1;
  const { sealed, canonicalText } = await repinPolicy(ctx, tx, { policyDigest: row.policyDigest, version, facts });
  await tx.query(
    `INSERT INTO policy_version (policy_id, version, source_text, policy_digest, facts_digest, facts_known_at, status, rebind_of_version, pack_id, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'APPROVED',$7,$8,$9,$10)`,
    [policyId, version, canonicalText, sealed.digest, facts.digest, now, row.version, row.packId, actor.userId, clock.now()],
  );
  await attest(ctx, tx, clock, { userId: actor.userId, role: "ACTIVATOR", digest: sealed.digest });
  await supersedeAndActivate(tx, clock, { ...row, version, policyDigest: sealed.digest, factsDigest: facts.digest, factsKnownAt: now });
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_REBOUND", entityType: "policy_version", entityId: `${policyId}@${version}`, after: { rebindOf: row.version, factsDigest: facts.digest } });
  return { version, factsDigest: facts.digest, policyDigest: sealed.digest };
}

export { versionRow };
