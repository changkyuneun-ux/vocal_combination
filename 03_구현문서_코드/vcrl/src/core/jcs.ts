import { fail } from "./errors.ts";

/** 올바른 UTF-16이 아닌 문자열(고립 서로게이트)은 UTF-8로 인코딩할 수 없으므로 거부한다. */
function quote(s: string, path: string): string {
  if (!s.isWellFormed()) fail("CORE_TYPE_ERROR", path, "string is not well-formed UTF-16");
  return JSON.stringify(s);
}

/** RFC 8785 JCS. VCRL IR은 JSON number를 금지하므로 number는 오류로 처리한다. */
export function canonicalize(value: unknown, path = "$"): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return quote(value, path);
    case "number":
      return fail("CORE_NUMBER_IN_IR", path, String(value));
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return fail("CORE_TYPE_ERROR", path, "not a plain object");
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return "{" + keys.map((k) => quote(k, `${path}.${k}`) + ":" + canonicalize(obj[k], `${path}.${k}`)).join(",") + "}";
    }
    default:
      return fail("CORE_TYPE_ERROR", path, `unsupported type ${typeof value}`);
  }
}
