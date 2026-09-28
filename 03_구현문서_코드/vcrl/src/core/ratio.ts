import { fail } from "./errors.ts";

export type Ratio = { readonly n: bigint; readonly d: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function ratio(n: bigint, d: bigint = 1n): Ratio {
  if (d === 0n) fail("CORE_TYPE_ERROR", "$", "ratio denominator is zero");
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d);
  return { n: (sign * n) / g, d: (sign * d) / g };
}

export const ZERO: Ratio = ratio(0n);
export const ONE: Ratio = ratio(1n);

export function add(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function sub(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.d - b.n * a.d, a.d * b.d);
}
export function mul(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.n, a.d * b.d);
}
export function div(a: Ratio, b: Ratio): Ratio {
  if (b.n === 0n) fail("CORE_TYPE_ERROR", "$", "division by zero ratio");
  return ratio(a.n * b.d, a.d * b.n);
}
export function cmp(a: Ratio, b: Ratio): -1 | 0 | 1 {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
export function sum(rs: Iterable<Ratio>): Ratio {
  let acc = ZERO;
  for (const r of rs) acc = add(acc, r);
  return acc;
}
export function fromBps(bps: number): Ratio {
  return ratio(BigInt(bps), 10000n);
}
export function formatRatio(r: Ratio): string {
  return `${r.n}/${r.d}`;
}

const RATIO_RE = /^(-?(?:0|[1-9]\d*))\/([1-9]\d*)$/;
export function parseRatio(s: string, path = "$"): Ratio {
  const m = RATIO_RE.exec(s);
  if (!m) fail("CORE_TYPE_ERROR", path, `not a ratio literal: ${s}`);
  const r = ratio(BigInt(m[1]!), BigInt(m[2]!));
  if (formatRatio(r) !== s) fail("CORE_TYPE_ERROR", path, `ratio not in lowest terms: ${s}`);
  return r;
}
