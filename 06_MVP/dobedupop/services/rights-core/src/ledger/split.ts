/**
 * 최대 잔여법 정수 분배(통합 설계 11.2-5): 각 key에 floor(|total|·w/Σw)를 주고, 남는 단위를 나머지 내림차순·동률 key 오름차순으로
 * 1씩 준다. 음수 total은 절댓값으로 나눈 뒤 부호를 붙인다. 결과 합 = total. 가중치는 0 이상, 합은 양수, key는 유일해야 한다.
 */
export function splitByWeights(total: bigint, weights: readonly { key: string; weight: bigint }[]): Map<string, bigint> {
  const keys = new Set<string>();
  let sum = 0n;
  for (const w of weights) {
    if (w.weight < 0n) throw new RangeError(`negative weight for ${w.key}`);
    if (keys.has(w.key)) throw new RangeError(`duplicate key ${w.key}`);
    keys.add(w.key);
    sum += w.weight;
  }
  if (sum <= 0n) throw new RangeError("weights must sum to a positive amount");
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const parts = weights.map((w) => ({ key: w.key, amount: (abs * w.weight) / sum, rem: (abs * w.weight) % sum }));
  let left = abs - parts.reduce((a, p) => a + p.amount, 0n);
  const order = [...parts].sort((a, b) => (a.rem !== b.rem ? (a.rem > b.rem ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const p of order) {
    if (left === 0n) break;
    p.amount += 1n;
    left -= 1n;
  }
  return new Map(parts.map((p) => [p.key, p.amount * sign]));
}
