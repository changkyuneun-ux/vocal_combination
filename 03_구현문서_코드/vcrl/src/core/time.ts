import { diag, type Diagnostic } from "./errors.ts";

export type Instant = string;
export type Interval = { from: Instant; to?: Instant };

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isInstant(v: unknown): v is Instant {
  if (typeof v !== "string" || !INSTANT_RE.test(v)) return false;
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString() === v;
}

/** 고정 형식이므로 문자열 비교가 시각 비교와 같다. */
export function contains(iv: Interval, t: Instant): boolean {
  return iv.from <= t && (iv.to === undefined || t < iv.to);
}

export function checkInterval(v: unknown, path: string): Diagnostic[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [diag("CORE_TYPE_ERROR", path, "interval must be an object")];
  const iv = v as Record<string, unknown>;
  const out: Diagnostic[] = [];
  if (!isInstant(iv.from)) out.push(diag("CORE_TYPE_ERROR", `${path}.from`, String(iv.from)));
  if (iv.to !== undefined && !isInstant(iv.to)) out.push(diag("CORE_TYPE_ERROR", `${path}.to`, String(iv.to)));
  if (out.length === 0 && iv.to !== undefined && !((iv.from as string) < (iv.to as string))) {
    out.push(diag("CORE_TYPE_ERROR", path, "from must be before to"));
  }
  return out;
}
