import { fail } from "./errors.ts";

export type Bps = number;
export const BPS_TOTAL = 10000;

const BPS_RE = /^(0|[1-9]\d{0,4})$/;
export function parseBps(s: unknown, path = "$"): Bps {
  if (typeof s !== "string" || !BPS_RE.test(s)) fail("CORE_TYPE_ERROR", path, `not a bps string: ${String(s)}`);
  const v = Number(s);
  if (v > BPS_TOTAL) fail("CORE_TYPE_ERROR", path, `bps > ${BPS_TOTAL}: ${s}`);
  return v;
}

export function formatBps(v: Bps): string {
  if (!Number.isInteger(v) || v < 0 || v > BPS_TOTAL) fail("CORE_TYPE_ERROR", "$", `invalid bps: ${v}`);
  return String(v);
}

const PCT_RE = /^(0|[1-9]\d{0,2})(?:\.(\d{1,2}))?$/;
export function percentToBps(lit: string, path = "$"): Bps {
  const m = PCT_RE.exec(lit);
  if (!m) fail("CORE_TYPE_ERROR", path, `percent not representable in bps: ${lit}`);
  const v = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (v > BPS_TOTAL) fail("CORE_TYPE_ERROR", path, `percent > 100: ${lit}`);
  return v;
}
