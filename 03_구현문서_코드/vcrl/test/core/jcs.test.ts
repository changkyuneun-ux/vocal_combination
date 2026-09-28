import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../../src/core/jcs.ts";
import { VcrlError } from "../../src/core/errors.ts";

test("keys sorted, no whitespace", () => {
  assert.equal(canonicalize({ b: [true, null], a: "1" }), '{"a":"1","b":[true,null]}');
});

test("undefined properties are dropped", () => {
  assert.equal(canonicalize({ a: "1", z: undefined }), '{"a":"1"}');
});

test("numbers are rejected with path", () => {
  assert.throws(
    () => canonicalize({ a: [ "x", 1 ] }),
    (e: unknown) => e instanceof VcrlError && e.diagnostics[0]?.code === "CORE_NUMBER_IN_IR" && e.diagnostics[0]?.path === "$.a[1]",
  );
});

test("non-plain objects rejected", () => {
  assert.throws(() => canonicalize({ d: new Date(0) }), VcrlError);
  assert.throws(() => canonicalize({ b: 1n }), VcrlError);
});

test("keys sorted by UTF-16 code units", () => {
  assert.equal(canonicalize({ "é": "x", z: "y", A: "w" }), '{"A":"w","z":"y","é":"x"}');
});
