import { canonicalize, digestOf } from "mdrl/core";
import type { Tx } from "../platform/db.ts";
import { notFound, DomainError } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadSealed, sealBody, sealDocument, type Sealed, type SealKind } from "./seal-store.ts";

export type AuditArtifact<T = unknown> = {
  digest: string;
  kind: string;
  format?: string;
  docId?: string;
  content: T;
};

export type AuditAttestation = {
  signerId: string;
  role: string;
  alg: string;
  signature: string;
  signedAt: string;
};

export type RunAuditManifest = {
  format: "mdrl-audit-manifest/1";
  manifest_version: "1.0";
  run_id: string;
  snapshot_id: string;
  batch_id?: string;
  created_at: string;
  artifacts: {
    facts: AuditArtifact;
    policy: AuditArtifact;
    projection: AuditArtifact;
    members: AuditArtifact;
    result: AuditArtifact;
  };
  attestations: AuditAttestation[];
  manifest_digest?: string;
};

export type BatchAuditManifest = {
  format: "mdrl-batch-audit-manifest/1";
  manifest_version: "1.0";
  batch_id: string;
  confirmed_at: string;
  confirmed_by: string;
  runs: {
    run_id: string;
    result_digest: string;
    manifest_digest: string;
  }[];
  attestations: AuditAttestation[];
  manifest_digest?: string;
};

/**
 * 특정 run_id의 발행 봉인(issue_seal)과 정산 결과(allocation_result), 서명을 종합하여
 * 외부 공개 및 감사용 단독 Manifest 번들을 구성하고 sealed_document에 봉인한다.
 */
export async function buildRunAuditManifest(
  ctx: BridgeCtx,
  tx: Tx,
  runId: string,
  nowIso = new Date().toISOString(),
): Promise<{ sealed: Sealed; manifest: RunAuditManifest }> {
  const run = (
    await tx.query(
      `SELECT r.run_id, r.snapshot_id, r.result_digest, r.batch_id, r.status
         FROM settlement_run r WHERE r.run_id = $1`,
      [runId],
    )
  ).rows[0];

  if (!run) throw notFound("settlement_run", runId);
  if (!run.result_digest) {
    throw new DomainError("RUN_NOT_SETTLED", 400, `run ${runId} has not been settled yet`);
  }

  const seal = (
    await tx.query(
      `SELECT snapshot_id, facts_digest, policy_digest, projection_digest, members_digest, as_of, known_at
         FROM issue_seal WHERE snapshot_id = $1`,
      [run.snapshot_id],
    )
  ).rows[0];

  if (!seal) throw notFound("issue_seal", run.snapshot_id);

  // 1. 봉인 문서 로드
  const factsContent = await loadSealed(ctx, tx, seal.facts_digest);
  const policyContent = await loadSealed(ctx, tx, seal.policy_digest);
  const projectionContent = await loadSealed(ctx, tx, seal.projection_digest);
  const membersContent = await loadSealed(ctx, tx, seal.members_digest);
  const resultContent = await loadSealed(ctx, tx, run.result_digest);

  // 2. 관련된 서명(attestation) 수집
  const digestsToQuery = [seal.facts_digest, seal.policy_digest, run.result_digest];
  const attRows = (
    await tx.query(
      `SELECT signer_id, role, alg, signature, signed_at
         FROM attestation WHERE digest = ANY($1::text[])
        ORDER BY signed_at ASC`,
      [digestsToQuery],
    )
  ).rows;

  const attestations: AuditAttestation[] = attRows.map((a) => ({
    signerId: a.signer_id,
    role: a.role,
    alg: a.alg,
    signature: a.signature,
    signedAt: a.signed_at instanceof Date ? a.signed_at.toISOString() : String(a.signed_at),
  }));

  const manifest: RunAuditManifest = {
    format: "mdrl-audit-manifest/1",
    manifest_version: "1.0",
    run_id: run.run_id,
    snapshot_id: run.snapshot_id,
    ...(run.batch_id && { batch_id: run.batch_id }),
    created_at: nowIso,
    artifacts: {
      facts: {
        digest: seal.facts_digest,
        kind: "facts",
        content: factsContent,
      },
      policy: {
        digest: seal.policy_digest,
        kind: "allocation",
        content: policyContent,
      },
      projection: {
        digest: seal.projection_digest,
        kind: "projection",
        content: projectionContent,
      },
      members: {
        digest: seal.members_digest,
        kind: "members",
        content: membersContent,
      },
      result: {
        digest: run.result_digest,
        kind: "allocation_result",
        content: resultContent,
      },
    },
    attestations,
  };

  // 3. 매니페스트 자체를 봉인
  const sealed = await sealDocument(ctx, tx, {
    kind: "manifest",
    value: manifest,
    docId: runId,
    format: "mdrl-audit-manifest/1",
  });

  manifest.manifest_digest = sealed.digest;
  return { sealed, manifest };
}

/**
 * 감사 번들의 무결성을 외부(Zero-Trust) 환경에서 독자 검증한다.
 * 번들 내 각 아티팩트의 digest가 canonical JCS 해시와 일치하는지 전수 검사한다.
 */
export function verifyAuditManifestIntegrity(manifest: RunAuditManifest): {
  ok: boolean;
  mismatches: string[];
} {
  const mismatches: string[] = [];

  const check = (name: string, artifact: AuditArtifact) => {
    const computed = digestOf(sealBody(artifact.kind as SealKind, artifact.content));
    if (computed !== artifact.digest) {
      mismatches.push(`${name}: expected ${artifact.digest}, got ${computed}`);
    }
  };

  check("facts", manifest.artifacts.facts);
  check("policy", manifest.artifacts.policy);
  check("projection", manifest.artifacts.projection);
  check("members", manifest.artifacts.members);
  check("result", manifest.artifacts.result);

  return {
    ok: mismatches.length === 0,
    mismatches,
  };
}
