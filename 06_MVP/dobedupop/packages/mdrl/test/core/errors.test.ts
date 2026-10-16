import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ERROR_CODES, LEGACY_ERROR_MAP, MdrlError, attempt, capture, describe, diag, fail } from "../../src/core/errors.ts";

test("diag composes message from registry", () => {
  assert.deepEqual(diag("FACTS_CYCLE", "$.body.mandates", "m1"), {
    code: "FACTS_CYCLE",
    path: "$.body.mandates",
    message: `${ERROR_CODES.FACTS_CYCLE}: m1`,
  });
  assert.equal(diag("FACTS_CYCLE", "$").message, ERROR_CODES.FACTS_CYCLE);
});

test("fail throws MdrlError carrying diagnostics", () => {
  assert.throws(
    () => fail("CORE_TYPE_ERROR", "$.x"),
    (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === "CORE_TYPE_ERROR",
  );
});

test("capture converts MdrlError into diagnostics and rethrows others", () => {
  assert.deepEqual(capture(() => fail("CORE_TYPE_ERROR", "$.y")).map((d) => d.code), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(capture(() => 1), []);
  assert.throws(() => capture(() => { throw new TypeError("boom"); }), TypeError);
});

test("legacy codes map into the registry", () => {
  for (const v of Object.values(LEGACY_ERROR_MAP)) assert.ok(v in ERROR_CODES, v);
});

test("spec/error-codes.md lists exactly the registry", () => {
  const md = readFileSync(new URL("../../spec/error-codes.md", import.meta.url), "utf8");
  const listed = [...md.matchAll(/^\| `([A-Z]+_[A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), Object.keys(ERROR_CODES).sort());
});

test("attempt turns MdrlError into a failed Result and passes values through", () => {
  assert.deepEqual(attempt(() => 7), { ok: true, value: 7 });
  const r = attempt(() => fail("ALLOC_INFEASIBLE", "$.v"));
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.errors.map((d) => d.code), ["ALLOC_INFEASIBLE"]);
  assert.throws(() => attempt(() => { throw new TypeError("boom"); }), TypeError);
});

test("describe never throws on hostile values", () => {
  assert.equal(describe("x"), "x");
  assert.equal(describe(1), "1");
  assert.equal(describe(null), "null");
  assert.equal(describe(undefined), "undefined");
  assert.equal(describe(JSON.parse('{"toString":1}')), "object");
  assert.equal(describe(Object.create(null)), "object");
  assert.equal(describe([]), "array");
});
