function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatKrw(s: string): string {
  const n = BigInt(s);
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString();
  return `${neg ? "−" : ""}${group(abs)}원`;
}

export function shortDigest(d: string): string {
  const i = d.lastIndexOf(":");
  return (i >= 0 ? d.slice(i + 1) : d).slice(0, 12);
}

/** UTC 그대로: "2026-03-01 10:00:00.000Z" */
export function formatInstant(iso: string): string {
  return iso.replace("T", " ");
}

export function sumKrw(xs: string[]): string {
  return xs.reduce((a, x) => a + BigInt(x), 0n).toString();
}

/** 표시용: 잘못된 입력이어도 던지지 않고 원문을 그대로 돌려준다. */
export function safeKrw(s: string): string {
  if (!/^-?\d+$/.test(s)) return s;
  try {
    return formatKrw(s);
  } catch {
    return s;
  }
}
