import { test } from "node:test";
import assert from "node:assert/strict";
import { ENUMS, isEnumValue } from "../../src/core/enums.ts";

test("no duplicate values in any enum", () => {
  for (const [name, values] of Object.entries(ENUMS)) {
    assert.equal(new Set(values).size, values.length, name);
  }
});

test("stamp_clause is a subset of action", () => {
  for (const c of ENUMS.stamp_clause) assert.ok((ENUMS.action as readonly string[]).includes(c), c);
});

test("isEnumValue", () => {
  assert.equal(isEnumValue("claimant_role", "CMO"), true);
  assert.equal(isEnumValue("claimant_role", "cmo"), false);
  assert.equal(isEnumValue("approval_mode", "SPACE"), false);
  assert.equal(isEnumValue("visibility", 1), false);
});
