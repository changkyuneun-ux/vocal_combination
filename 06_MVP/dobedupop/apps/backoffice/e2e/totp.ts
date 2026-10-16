import { createHmac } from "node:crypto";

/** 시험용 TOTP(RFC 6238, SHA-1·30초·6자리): 화면에 나온 등록 키로 인증 앱 코드를 만든다. */
export function totp(secretB32: string, unixMs: number): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const key: number[] = [];
  for (const ch of secretB32.replace(/=+$/, "").toUpperCase()) {
    val = (val << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { key.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixMs / 30_000)));
  const h = createHmac("sha1", Buffer.from(key)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
