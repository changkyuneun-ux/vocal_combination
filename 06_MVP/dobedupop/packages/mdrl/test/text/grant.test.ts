import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGrant } from "../../src/text/format-grant.ts";
import { parseGrant, compileGrant } from "../../src/text/parse-grant.ts";
import type { GrantDoc } from "../../src/grant/types.ts";

const sampleGrantDoc: GrantDoc = {
  mdrl: "1.0",
  module: "grant",
  id: "GRANT-DEMO-01",
  version: "1",
  depends_on: [],
  visibility_default: "PARTIES",
  body: {
    grants: [
      {
        id: "rule_01",
        grantor: "pty_label_1",
        grantee: "pty_user_1",
        asset: "ast_recording_1",
        right_type: "MASTER",
        scope: {
          actions: ["COMBINE", "DOWNLOAD", "PREVIEW"],
          territories: ["JP", "KR", "US"],
          media: ["APP", "STREAM"],
          period: { from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
          audience: ["COMMERCIAL", "PUBLIC"],
        },
        obligations: ["ATTRIBUTION"],
        status: "VERIFIED",
        valid: { from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
        recorded_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
};

test("formatGrant and parseGrant round-trip", () => {
  const formatted = formatGrant(sampleGrantDoc);
  const parsed = parseGrant(formatted);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.id, sampleGrantDoc.id);
    assert.equal(parsed.value.version, sampleGrantDoc.version);
    assert.deepEqual(parsed.value.body.grants, sampleGrantDoc.body.grants);
  }
});

test("compileGrant validates body structure", () => {
  const formatted = formatGrant(sampleGrantDoc);
  const compiled = compileGrant(formatted);
  assert.equal(compiled.ok, true);
});

test("parseGrant reports syntax errors", () => {
  const bad = 'grant "bad" version 1 {\n  rule r1 { invalid_field: x; }\n}';
  const parsed = parseGrant(bad);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.errors[0]);
    assert.equal(parsed.errors[0].code, "PARSE_SYNTAX");
    assert.equal(parsed.errors[0].path.startsWith("@2:"), true);
  }
});
