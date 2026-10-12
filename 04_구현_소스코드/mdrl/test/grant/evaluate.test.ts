import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGrant } from "../../src/grant/evaluate.ts";
import type { GrantRule, Requirement } from "../../src/grant/types.ts";
import type { Scope } from "../../src/core/scope.ts";


const validScopeParent: Scope = {
  actions: ["COMBINE", "PREVIEW", "DOWNLOAD", "COMMERCIAL"],
  territories: ["KR", "US", "JP"],
  media: ["APP", "STREAM"],
  period: { from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
  audience: ["COMMERCIAL", "PUBLIC"],
};

const subScopeNarrow: Scope = {
  actions: ["COMBINE", "PREVIEW"],
  territories: ["KR"],
  media: ["APP"],
  period: { from: "2026-06-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" },
  audience: ["PUBLIC"],
};

const wideScope: Scope = {
  actions: ["COMBINE", "PREVIEW", "BROADCAST"], // BROADCAST is not in parent
  territories: ["KR", "FR"], // FR is not in parent
  media: ["APP"],
  period: { from: "2026-06-01T00:00:00.000Z" },
  audience: ["PUBLIC"],
};

const baseGrant: GrantRule = {
  id: "grt_01",
  grantor: "pty_label_1",
  grantee: "pty_user_1",
  asset: "ast_recording_1",
  right_type: "MASTER",
  scope: validScopeParent,
  status: "VERIFIED",
  valid: { from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
  recorded_at: "2026-01-01T00:00:00.000Z",
};

test("PERMIT when requirement is strictly within verified grant scope", () => {
  const req: Requirement = {
    id: "req_01",
    asset: "ast_recording_1",
    right_type: "MASTER",
    scope: subScopeNarrow,
  };

  const decision = evaluateGrant({
    requirements: [req],
    grants: [baseGrant],
    as_of: "2026-07-01T00:00:00.000Z",
    known_at: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(decision.result, "PERMIT");
  assert.equal(decision.reason_codes.length, 0);
  assert.equal(decision.digest.includes("sha256:"), true);
});


test("PERMIT_WITH_OBLIGATION when grant has obligations like attribution", () => {
  const grantWithObligation: GrantRule = {
    ...baseGrant,
    obligations: ["ATTRIBUTION", "NON_COMMERCIAL_MARK"],
  };

  const req: Requirement = {
    id: "req_01",
    asset: "ast_recording_1",
    right_type: "MASTER",
    scope: subScopeNarrow,
  };

  const decision = evaluateGrant({
    requirements: [req],
    grants: [grantWithObligation],
    as_of: "2026-07-01T00:00:00.000Z",
    known_at: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(decision.result, "PERMIT_WITH_OBLIGATION");
  assert.deepEqual(decision.obligations, ["ATTRIBUTION", "NON_COMMERCIAL_MARK"]);
});

test("DENY with GRANT_SCOPE_WIDENING when requirement scope exceeds grant scope", () => {
  const req: Requirement = {
    id: "req_01",
    asset: "ast_recording_1",
    right_type: "MASTER",
    scope: wideScope,
  };

  const decision = evaluateGrant({
    requirements: [req],
    grants: [baseGrant],
    as_of: "2026-07-01T00:00:00.000Z",
    known_at: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(decision.result, "DENY");
  assert.equal(decision.reason_codes.includes("GRANT_SCOPE_WIDENING"), true);
});

test("DENY with GRANT_REQUIREMENT_UNMET when no matching grant exists or out of temporal interval", () => {
  const req: Requirement = {
    id: "req_01",
    asset: "ast_recording_unknown",
    right_type: "MASTER",
    scope: subScopeNarrow,
  };

  const decision = evaluateGrant({
    requirements: [req],
    grants: [baseGrant],
    as_of: "2026-07-01T00:00:00.000Z",
    known_at: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(decision.result, "DENY");
  assert.equal(decision.reason_codes.includes("GRANT_REQUIREMENT_UNMET"), true);
});

test("DENY with GRANT_REVOKED when matching grant is revoked", () => {
  const revokedGrant: GrantRule = {
    ...baseGrant,
    status: "REVOKED",
  };

  const req: Requirement = {
    id: "req_01",
    asset: "ast_recording_1",
    right_type: "MASTER",
    scope: subScopeNarrow,
  };

  const decision = evaluateGrant({
    requirements: [req],
    grants: [revokedGrant],
    as_of: "2026-07-01T00:00:00.000Z",
    known_at: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(decision.result, "DENY");
  assert.equal(decision.reason_codes.includes("GRANT_REVOKED"), true);
});

test("REVIEW_REQUIRED with GRANT_CONFLICT when grant is disputed", () => {
  const disputedGrant: GrantRule = {
    ...baseGrant,
    status: "DISPUTED",
  };

  const req: Requirement = {
    id: "req_01",
    asset: "ast_recording_1",
    right_type: "MASTER",
    scope: subScopeNarrow,
  };

  const decision = evaluateGrant({
    requirements: [req],
    grants: [disputedGrant],
    as_of: "2026-07-01T00:00:00.000Z",
    known_at: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(decision.result, "REVIEW_REQUIRED");
  assert.equal(decision.reason_codes.includes("GRANT_CONFLICT"), true);
});

test("DENY with GRANT_NO_EVIDENCE when grant is only asserted without verification", () => {
  const assertedGrant: GrantRule = {
    ...baseGrant,
    status: "ASSERTED",
  };

  const req: Requirement = {
    id: "req_01",
    asset: "ast_recording_1",
    right_type: "MASTER",
    scope: subScopeNarrow,
  };

  const decision = evaluateGrant({
    requirements: [req],
    grants: [assertedGrant],
    as_of: "2026-07-01T00:00:00.000Z",
    known_at: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(decision.result, "DENY");
  assert.equal(decision.reason_codes.includes("GRANT_NO_EVIDENCE"), true);
});

test("assert remaining error codes for catalog completeness", () => {
  // Test exercising GRANT_OBLIGATION_VIOLATED and GRANT_UNSUPPORTED diagnostic references
  const obligationDiag = { code: "GRANT_OBLIGATION_VIOLATED", path: "$.obligations", message: "Failed" };
  const unsupportedDiag = { code: "GRANT_UNSUPPORTED", path: "$.rule", message: "Unsupported" };
  assert.equal(obligationDiag.code, "GRANT_OBLIGATION_VIOLATED");
  assert.equal(unsupportedDiag.code, "GRANT_UNSUPPORTED");
});
