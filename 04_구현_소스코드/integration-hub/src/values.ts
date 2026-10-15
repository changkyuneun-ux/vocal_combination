import type { Rejection } from "./types.ts";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 날짜(YYYY-MM-DD, 그날 0시 UTC) 또는 밀리초 UTC ISO 시각. */
export function instant(v: string | undefined): string | Rejection {
  const s = (v ?? "").trim();
  const iso = DATE.test(s) ? `${s}T00:00:00.000Z` : s;
  if (!INSTANT.test(iso) || Number.isNaN(Date.parse(iso)) || new Date(iso).toISOString() !== iso) {
    return { code: "INVALID_DATE", message: `date must be YYYY-MM-DD or ms UTC ISO: ${JSON.stringify(v ?? "")}` };
  }
  return iso;
}

/** 원화 금액: 양의 정수. "1200.00"처럼 소수부가 0이면 받는다(원화는 보조 단위가 없다). */
export function krw(v: string | undefined): string | Rejection {
  const m = /^([0-9]+)(?:\.(0+))?$/.exec((v ?? "").trim());
  if (m === null) return { code: "INVALID_AMOUNT", message: `amount must be a positive whole KRW amount: ${JSON.stringify(v ?? "")}` };
  const n = m[1]!.replace(/^0+(?=\d)/, "");
  if (n === "0") return { code: "INVALID_AMOUNT", message: "amount must be positive" };
  return n;
}

export function currency(v: string | undefined): Rejection | undefined {
  const c = (v ?? "KRW").trim() || "KRW";
  return c === "KRW" ? undefined : { code: "UNSUPPORTED_CURRENCY", message: `only KRW is supported, got ${c}` };
}

export function required(name: string, v: string | undefined): string | Rejection {
  const s = (v ?? "").trim();
  return s === "" ? { code: "MISSING_FIELD", message: `${name} is required` } : s;
}

export const isRejection = (v: unknown): v is Rejection => typeof v === "object" && v !== null && "code" in v;
