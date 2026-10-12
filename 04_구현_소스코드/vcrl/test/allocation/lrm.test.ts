import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLrm, type Share } from "../../src/allocation/lrm.ts";
import { fromBps, ratio } from "../../src/core/ratio.ts";
import { VcrlError } from "../../src/core/errors.ts";
import { int, randomSplit, rng, shuffle } from "../prop.ts";

const shares = (...xs: [string, number][]): Share[] => xs.map(([key, bps]) => ({ key, weight: fromBps(bps) }));
const amounts = (xs: { key: string; amount: bigint }[]) => xs.map((x) => [x.key, x.amount]);
const code = (c: string) => (e: unknown) => e instanceof VcrlError && e.diagnostics[0]?.code === c;

test("exact split keeps input order", () => {
  assert.deepEqual(amounts(splitLrm(10000n, shares(["platform", 2500], ["ops", 500], ["rights", 7000]))), [
    ["platform", 2500n], ["ops", 500n], ["rights", 7000n],
  ]);
});

test("remainder goes to the largest fraction", () => {
  // 1001 × (0.25, 0.05, 0.7) = 250.25, 50.05, 700.7 → Δ=1 → rights
  assert.deepEqual(amounts(splitLrm(1001n, shares(["platform", 2500], ["ops", 500], ["rights", 7000]))), [
    ["platform", 250n], ["ops", 50n], ["rights", 701n],
  ]);
});

test("equal fractions break ties by key ascending", () => {
  // 701 × (0.45, 0.45, 0.1) = 315.45, 315.45, 70.1 → Δ=1 → "master" < "performer"
  assert.deepEqual(amounts(splitLrm(701n, shares(["performer", 4500], ["master", 4500], ["work", 1000]))), [
    ["performer", 315n], ["master", 316n], ["work", 70n],
  ]);
  // 1 × (1/3, 1/3, 1/3) → Δ=1 → 가장 작은 key
  const third = ratio(1n, 3n);
  assert.deepEqual(amounts(splitLrm(1n, [{ key: "b", weight: third }, { key: "a", weight: third }, { key: "c", weight: third }])), [
    ["b", 0n], ["a", 1n], ["c", 0n],
  ]);
});

test("zero total and zero weights", () => {
  assert.deepEqual(amounts(splitLrm(0n, shares(["a", 5000], ["b", 5000]))), [["a", 0n], ["b", 0n]]);
  assert.deepEqual(amounts(splitLrm(3n, shares(["a", 0], ["b", 10000]))), [["a", 0n], ["b", 3n]]);
});

test("invalid inputs", () => {
  assert.throws(() => splitLrm(10n, []), code("ALLOC_EMPTY_VECTOR"));
  assert.throws(() => splitLrm(10n, shares(["a", 5000], ["a", 5000])), code("ALLOC_DUPLICATE_NAME"));
  assert.throws(() => splitLrm(10n, shares(["a", 5000], ["b", 4000])), code("ALLOC_WEIGHT_MISMATCH"));
  assert.throws(() => splitLrm(-1n, shares(["a", 10000])), code("CORE_TYPE_ERROR"));
  assert.throws(() => splitLrm(10n, [{ key: "a", weight: ratio(-1n, 2n) }, { key: "b", weight: ratio(3n, 2n) }]), code("CORE_TYPE_ERROR"));
});

test("property: sums are exact, each amount is floor or floor+1, order-independent per key", () => {
  const r = rng(20260928);
  for (let round = 0; round < 300; round++) {
    const n = int(r, 1, 8);
    const bps = randomSplit(r, n);
    const input = bps.map((b, i) => ({ key: `k${i}`, weight: fromBps(b) }));
    const total = BigInt(int(r, 0, 10_000_000));
    const out = splitLrm(total, input);
    assert.equal(out.reduce((a, x) => a + x.amount, 0n), total);
    for (const x of out) {
      const floor = (total * x.weight.n) / x.weight.d;
      assert.ok(x.amount === floor || x.amount === floor + 1n, `${x.key}`);
    }
    const again = new Map(splitLrm(total, shuffle(r, input)).map((x) => [x.key, x.amount]));
    for (const x of out) assert.equal(again.get(x.key), x.amount);
  }
});
