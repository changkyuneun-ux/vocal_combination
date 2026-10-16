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

/** 읽기 쉬운 UTC 시각: "2026-03-01T10:00:05.123Z" → "2026-03-01 10:00 UTC"(초 이하는 툴팁에서 본다). 형식이 다르면 원문. */
export function formatInstant(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
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
