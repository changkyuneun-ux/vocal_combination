import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capVector, fixedVector, floorGuarantee, mixVectors, parseVector, usageVector,
} from "../../src/allocation/vectors.ts";
import { ONE, fromBps, ratio, sum } from "../../src/core/ratio.ts";
import { VcrlError } from "../../src/core/errors.ts";

const r = (n: bigint, d: bigint) => ratio(n, d);
const code = (c: string) => (e: unknown) => e instanceof VcrlError && e.diagnostics[0]?.code === c;

test("parseVector parses ratios, sorts keys and requires sum 1", () => {
  const v = parseVector({ pty_b: "1/3", "@hold": "1/3", pty_a: "1/3" }, "$.v");
  assert.deepEqual(Object.keys(v), ["@hold", "pty_a", "pty_b"]);
  assert.deepEqual(v.pty_a, r(1n, 3n));
  assert.throws(() => parseVector({ a: "1/2" }, "$.v"), code("ALLOC_WEIGHT_MISMATCH"));
  assert.throws(() => parseVector({}, "$.v"), code("ALLOC_EMPTY_VECTOR"));
  assert.throws(() => parseVector({ "a|b": "1/1" }, "$.v"), code("CORE_TYPE_ERROR"));
  assert.throws(() => parseVector({ a: "2/4" }, "$.v"), code("CORE_TYPE_ERROR"));
  assert.throws(() => parseVector({ a: 1 }, "$.v"), code("CORE_TYPE_ERROR"));
  assert.throws(() => parseVector({ a: "3/2", b: "-1/2" }, "$.v"), code("CORE_TYPE_ERROR"));
  assert.throws(
    () => parseVector(JSON.parse('{"__proto__":"1/2","a":"1/2"}'), "$.v"),
    code("CORE_TYPE_ERROR"),
  );
});

test("mixVectors merges keys with weights", () => {
  const v = mixVectors([
    { weight: fromBps(4000), vec: { a: r(1n, 2n), b: r(1n, 2n) } },
    { weight: fromBps(6000), vec: { a: r(2n, 3n), b: r(1n, 3n) } },
  ]);
  assert.deepEqual(v, { a: r(3n, 5n), b: r(2n, 5n) });
});

test("fixedVector splits equally", () => {
  assert.deepEqual(fixedVector(["b", "a", "c"], "$"), { a: r(1n, 3n), b: r(1n, 3n), c: r(1n, 3n) });
  assert.throws(() => fixedVector([], "$"), code("ALLOC_EMPTY_VECTOR"));
});

test("usageVector mixes featured and non-featured, or uses the one present", () => {
  const f = { a: ONE };
  const n = { b: ONE };
  assert.deepEqual(usageVector(f, n, fromBps(7000), "$"), { a: r(7n, 10n), b: r(3n, 10n) });
  assert.deepEqual(usageVector(f, undefined, fromBps(7000), "$"), f);
  assert.deepEqual(usageVector(undefined, n, fromBps(7000), "$"), n);
  assert.throws(() => usageVector(undefined, undefined, fromBps(7000), "$"), code("ALLOC_EMPTY_VECTOR"));
});

test("capVector redistributes the excess proportionally", () => {
  assert.deepEqual(capVector({ a: r(3n, 5n), b: r(3n, 10n), c: r(1n, 10n) }, r(1n, 2n), "$"), {
    a: r(1n, 2n), b: r(3n, 8n), c: r(1n, 8n),
  });
  assert.deepEqual(capVector({ a: r(2n, 3n), b: r(1n, 3n) }, fromBps(6000), "$"), { a: r(3n, 5n), b: r(2n, 5n) });
  // @hold는 제한·재분배 대상이 아니다
  assert.deepEqual(capVector({ "@hold": r(1n, 5n), a: r(3n, 5n), b: r(1n, 5n) }, r(1n, 2n), "$"), {
    "@hold": r(1n, 5n), a: r(1n, 2n), b: r(3n, 10n),
  });
  assert.throws(() => capVector({ a: ONE }, r(1n, 2n), "$"), code("ALLOC_INFEASIBLE"));
  // 다단계 수위 채우기: 1회차에 a만 걸리고, 2회차 재분배 후에는 아무도 걸리지 않는다.
  // round 1: scale=1, a=9/20=0.45 > 2/5 → capped. round 2: remaining=3/5, free b+c=11/20,
  // scale=12/11 → b=7/20*12/11=21/55≈0.3818, c=1/5*12/11=12/55≈0.2182, 둘 다 max 이하.
  assert.deepEqual(capVector({ a: r(9n, 20n), b: r(7n, 20n), c: r(1n, 5n) }, r(2n, 5n), "$"), {
    a: r(2n, 5n), b: r(21n, 55n), c: r(12n, 55n),
  });
});

test("floorGuarantee raises unselected members and scales the rest", () => {
  assert.deepEqual(floorGuarantee({ a: r(9n, 10n), b: r(1n, 10n) }, ["a", "b", "c"], r(1n, 10n), "$"), {
    a: r(4n, 5n), b: r(1n, 10n), c: r(1n, 10n),
  });
  assert.deepEqual(floorGuarantee({ label: ONE }, ["a", "b"], fromBps(1000), "$"), {
    a: r(1n, 10n), b: r(1n, 10n), label: r(4n, 5n),
  });
  assert.throws(() => floorGuarantee({ a: ONE }, ["a", "b", "c"], r(2n, 5n), "$"), code("ALLOC_INFEASIBLE"));
});

test("results always sum to exactly 1", () => {
  const v = floorGuarantee(capVector({ a: r(7n, 10n), b: r(2n, 10n), c: r(1n, 10n) }, r(1n, 2n), "$"), ["a", "b", "c", "d"], r(1n, 20n), "$");
  assert.deepEqual(sum(Object.values(v)), ONE);
});

test("Object.prototype member names are ordinary party ids", () => {
  assert.deepEqual(floorGuarantee({ a: ONE }, ["constructor", "toString"], r(1n, 10n), "$"), {
    a: r(4n, 5n), constructor: r(1n, 10n), toString: r(1n, 10n),
  });
  assert.deepEqual(capVector({ constructor: r(3n, 5n), valueOf: r(2n, 5n) }, r(1n, 2n), "$"), {
    constructor: r(1n, 2n), valueOf: r(1n, 2n),
  });
});
