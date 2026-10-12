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
  FACTS_DISPUTE_OPEN: "팩이 사용하는 권리 경로에 분쟁 중인 claim·mandate가 있어 활성화할 수 없다",
  ALLOC_SUM_MISMATCH: "버킷 bps 합이 10000이 아니다",
  ALLOC_WEIGHT_MISMATCH: "가중치 합이 10000bps(또는 1)가 아니다",
  ALLOC_MODE_REQUIRED: "performance_pool의 mode와 모드별 필수 가중치를 명시해야 한다",
  ALLOC_DUPLICATE_NAME: "버킷 이름 또는 배분 키가 중복된다",
  ALLOC_UNCOVERED_CLAIMANT: "투영에서 도출된 청구권자(역할 또는 실연자)를 어느 버킷도 다루지 않는다",
  ALLOC_INFEASIBLE: "cap·floor_guarantee 조건을 만족하는 분배가 없다",
  ALLOC_SCOPE_MISMATCH: "매출 이벤트가 정책 범위(이벤트 유형·통화)를 벗어난다",
  ALLOC_EMPTY_VECTOR: "배분할 벡터가 비어 있다",
  ALLOC_ROUNDING_INVARIANT: "층별 배분 합이 상위 금액과 다르다(평가기 결함)",
  REV_ORIGINAL_DIGEST: "원 안분 결과의 result_digest가 내용과 다르다",
  REV_ORIGINAL_INCONSISTENT: "원 안분 결과의 권리 풀 금액과 라인·보류 합이 다르다",
  REV_UNKNOWN_EVENT: "원 안분 결과에 역분개할 이벤트가 없다",
  REV_CHAIN_BROKEN: "이전 역분개가 같은 원 결과·이벤트에서 순서대로 재도출되지 않는다",
  REV_EXCEEDS_REMAINING: "누적 역분개액이 원 이벤트 금액을 넘는다",
  REV_AMOUNT: "역분개 금액은 양의 정수 문자열이어야 한다",
  SHADOW_EVENTS_MISMATCH: "섀도 비교 쌍의 두 평가가 서로 다른 이벤트를 쓴다",
  SHADOW_DUPLICATE_EVENT: "같은 이벤트가 섀도 비교의 여러 쌍에 나온다",
  SHADOW_CURRENCY_MISMATCH: "섀도 비교 쌍들의 통화가 서로 다르다",
  GRANT_SCOPE_WIDENING: "하위 문서 또는 파생 조항의 허락 범위가 상위 허락 범위를 초과했다",

  GRANT_REQUIREMENT_UNMET: "필수 이용허락 요구사항을 충족하지 못했다",
  GRANT_REVOKED: "이용허락이 철회되었거나 효력이 상실되었다",
  GRANT_OBLIGATION_VIOLATED: "이용허락에 수반된 필수 의무를 충족하지 못했다",
  GRANT_CONFLICT: "동일 권리 범위에 모순되거나 상충하는 허락이 존재한다",
  GRANT_NO_EVIDENCE: "이용허락을 뒷받침하는 검증된 증빙이 없다",
  GRANT_UNSUPPORTED: "지원하지 않는 이용허락 판정 규칙 또는 조건이다",
  PARSE_SYNTAX: "텍스트 문법 오류",
  PARSE_ROLE_REQUIRED: "버킷 역할을 추론할 수 없어 `as <ROLE>` 표기가 필요하다",
  PARSE_UNSUPPORTED: "엔진의 고정 의미와 다른 guard·exceptions 문장은 지원하지 않는다",
} as const;


export type ErrorCode = keyof typeof ERROR_CODES;
export type Diagnostic = { code: ErrorCode; path: string; message: string };

export function diag(code: ErrorCode, path: string, detail?: string): Diagnostic {
  const base = ERROR_CODES[code];
  return { code, path, message: detail === undefined ? base : `${base}: ${detail}` };
}

/** 중첩 검증·digest 계산의 진단 경로 맨 앞 `$`를 입력 접두사(예: `$.facts`)로 바꾼다. */
export function underPath(prefix: string, diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map((d) => ({ ...d, path: d.path.startsWith("$") ? prefix + d.path.slice(1) : d.path }));
}

export class MdrlError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code} at ${d.path}: ${d.message}`).join("\n"));
    this.name = "MdrlError";
    this.diagnostics = diagnostics;
  }
}

export function fail(code: ErrorCode, path: string, detail?: string): never {
  throw new MdrlError([diag(code, path, detail)]);
}

export function capture(fn: () => unknown): Diagnostic[] {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof MdrlError) return e.diagnostics;
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

/** fail()이 던진 MdrlError를 실패 Result로 바꾼다. 그 밖의 예외는 그대로 던진다. */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    if (e instanceof MdrlError) return err(e.diagnostics);
    throw e;
  }
}

/** 기존 설계 문서의 오류 코드 → MDRL 코드. */
export const LEGACY_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  DSL_TYPE_ERROR: "CORE_TYPE_ERROR",
  DSL_UNKNOWN_REF: "CORE_UNKNOWN_REF",
  GRAPH_UNCOVERED_CLAIMANT: "FACTS_UNCOVERED_CLAIMANT",
  GRAPH_PATH_MISSING: "FACTS_PATH_MISSING",
  GRAPH_UNKNOWN_PARTY: "FACTS_UNKNOWN_PARTY",
  CLAIMANT_DRIFT: "FACTS_CLAIMANT_DRIFT",
  DSL_SUM_MISMATCH: "ALLOC_SUM_MISMATCH",
  DSL_WEIGHT_MISMATCH: "ALLOC_WEIGHT_MISMATCH",
  DSL_UNCOVERED_CLAIMANT: "ALLOC_UNCOVERED_CLAIMANT",
};

/** 진단 메시지용 값 표시. 적대적 입력(예: `{"toString":1}`)에서도 예외를 던지지 않는다. */
export function describe(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean" || v === undefined) return String(v);
  return Array.isArray(v) ? "array" : typeof v;
}
