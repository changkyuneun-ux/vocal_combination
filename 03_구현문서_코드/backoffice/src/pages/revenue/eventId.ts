/** 기본 eventId: ev_<시각>_<유형 p|r|c>_<n>. 이미 쓰인 id와 겹치지 않는 가장 작은 n. */
export function nextEventId(stamp: string, kind: "p" | "r" | "c", taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `ev_${stamp}_${kind}_${n}`;
    if (!used.has(id)) return id;
  }
}
