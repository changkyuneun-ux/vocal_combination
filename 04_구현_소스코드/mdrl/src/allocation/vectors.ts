import { fail } from "../core/errors.ts";
import { ONE, ZERO, add, cmp, div, mul, parseRatio, ratio, sub, sum, type Ratio } from "../core/ratio.ts";
import { isId } from "../core/shape.ts";
import { HOLD, type PartyVector } from "../facts/project.ts";

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 벡터에서 k의 가중치(없으면 0). `constructor` 같은 상속 속성을 읽지 않도록 소유 속성만 본다. */
const weightOf = (vec: PartyVector, k: string): Ratio => (Object.hasOwn(vec, k) ? vec[k]! : ZERO);

/** 같은 키는 더하고 키를 코드 유닛 오름차순으로 정렬한 벡터를 만든다. */
export function collect(entries: Iterable<[string, Ratio]>): PartyVector {
  const m = new Map<string, Ratio>();
  for (const [k, w] of entries) m.set(k, add(m.get(k) ?? ZERO, w));
  const out: PartyVector = {};
  for (const k of [...m.keys()].sort(byKey)) out[k] = m.get(k)!;
  return out;
}

/** 벡터 항목을 키 코드 유닛 오름차순으로 돌려준다. 정수 모양 키("9", "10")도 JS 객체 열거 순서와 무관하게 정렬된다. */
export function sortedEntries(vec: PartyVector): [string, Ratio][] {
  return Object.keys(vec).sort(byKey).map((k): [string, Ratio] => [k, vec[k]!]);
}

/** `{ party: "n/d" }` 문자열 벡터를 파싱한다. 키는 party id 또는 `@hold`, 합은 정확히 1이어야 한다. */
export function parseVector(v: unknown, path: string): PartyVector {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("CORE_TYPE_ERROR", path, "vector must be an object");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) fail("ALLOC_EMPTY_VECTOR", path);
  const parsed = entries.map(([k, s]): [string, Ratio] => {
    const p = `${path}.${k}`;
    if (k !== HOLD && !isId(k)) fail("CORE_TYPE_ERROR", p, "not a party id");
    if (typeof s !== "string") fail("CORE_TYPE_ERROR", p, "ratio string required");
    const w = parseRatio(s, p);
    if (w.n < 0n) fail("CORE_TYPE_ERROR", p, "negative weight");
    return [k, w];
  });
  if (cmp(sum(parsed.map(([, w]) => w)), ONE) !== 0) fail("ALLOC_WEIGHT_MISMATCH", path, "vector must sum to 1");
  return collect(parsed);
}

export function mixVectors(parts: readonly { weight: Ratio; vec: PartyVector }[]): PartyVector {
  return collect(parts.flatMap(({ weight, vec }) => Object.entries(vec).map(([k, w]): [string, Ratio] => [k, mul(weight, w)])));
}

export function fixedVector(members: readonly string[], path: string): PartyVector {
  if (members.length === 0) fail("ALLOC_EMPTY_VECTOR", path, "no pool members");
  const w = ratio(1n, BigInt(members.length));
  return collect(members.map((m): [string, Ratio] => [m, w]));
}

/** USAGE_WEIGHTED: 주실연 F와 부실연 N을 featured_weight로 섞는다. 한쪽만 있으면 그 벡터 전체를 쓴다. */
export function usageVector(
  featured: PartyVector | undefined, nonFeatured: PartyVector | undefined, featuredWeight: Ratio, path: string,
): PartyVector {
  if (featured !== undefined && nonFeatured !== undefined) {
    return mixVectors([{ weight: featuredWeight, vec: featured }, { weight: sub(ONE, featuredWeight), vec: nonFeatured }]);
  }
  const only = featured ?? nonFeatured;
  if (only === undefined) fail("ALLOC_EMPTY_VECTOR", path, "no performer vector in projection");
  return only;
}

/** `@hold`는 그대로 두고 parties에 value를 매긴 벡터. 합이 1이 아니면 조건을 만족하는 분배가 없는 것이다. */
function build(vec: PartyVector, parties: readonly string[], value: (k: string) => Ratio, path: string): PartyVector {
  const hold: [string, Ratio][] = Object.hasOwn(vec, HOLD) ? [[HOLD, vec[HOLD]!]] : [];
  const out = collect([...hold, ...parties.map((k): [string, Ratio] => [k, value(k)])]);
  if (cmp(sum(Object.values(out)), ONE) !== 0) fail("ALLOC_INFEASIBLE", path, "no distribution satisfies the constraint");
  return out;
}

/** 한 party의 몫을 max로 제한하고 초과분을 제한되지 않은 party에 원래 비율대로 재분배한다(반복 수위 채우기). */
export function capVector(vec: PartyVector, max: Ratio, path: string): PartyVector {
  const parties = Object.keys(vec).filter((k) => k !== HOLD);
  const capped = new Set<string>();
  for (;;) {
    const free = parties.filter((k) => !capped.has(k));
    const remaining = sub(sub(ONE, weightOf(vec, HOLD)), mul(ratio(BigInt(capped.size)), max));
    const freeSum = sum(free.map((k) => vec[k]!));
    const scale = freeSum.n === 0n ? ZERO : div(remaining, freeSum);
    const over = free.filter((k) => cmp(mul(vec[k]!, scale), max) > 0);
    if (over.length === 0) return build(vec, parties, (k) => (capped.has(k) ? max : mul(vec[k]!, scale)), path);
    for (const k of over) capped.add(k);
  }
}

/** members와 벡터의 party 각각이 최소 min을 받도록 올리고, 나머지를 원래 비율대로 줄인다(반복). */
export function floorGuarantee(vec: PartyVector, members: readonly string[], min: Ratio, path: string): PartyVector {
  const domain = [...new Set([...Object.keys(vec).filter((k) => k !== HOLD), ...members])];
  const available = sub(ONE, weightOf(vec, HOLD));
  if (cmp(mul(ratio(BigInt(domain.length)), min), available) > 0) fail("ALLOC_INFEASIBLE", path, "floor exceeds available weight");
  const val = (k: string) => weightOf(vec, k);
  const floored = new Set(domain.filter((k) => cmp(val(k), min) < 0));
  for (;;) {
    const others = domain.filter((k) => !floored.has(k));
    const remaining = sub(available, mul(ratio(BigInt(floored.size)), min));
    const othersSum = sum(others.map(val));
    const scale = othersSum.n === 0n ? ZERO : div(remaining, othersSum);
    const under = others.filter((k) => cmp(mul(val(k), scale), min) < 0);
    if (under.length === 0) return build(vec, domain, (k) => (floored.has(k) ? min : mul(val(k), scale)), path);
    for (const k of under) floored.add(k);
  }
}
