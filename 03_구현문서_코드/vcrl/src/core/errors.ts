export const ERROR_CODES = {
  CORE_TYPE_ERROR: "값의 타입 또는 형식이 규격과 다르다",
  CORE_NUMBER_IN_IR: "IR에 JSON number가 있다. 정수·비율은 문자열로 표기해야 한다",
  CORE_ENUM_UNKNOWN: "코어 Enum 레지스트리에 없는 값이다",
  CORE_UNKNOWN_REF: "참조 대상이 존재하지 않는다",
  CORE_DEP_DIRECTION: "허용되지 않는 방향의 모듈 의존이다(순환 포함)",
  CORE_DIGEST_MISMATCH: "digest가 대상의 실제 digest와 다르다",
  CORE_SIGNATURE_INVALID: "서명 검증에 실패했다",
  CORE_SOD_VIOLATION: "직무 분리(SoD) 규칙 위반이다",
  FACTS_DUPLICATE_ID: "facts 안에서 식별자가 중복된다",
  FACTS_UNKNOWN_ENTITY: "참조한 work·recording·voice·stem이 없다",
  FACTS_UNKNOWN_PARTY: "참조한 party가 없다",
  FACTS_EDGE_KIND: "엣지 유형과 source·target 종류가 맞지 않는다",
  FACTS_SUM_MISMATCH: "같은 그룹의 share 합이 10000bps가 아니다",
  FACTS_CYCLE: "위임(mandate) 그래프에 순환이 있다",
  FACTS_MANDATE_DEPTH: "위임이 2홉을 초과한다",
  FACTS_PATH_MISSING: "필수 권리 경로가 끊겨 있다",
  FACTS_USAGE_INVALID: "사용량 벡터가 잘못되었다",
  FACTS_UNCOVERED_CLAIMANT: "선언된 청구권자가 그래프에서 도출되지 않는다",
  FACTS_CLAIMANT_DRIFT: "그래프에서 도출된 청구권자가 선언 목록에 없다",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export type Diagnostic = { code: ErrorCode; path: string; message: string };

export function diag(code: ErrorCode, path: string, detail?: string): Diagnostic {
  const base = ERROR_CODES[code];
  return { code, path, message: detail === undefined ? base : `${base}: ${detail}` };
}

export class VcrlError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code} at ${d.path}: ${d.message}`).join("\n"));
    this.name = "VcrlError";
    this.diagnostics = diagnostics;
  }
}

export function fail(code: ErrorCode, path: string, detail?: string): never {
  throw new VcrlError([diag(code, path, detail)]);
}

export function capture(fn: () => unknown): Diagnostic[] {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof VcrlError) return e.diagnostics;
    throw e;
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: Diagnostic[] };
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
export function err<T>(errors: Diagnostic[]): Result<T> {
  return { ok: false, errors };
}

/** 기존 설계 문서의 오류 코드 → VCRL 코드. DSL_* 안분 코드는 계획 1-B에서 추가한다. */
export const LEGACY_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  DSL_TYPE_ERROR: "CORE_TYPE_ERROR",
  DSL_UNKNOWN_REF: "CORE_UNKNOWN_REF",
  GRAPH_UNCOVERED_CLAIMANT: "FACTS_UNCOVERED_CLAIMANT",
  GRAPH_PATH_MISSING: "FACTS_PATH_MISSING",
  GRAPH_UNKNOWN_PARTY: "FACTS_UNKNOWN_PARTY",
  CLAIMANT_DRIFT: "FACTS_CLAIMANT_DRIFT",
};
