import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE, ZERO, add, cmp, div, formatRatio, fromBps, mul, parseRatio, ratio, sub, sum } from "../../src/core/ratio.ts";
import { MdrlError } from "../../src/core/errors.ts";

const isCode = (code: string) => (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === code;

test("ratio normalizes sign and lowest terms", () => {
  assert.deepEqual(ratio(6n, -4n), { n: -3n, d: 2n });
  assert.deepEqual(ratio(0n, 7n), ZERO);
});

test("zero denominator throws CORE_TYPE_ERROR", () => {
  assert.throws(() => ratio(1n, 0n), isCode("CORE_TYPE_ERROR"));
  assert.throws(() => div(ONE, ZERO), isCode("CORE_TYPE_ERROR"));
});

test("arithmetic is exact", () => {
  const third = ratio(1n, 3n);
  assert.deepEqual(add(third, third), ratio(2n, 3n));
  assert.deepEqual(sum([third, third, third]), ONE);
  assert.deepEqual(sub(ONE, third), ratio(2n, 3n));
  assert.deepEqual(mul(fromBps(6000), ratio(2n, 3n)), ratio(2n, 5n));
  assert.deepEqual(div(ratio(3n, 5n), ratio(3n, 4n)), ratio(4n, 5n));
  assert.equal(cmp(third, ratio(1n, 2n)), -1);
  assert.equal(cmp(ratio(2n, 4n), ratio(1n, 2n)), 0);
  assert.equal(cmp(ONE, third), 1);
});

test("format and parse round-trip; non-canonical rejected", () => {
  assert.equal(formatRatio(fromBps(1250)), "1/8");
  assert.equal(formatRatio(ONE), "1/1");
  assert.deepEqual(parseRatio("3/7"), ratio(3n, 7n));
  for (const bad of ["2/4", "1.5/2", "3", "-0/1", "1/0"]) assert.throws(() => parseRatio(bad), MdrlError, bad);
});
