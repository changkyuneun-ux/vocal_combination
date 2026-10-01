/** 선택된 스템의 실연자(권리 대상이 아니면 null)별 슬롯 수에 비례한 bps. 합 10000, 나머지는 party_id 오름차순 첫 멤버. */
export function autoMemberBps(performers: readonly (string | null)[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const p of performers) if (p !== null) counts.set(p, (counts.get(p) ?? 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return {};
  const ids = [...counts.keys()].sort();
  const out: Record<string, number> = {};
  let used = 0;
  for (const id of ids) {
    out[id] = Math.floor((10000 * counts.get(id)!) / total);
    used += out[id]!;
  }
  out[ids[0]!]! += 10000 - used;
  return out;
}

export const sumBps = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
