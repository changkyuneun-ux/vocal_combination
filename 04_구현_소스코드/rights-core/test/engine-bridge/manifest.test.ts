import { test } from "node:test";
import assert from "node:assert/strict";
import { digestOf } from "mdrl/core";
import {
  verifyAuditManifestIntegrity,
  type RunAuditManifest,
} from "../../src/engine-bridge/manifest.ts";

test("verifyAuditManifestIntegrity passes when all digests match content", () => {
  const factsContent = { mdrl: "1.0", id: "facts_test", body: { work: { id: "wrk_1" } } };
  const policyContent = { mdrl: "1.0", id: "pol_test", body: { tree: {} } };
  const projectionContent = { format: "mdrl-projection/1", vectors: {} };
  const membersContent = { members: { pty_1: "1/1" } };
  const resultContent = { format: "mdrl-allocation-result/1", lines: [] };

  const manifest: RunAuditManifest = {
    format: "mdrl-audit-manifest/1",
    manifest_version: "1.0",
    run_id: "run_test_01",
    snapshot_id: "snp_test_01",
    created_at: new Date().toISOString(),
    artifacts: {
      facts: {
        digest: digestOf(factsContent),
        kind: "facts",
        content: factsContent,
      },
      policy: {
        digest: digestOf(policyContent),
        kind: "allocation",
        content: policyContent,
      },
      projection: {
        digest: digestOf(projectionContent),
        kind: "projection",
        content: projectionContent,
      },
      members: {
        digest: digestOf(membersContent),
        kind: "members",
        content: membersContent,
      },
      result: {
        digest: digestOf(resultContent),
        kind: "allocation_result",
        content: resultContent,
      },
    },
    attestations: [
      {
        signerId: "usr_admin",
        role: "SPACE_SETTLE",
        alg: "Ed25519",
        signature: "sig_dummy",
        signedAt: new Date().toISOString(),
      },
    ],
  };

  const verification = verifyAuditManifestIntegrity(manifest);
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.mismatches, []);
});

test("verifyAuditManifestIntegrity detects tampered content or invalid digest", () => {
  const factsContent = { mdrl: "1.0", id: "facts_test", body: { work: { id: "wrk_1" } } };
  const policyContent = { mdrl: "1.0", id: "pol_test", body: { tree: {} } };
  const projectionContent = { format: "mdrl-projection/1", vectors: {} };
  const membersContent = { members: { pty_1: "1/1" } };
  const resultContent = { format: "mdrl-allocation-result/1", lines: [] };

  const manifest: RunAuditManifest = {
    format: "mdrl-audit-manifest/1",
    manifest_version: "1.0",
    run_id: "run_test_02",
    snapshot_id: "snp_test_02",
    created_at: new Date().toISOString(),
    artifacts: {
      facts: {
        digest: digestOf(factsContent),
        kind: "facts",
        content: factsContent,
      },
      policy: {
        digest: digestOf(policyContent),
        kind: "allocation",
        // 변조된 내용
        content: { ...policyContent, tampered: true },
      },
      projection: {
        digest: digestOf(projectionContent),
        kind: "projection",
        content: projectionContent,
      },
      members: {
        digest: digestOf(membersContent),
        kind: "members",
        content: membersContent,
      },
      result: {
        digest: digestOf(resultContent),
        kind: "allocation_result",
        content: resultContent,
      },
    },
    attestations: [],
  };

  const verification = verifyAuditManifestIntegrity(manifest);
  assert.equal(verification.ok, false);
  assert.equal(verification.mismatches.length, 1);
  assert.ok(verification.mismatches[0]!.includes("policy: expected"));
});
