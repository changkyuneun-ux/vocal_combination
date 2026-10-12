import { test } from "node:test";
import assert from "node:assert/strict";
import { splitByWeights } from "../../src/ledger/split.ts";

const obj = (m: Map<string, bigint>) => Object.fromEntries([...m].map(([k, v]) => [k, v.toString()]));

test("exact weights split without remainder", () => {
  assert.deepEqual(obj(splitByWeights(700n, [{ key: "a", weight: 300n }, { key: "b", weight: 400n }])), { a: "300", b: "400" });
});

test("leftover units go to the largest remainders, ties by key ascending", () => {
  // 10 / 3 each → 3,3,3 remainder 1 → tie → smallest key
  assert.deepEqual(obj(splitByWeights(10n, [{ key: "c", weight: 1n }, { key: "a", weight: 1n }, { key: "b", weight: 1n }])), { a: "4", b: "3", c: "3" });
  // 100 × (1,2,4)/7 = 14.28, 28.57, 57.14 → floors 14,28,57 (99), largest remainder b(.57)
  assert.deepEqual(obj(splitByWeights(100n, [{ key: "a", weight: 1n }, { key: "b", weight: 2n }, { key: "c", weight: 4n }])), { a: "14", b: "29", c: "57" });
});

test("a negative total splits its magnitude and keeps the sign", () => {
  const m = splitByWeights(-10n, [{ key: "a", weight: 1n }, { key: "b", weight: 1n }, { key: "c", weight: 1n }]);
  assert.deepEqual(obj(m), { a: "-4", b: "-3", c: "-3" });
});

test("the parts always sum to the total", () => {
  for (const total of [0n, 1n, 7n, 12345n, -999n]) {
    const m = splitByWeights(total, [{ key: "x", weight: 3n }, { key: "y", weight: 5n }, { key: "z", weight: 11n }, { key: "w", weight: 0n }]);
    assert.equal([...m.values()].reduce((a, v) => a + v, 0n), total);
    assert.equal(m.get("w"), 0n);
  }
});

test("rejects empty, negative or zero-sum weights and duplicate keys", () => {
  assert.throws(() => splitByWeights(1n, []));
  assert.throws(() => splitByWeights(1n, [{ key: "a", weight: 0n }]));
  assert.throws(() => splitByWeights(1n, [{ key: "a", weight: -1n }, { key: "b", weight: 2n }]));
  assert.throws(() => splitByWeights(1n, [{ key: "a", weight: 1n }, { key: "a", weight: 1n }]));
});
