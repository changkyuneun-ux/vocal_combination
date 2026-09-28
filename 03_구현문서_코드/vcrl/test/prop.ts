/** 테스트 전용 결정적 난수(mulberry32). 라이브러리 코드는 이 파일을 쓰지 않는다. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** total을 n개의 음이 아닌 정수로 나눈다(합 = total). */
export function randomSplit(r: () => number, n: number, total = 10000): number[] {
  const cuts = Array.from({ length: n - 1 }, () => int(r, 0, total)).sort((a, b) => a - b);
  const bounds = [0, ...cuts, total];
  return bounds.slice(1).map((b, i) => b - bounds[i]!);
}

export function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
