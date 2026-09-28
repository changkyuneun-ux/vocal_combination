import { diag, type Diagnostic } from "./errors.ts";

/** 모든 VCRL 식별자(엔티티 id, 참조, 문서 id, 이벤트 id)의 형식. `@`·`|`·`,`를 배제한다. */
export const ID_RE = /^[A-Za-z0-9._-]+$/;

export function isId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

/** JSON Schema의 `additionalProperties: false`와 같이, 허용 목록 밖의 키를 CORE_TYPE_ERROR로 보고한다. */
export function rejectUnknownKeys(obj: object, allowed: readonly string[], path: string): Diagnostic[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => diag("CORE_TYPE_ERROR", `${path}.${k}`, "unknown key"));
}
