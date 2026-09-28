import { fail } from "../core/errors.ts";
import { ONE, cmp, sum, type Ratio } from "../core/ratio.ts";

export type Share = { key: string; weight: Ratio };
export type Allotment = { key: string; weight: Ratio; amount: bigint };

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * HIERARCHICAL_LRM_V1의 한 층(스펙 5.5): floor(R·w) 후 잔여 Δ를 소수부 내림차순,
 * 동률은 key 오름차순으로 1씩 배분한다. 결과는 입력 순서를 유지한다.
 */
export function splitLrm(total: bigint, shares: readonly Share[], path = "$"): Allotment[] {
  if (total < 0n) fail("CORE_TYPE_ERROR", path, "negative total");
  if (shares.length === 0) fail("ALLOC_EMPTY_VECTOR", path);
  if (new Set(shares.map((s) => s.key)).size !== shares.length) fail("ALLOC_DUPLICATE_NAME", path, "duplicate key");
  if (shares.some((s) => s.weight.n < 0n)) fail("CORE_TYPE_ERROR", path, "negative weight");
  if (cmp(sum(shares.map((s) => s.weight)), ONE) !== 0) fail("ALLOC_WEIGHT_MISMATCH", path, "weights must sum to 1");

  const rows = shares.map((s) => {
    const num = total * s.weight.n;
    return { key: s.key, weight: s.weight, amount: num / s.weight.d, rem: num % s.weight.d };
  });
  let delta = total - rows.reduce((a, r) => a + r.amount, 0n);
  const order = [...rows].sort((a, b) => {
    const l = a.rem * b.weight.d;
    const r = b.rem * a.weight.d;
    return l > r ? -1 : l < r ? 1 : byKey(a.key, b.key);
  });
  for (const row of order) {
    if (delta === 0n) break;
    row.amount += 1n;
    delta -= 1n;
  }
  const out = rows.map(({ key, weight, amount }) => ({ key, weight, amount }));
  if (out.reduce((a, r) => a + r.amount, 0n) !== total) fail("ALLOC_ROUNDING_INVARIANT", path);
  return out;
}
