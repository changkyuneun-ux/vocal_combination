import { test } from "node:test";
import assert from "node:assert/strict";
import { isId, rejectUnknownKeys } from "../../src/core/shape.ts";

test("isId accepts the VCRL id alphabet only", () => {
  for (const ok of ["pty_a", "VC-ALLOC.1", "a"]) assert.equal(isId(ok), true, ok);
  for (const bad of ["@hold", "a|b", "a,b", "", "한글", 1, "__proto__"]) assert.equal(isId(bad), false, String(bad));
});

test("rejectUnknownKeys reports each extra key with its path", () => {
  assert.deepEqual(rejectUnknownKeys({ a: "1", b: "2" }, ["a", "b"], "$.x"), []);
  assert.deepEqual(
    rejectUnknownKeys({ a: "1", z: "2", y: "3" }, ["a"], "$.x").map((d) => [d.code, d.path]),
    [["CORE_TYPE_ERROR", "$.x.z"], ["CORE_TYPE_ERROR", "$.x.y"]],
  );
});
