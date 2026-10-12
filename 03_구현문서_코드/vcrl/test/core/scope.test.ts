import { test } from "node:test";
import assert from "node:assert/strict";
import type { Scope } from "../../src/core/scope.ts";

import {
  isScope,
  validateScope,
  intersectScope,
  isSubScope,
  assertScopeNarrowing,
} from "../../src/core/scope.ts";
import { VcrlError } from "../../src/core/errors.ts";



const scopeA: Scope = {
  actions: ["COMBINE", "PREVIEW", "DOWNLOAD"],
  territories: ["KR", "US", "JP"],
  media: ["APP", "STREAM"],
  period: { from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
  audience: ["COMMERCIAL", "PUBLIC"],
};

const scopeB: Scope = {
  actions: ["COMBINE", "PREVIEW"],
  territories: ["KR", "JP"],
  media: ["APP"],
  period: { from: "2026-06-01T00:00:00.000Z", to: "2026-12-31T00:00:00.000Z" },
  audience: ["PUBLIC"],
};

const scopeDisjoint: Scope = {
  actions: ["AI_TRAIN"],
  territories: ["FR"],
  media: ["BROADCAST"],
  period: { from: "2028-01-01T00:00:00.000Z" },
  audience: ["PERSONAL"],
};

test("isScope and validateScope on valid scope", () => {
  assert.equal(isScope(scopeA), true);
  assert.equal(isScope(scopeB), true);
  assert.deepEqual(validateScope(scopeA), []);
});

test("validateScope rejects invalid fields", () => {
  const invalid = { ...scopeA, unknown_prop: 123 };
  const errs = validateScope(invalid);
  assert.equal(errs.length > 0, true);
  assert.equal(errs[0].code, "CORE_TYPE_ERROR");
});

test("isSubScope checks subset inclusion", () => {
  assert.equal(isSubScope(scopeB, scopeA), true);
  assert.equal(isSubScope(scopeA, scopeB), false);
  assert.equal(isSubScope(scopeDisjoint, scopeA), false);
});

test("intersectScope calculates meet", () => {
  const meet = intersectScope(scopeA, scopeB);
  assert.notEqual(meet, null);
  assert.deepEqual(meet?.actions, ["COMBINE", "PREVIEW"]);
  assert.deepEqual(meet?.territories, ["JP", "KR"]);
  assert.deepEqual(meet?.media, ["APP"]);
  assert.deepEqual(meet?.audience, ["PUBLIC"]);
  assert.deepEqual(meet?.period, {
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-12-31T00:00:00.000Z",
  });
});

test("intersectScope returns null if disjoint", () => {
  const disjoint = intersectScope(scopeA, scopeDisjoint);
  assert.equal(disjoint, null);
});

test("assertScopeNarrowing enforces sub-scope invariant", () => {
  assert.doesNotThrow(() => {
    assertScopeNarrowing(scopeA, scopeB);
  });

  assert.throws(
    () => {
      assertScopeNarrowing(scopeB, scopeA);
    },
    (err: unknown) => {
      return err instanceof VcrlError && err.diagnostics[0].code === "GRANT_SCOPE_WIDENING";
    }
  );
});
