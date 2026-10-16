import { fail } from "./errors.ts";

/** 올바른 UTF-16이 아닌 문자열(고립 서로게이트)은 UTF-8로 인코딩할 수 없으므로 거부한다. */
function quote(s: string, path: string): string {
  if (!s.isWellFormed()) fail("CORE_TYPE_ERROR", path, "string is not well-formed UTF-16");
  return JSON.stringify(s);
}

/** JSON 객체로 취급할 수 있는 plain object(프로토타입이 Object.prototype 또는 null)인가. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 배열·객체 중첩 한도(최상위 = 1). 이를 넘으면 재귀하기 전에 CORE_TYPE_ERROR로 멈춘다(스택 오버플로 방지). */
export const MAX_JSON_DEPTH = 256;

/** RFC 8785 JCS. MDRL IR은 JSON number를 금지하므로 number는 오류로 처리한다. */
export function canonicalize(value: unknown, path = "$"): string {
  return canon(value, path, 0);
}

function canon(value: unknown, path: string, depth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return quote(value, path);
    case "number":
      return fail("CORE_NUMBER_IN_IR", path, String(value));
    case "object": {
      if (depth >= MAX_JSON_DEPTH) return fail("CORE_TYPE_ERROR", path, "nesting too deep");
      if (Array.isArray(value)) {
        return "[" + value.map((v, i) => canon(v, `${path}[${i}]`, depth + 1)).join(",") + "]";
      }
      if (!isPlainObject(value)) return fail("CORE_TYPE_ERROR", path, "not a plain object");
      const obj = value;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return "{" + keys.map((k) => quote(k, `${path}.${k}`) + ":" + canon(obj[k], `${path}.${k}`, depth + 1)).join(",") + "}";
    }
    default:
      return fail("CORE_TYPE_ERROR", path, `unsupported type ${typeof value}`);
  }
}
