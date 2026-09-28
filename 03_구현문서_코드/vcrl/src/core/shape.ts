import { diag, type Diagnostic } from "./errors.ts";

/** 모든 VCRL 식별자(엔티티 id, 참조, 문서 id, 이벤트 id)의 형식. `@`·`|`·`,`를 배제한다. */
export const ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * `__proto__`는 ID_RE 알파벳(영문자·숫자·`.`·`_`·`-`)만으로 이루어져 정규식은 통과하지만,
 * 일반 객체의 키로 대괄호 대입(`obj[k] = v`)에 쓰이면 프로토타입 접근자를 건드려 값이 아니라
 * 객체의 프로토타입을 바꿔버린다(예: PartyVector를 만드는 `collect`). 이 값을 id로 거부해
 * 벡터·facts 등에서 키가 조용히 사라지는 사고를 막는다.
 */
export function isId(v: unknown): v is string {
  return typeof v === "string" && v !== "__proto__" && ID_RE.test(v);
}

/** JSON Schema의 `additionalProperties: false`와 같이, 허용 목록 밖의 키를 CORE_TYPE_ERROR로 보고한다. */
export function rejectUnknownKeys(obj: object, allowed: readonly string[], path: string): Diagnostic[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => diag("CORE_TYPE_ERROR", `${path}.${k}`, "unknown key"));
}
