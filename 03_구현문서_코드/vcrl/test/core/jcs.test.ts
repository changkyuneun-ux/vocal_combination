import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_JSON_DEPTH, canonicalize } from "../../src/core/jcs.ts";
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

test("lone surrogates are rejected in values and keys", () => {
  const isTypeError = (path: string) => (e: unknown) =>
    e instanceof VcrlError && e.diagnostics[0]?.code === "CORE_TYPE_ERROR" && e.diagnostics[0]?.path === path;
  assert.throws(() => canonicalize({ a: "x\ud800" }), isTypeError("$.a"));
  assert.throws(() => canonicalize({ "\ud800": "x" }), isTypeError("$.\ud800"));
  assert.equal(canonicalize({ a: "😀" }), '{"a":"😀"}');
});

/** 배열을 n겹 중첩한다(최상위 배열 = 깊이 1). */
function nestedArray(n: number): unknown {
  let v: unknown = [];
  for (let i = 1; i < n; i++) v = [v];
  return v;
}
const tooDeep = (e: unknown) =>
  e instanceof VcrlError && e.diagnostics.length === 1 && e.diagnostics[0]!.code === "CORE_TYPE_ERROR" && /nesting too deep/.test(e.diagnostics[0]!.message);

test("nesting up to MAX_JSON_DEPTH (256) is accepted, deeper is CORE_TYPE_ERROR", () => {
  assert.equal(MAX_JSON_DEPTH, 256);
  assert.equal(canonicalize(nestedArray(256)), "[".repeat(256) + "]".repeat(256));
  assert.throws(() => canonicalize(nestedArray(257)), (e: unknown) => tooDeep(e) && (e as VcrlError).diagnostics[0]!.path === "$" + "[0]".repeat(256));
  let o: unknown = {};
  for (let i = 1; i < 257; i++) o = { k: o };
  assert.throws(() => canonicalize(o), tooDeep);
});

test("a 100,000-deep array fails with CORE_TYPE_ERROR instead of a RangeError", () => {
  assert.throws(() => canonicalize(nestedArray(100_000)), tooDeep);
});
