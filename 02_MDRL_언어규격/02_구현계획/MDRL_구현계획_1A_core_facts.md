# MDRL 1-A: core + facts + 그래프 기여 벡터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MDRL 코어(정확한 유리수·bps, JCS 정규형·digest·커밋먼트, Enum·오류 레지스트리, IR 봉투·의존 검증, Ed25519 증명·SoD)와 `facts` 모듈(구조·불변식 검증, 이중 시간축 선택, 역할별 기여 벡터 계산, 위임 라우팅, 청구권자 도출, 결과 IR·공개본)을 레퍼런스 구현한다.

**Architecture:** 단일 npm 패키지 `mdrl`(경로 `04_구현_소스코드/mdrl/`)에 `src/core`, `src/facts`를 두고 subpath export(`mdrl/core`, `mdrl/facts`)로 노출한다. 모든 함수는 순수 함수이며 IR(JSON, 숫자는 문자열)을 입력받아 `Diagnostic[]` 또는 `Result<T>`를 반환한다. 공개 적합성 스위트(`conformance/`)가 입력 IR → 기대 결과·digest를 고정한다.

**Tech Stack:** Node.js ≥ 24 (네이티브 TypeScript type stripping), TypeScript 5.9 (타입검사 전용, `erasableSyntaxOnly`), `node:test`, `node:crypto`. devDependency: `typescript`, `@types/node`, `ajv`(JSON Schema 테스트 전용).

**상위 스펙:** `02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md` (이하 "스펙")

**후속 계획:** 1-B `allocation`(평가기·`HIERARCHICAL_LRM_V1`·ALLOC_* 오류), 1-C `parser`(텍스트 문법 EBNF 전체·legacy-v1 변환)·`mdrl` CLI·적합성 스위트 확장.

## Global Constraints

- 런타임 의존성 0. `dependencies` 필드를 만들지 않는다.
- TypeScript는 erasable syntax만 사용: `enum`, `namespace`, 생성자 parameter property 금지. 상대 import는 `.ts` 확장자를 붙인다. 타입 전용 import는 `import type`.
- 부동소수 금지. 비율 계산은 `Ratio`(BigInt 유리수), 저장 비율은 정수 bps(0~10000).
- IR에는 JSON number를 쓰지 않는다. 정수·bps·ms·version은 문자열(`"4500"`), 유리수는 기약분수 문자열(`"3/5"`).
- digest 표기: `mdrl:sha256:<64 hex>` = sha256(UTF-8(RFC 8785 JCS)).
- 시각 표기: `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, 밀리초 3자리) 고정.
- 오류 코드는 `src/core/errors.ts`의 `ERROR_CODES`에만 정의하고 `spec/error-codes.md`와 항상 일치시킨다.
- 모든 Enum 값은 `src/core/enums.ts`의 `ENUMS`에만 정의한다.
- 작업 디렉터리: `/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl` (git 루트는 `/Users/changkyuneun/Vocal Combination`). 커밋 시 이 패키지 파일만 `git add` 한다. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
04_구현_소스코드/mdrl/
  package.json, tsconfig.json, .gitignore
  spec/
    error-codes.md                 오류 코드 정본 문서 (테스트로 동기화 강제)
    schema/envelope.schema.json    IR 봉투 JSON Schema
    schema/facts.ir.schema.json    facts IR JSON Schema
  src/core/
    errors.ts     ERROR_CODES, Diagnostic, MdrlError, fail, capture, Result
    enums.ts      ENUMS 레지스트리, isEnumValue
    ratio.ts      Ratio 유리수 연산
    bps.ts        bps 파싱, % → bps
    jcs.ts        RFC 8785 정규화
    digest.ts     sha256 digest
    commit.ts     해시 커밋먼트
    time.ts       Instant, Interval
    ref.ts        vc:<module>/<id>@<version>
    envelope.ts   IrDocument, validateEnvelope, checkDependencies
    attest.ts     Ed25519 증명, SoD
    index.ts
  src/facts/
    types.ts      facts IR 타입, CLAIM_EDGE_KINDS, MAX_MANDATE_HOPS
    validate.ts   validateFactsStructure, validateFacts
    temporal.ts   이중 시간축 선택, 그룹핑, 경계 시점
    invariants.ts checkClaimSums, checkMandates
    project.ts    projectVectors (역할별 기여 벡터)
    mandate.ts    routeVector, deriveClaimants, checkClaimantCoverage
    result.ts     toProjectionIr
    public.ts     publicFacts (커밋먼트 치환 공개본)
    index.ts
  scripts/print-projection.ts
  conformance/facts/{001-basic,002-disputed-master,003-path-missing}/{input.json,expected.json}
  test/helpers.ts, test/core/*.test.ts, test/facts/*.test.ts, test/conformance.test.ts
```

---

### Task 1: 패키지 골격 + 오류·Enum 레지스트리

**Files:**
- Create: `04_구현_소스코드/mdrl/package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/core/errors.ts`, `src/core/enums.ts`, `spec/error-codes.md`
- Test: `test/core/errors.test.ts`, `test/core/enums.test.ts`

**Interfaces:**
- Produces: `ERROR_CODES`, `type ErrorCode`, `type Diagnostic = { code: ErrorCode; path: string; message: string }`, `diag(code, path, detail?)`, `class MdrlError { diagnostics: Diagnostic[] }`, `fail(code, path, detail?): never`, `capture(fn: () => unknown): Diagnostic[]`, `type Result<T>`, `ok(value)`, `err(errors)`, `LEGACY_ERROR_MAP`; `ENUMS`, `type EnumName`, `type EnumValue<N>`, `isEnumValue(name, v)`, `ENUM_REGISTRY_VERSION`.

- [ ] **Step 1: 패키지 파일 작성**

`package.json`:
```json
{
  "name": "mdrl",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "exports": {
    "./core": "./src/core/index.ts",
    "./facts": "./src/facts/index.ts"
  },
  "scripts": {
    "test": "node --test \"test/**/*.test.ts\"",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "ajv": "^8.17.1",
    "typescript": "^5.9.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts"]
}
```

`.gitignore`:
```
node_modules/
```

Run: `cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl" && npm install`
Expected: `added N packages`, `package-lock.json` 생성.

- [ ] **Step 2: 실패하는 테스트 작성**

`test/core/errors.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ERROR_CODES, LEGACY_ERROR_MAP, MdrlError, capture, diag, fail } from "../../src/core/errors.ts";

test("diag composes message from registry", () => {
  assert.deepEqual(diag("FACTS_CYCLE", "$.body.mandates", "m1"), {
    code: "FACTS_CYCLE",
    path: "$.body.mandates",
    message: `${ERROR_CODES.FACTS_CYCLE}: m1`,
  });
  assert.equal(diag("FACTS_CYCLE", "$").message, ERROR_CODES.FACTS_CYCLE);
});

test("fail throws MdrlError carrying diagnostics", () => {
  assert.throws(
    () => fail("CORE_TYPE_ERROR", "$.x"),
    (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === "CORE_TYPE_ERROR",
  );
});

test("capture converts MdrlError into diagnostics and rethrows others", () => {
  assert.deepEqual(capture(() => fail("CORE_TYPE_ERROR", "$.y")).map((d) => d.code), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(capture(() => 1), []);
  assert.throws(() => capture(() => { throw new TypeError("boom"); }), TypeError);
});

test("legacy codes map into the registry", () => {
  for (const v of Object.values(LEGACY_ERROR_MAP)) assert.ok(v in ERROR_CODES, v);
});

test("spec/error-codes.md lists exactly the registry", () => {
  const md = readFileSync(new URL("../../spec/error-codes.md", import.meta.url), "utf8");
  const listed = [...md.matchAll(/^\| `([A-Z]+_[A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), Object.keys(ERROR_CODES).sort());
});
```

`test/core/enums.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENUMS, isEnumValue } from "../../src/core/enums.ts";

test("no duplicate values in any enum", () => {
  for (const [name, values] of Object.entries(ENUMS)) {
    assert.equal(new Set(values).size, values.length, name);
  }
});

test("stamp_clause is a subset of action", () => {
  for (const c of ENUMS.stamp_clause) assert.ok((ENUMS.action as readonly string[]).includes(c), c);
});

test("isEnumValue", () => {
  assert.equal(isEnumValue("claimant_role", "CMO"), true);
  assert.equal(isEnumValue("claimant_role", "cmo"), false);
  assert.equal(isEnumValue("approval_mode", "SPACE"), false);
  assert.equal(isEnumValue("visibility", 1), false);
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `node --test test/core/errors.test.ts test/core/enums.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/core/errors.ts`).

- [ ] **Step 4: 구현**

`src/core/errors.ts`:
```ts
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

/** 기존 설계 문서의 오류 코드 → MDRL 코드. DSL_* 안분 코드는 계획 1-B에서 추가한다. */
export const LEGACY_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  DSL_TYPE_ERROR: "CORE_TYPE_ERROR",
  DSL_UNKNOWN_REF: "CORE_UNKNOWN_REF",
  GRAPH_UNCOVERED_CLAIMANT: "FACTS_UNCOVERED_CLAIMANT",
  GRAPH_PATH_MISSING: "FACTS_PATH_MISSING",
  GRAPH_UNKNOWN_PARTY: "FACTS_UNKNOWN_PARTY",
  CLAIMANT_DRIFT: "FACTS_CLAIMANT_DRIFT",
};
```

`src/core/enums.ts`:
```ts
export const ENUM_REGISTRY_VERSION = "1.0";

export const ENUMS = {
  module: ["core", "facts", "constraint", "grant", "approval", "allocation"],
  claimant_role: [
    "MASTER_OWNER", "WORK_AUTHOR", "CMO", "PERFORMER_FEATURED",
    "PERFORMER_NON_FEATURED", "AGENCY", "AI_PROVIDER", "RECORDING_CONTRIBUTOR",
  ],
  edge_type: [
    "PERFORMED_BY", "OWNED_BY", "IN_SLOT", "OF_RECORDING", "PART_OF",
    "CONTROLLED_BY", "OF_WORK", "WRITTEN_BY", "CONTRIBUTED_BY",
  ],
  claim_status: ["ASSERTED", "VERIFIED", "DISPUTED", "SUPERSEDED"],
  party_kind: ["LABEL", "PERFORMER", "AUTHOR", "PUBLISHER", "CMO", "AGENCY", "AI_PROVIDER", "SESSION"],
  voice_kind: ["HUMAN", "AI"],
  performer_role: ["FEATURED", "NON_FEATURED"],
  mandate_right: ["MASTER", "WORK", "PERFORMER"],
  decision: ["PERMIT", "PERMIT_WITH_OBLIGATION", "DENY", "REVIEW_REQUIRED"],
  approval_mode: ["AUTO", "LABEL", "AGENCY"],
  attestation_role: ["EDITOR", "APPROVER", "WORK_APPROVER", "ACTIVATOR", "SPACE_OPS", "SPACE_SETTLE"],
  action: [
    "PREVIEW", "COMBINE", "PERSONAL_HOLD", "SHARE_LINK", "PLATFORM_DISTRIBUTE",
    "LIMITED_USE", "RESALE", "COMMERCIAL", "DOWNLOAD", "AI_TRAIN", "AI_GENERATE",
  ],
  stamp_clause: ["PERSONAL_HOLD", "PLATFORM_DISTRIBUTE", "LIMITED_USE", "COMMERCIAL", "DOWNLOAD"],
  uniqueness_scope: ["PACK", "FAN_PACK"],
  binding_time: ["ISSUE_TIME", "USAGE_TIME", "SALE_TIME", "REPORT_PERIOD"],
  event_type: ["PRIMARY", "RESALE", "TRAFFIC"],
  pool_mode: ["USAGE_WEIGHTED", "FIXED", "HYBRID", "MEMBER_PCT"],
  rounding_method: ["HIERARCHICAL_LRM_V1"],
  visibility: ["PUBLIC", "PARTIES", "PRIVATE"],
  vc_status: ["DRAFT", "VALIDATED", "RESERVED", "SUBMITTED", "ISSUED", "FLAGGED", "HIDDEN", "VOID"],
} as const;

export type EnumName = keyof typeof ENUMS;
export type EnumValue<N extends EnumName> = (typeof ENUMS)[N][number];

export function isEnumValue<N extends EnumName>(name: N, v: unknown): v is EnumValue<N> {
  return typeof v === "string" && (ENUMS[name] as readonly string[]).includes(v);
}
```

`spec/error-codes.md`:
```markdown
# MDRL 오류 코드 (정본)

이 표는 `src/core/errors.ts`의 `ERROR_CODES`와 테스트로 동기화된다. 코드를 추가·삭제할 때 두 곳을 함께 고친다.

| 코드 | 의미 | 발생 위치 |
|---|---|---|
| `CORE_TYPE_ERROR` | 값의 타입 또는 형식이 규격과 다르다 | 모든 파서·검증기 |
| `CORE_NUMBER_IN_IR` | IR에 JSON number가 있다 | `canonicalize`, `validateEnvelope` |
| `CORE_ENUM_UNKNOWN` | 코어 Enum 레지스트리에 없는 값 | 모든 검증기 |
| `CORE_UNKNOWN_REF` | 참조 대상 없음 | `checkDependencies`, `checkAttestations` |
| `CORE_DEP_DIRECTION` | 허용되지 않는 방향의 모듈 의존(순환 포함) | `checkDependencies` |
| `CORE_DIGEST_MISMATCH` | digest 불일치 | `checkDependencies`, `checkAttestations` |
| `CORE_SIGNATURE_INVALID` | 서명 검증 실패 | `checkAttestations` |
| `CORE_SOD_VIOLATION` | 직무 분리 위반 | `checkSod` |
| `FACTS_DUPLICATE_ID` | facts 식별자 중복 | `validateFactsStructure` |
| `FACTS_UNKNOWN_ENTITY` | work·recording·voice·stem 참조 없음 | `validateFactsStructure` |
| `FACTS_UNKNOWN_PARTY` | party 참조 없음 | `validateFactsStructure` |
| `FACTS_EDGE_KIND` | 엣지와 source·target 종류 불일치 | `validateFactsStructure` |
| `FACTS_SUM_MISMATCH` | 그룹 share 합 ≠ 10000bps (위임은 > 10000bps) | `checkClaimSums`, `checkMandates`, `projectVectors` |
| `FACTS_CYCLE` | 위임 순환 | `checkMandates` |
| `FACTS_MANDATE_DEPTH` | 위임 2홉 초과 | `checkMandates`, `routeVector` |
| `FACTS_PATH_MISSING` | 필수 권리 경로 단절 | `projectVectors` |
| `FACTS_USAGE_INVALID` | 사용량 벡터 오류 | `projectVectors` |
| `FACTS_UNCOVERED_CLAIMANT` | 선언 청구권자가 도출되지 않음 | `checkClaimantCoverage` |
| `FACTS_CLAIMANT_DRIFT` | 도출 청구권자가 선언 목록에 없음 | `checkClaimantCoverage` |

## 기존 코드 매핑

| 기존 코드 | MDRL 코드 |
|---|---|
| DSL_TYPE_ERROR | `CORE_TYPE_ERROR` |
| DSL_UNKNOWN_REF | `CORE_UNKNOWN_REF` |
| GRAPH_UNCOVERED_CLAIMANT | `FACTS_UNCOVERED_CLAIMANT` |
| GRAPH_PATH_MISSING | `FACTS_PATH_MISSING` |
| GRAPH_UNKNOWN_PARTY | `FACTS_UNKNOWN_PARTY` |
| CLAIMANT_DRIFT | `FACTS_CLAIMANT_DRIFT` |
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `node --test test/core/errors.test.ts test/core/enums.test.ts && npx tsc -p tsconfig.json`
Expected: 모든 테스트 PASS, tsc 출력 없음.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/package.json 04_구현_소스코드/mdrl/package-lock.json 04_구현_소스코드/mdrl/tsconfig.json 04_구현_소스코드/mdrl/.gitignore 04_구현_소스코드/mdrl/src/core/errors.ts 04_구현_소스코드/mdrl/src/core/enums.ts 04_구현_소스코드/mdrl/spec/error-codes.md 04_구현_소스코드/mdrl/test/core && git commit -m "feat(mdrl): 패키지 골격, 오류·Enum 레지스트리"
```

---

### Task 2: 정확한 수치 — Ratio · Bps

**Files:**
- Create: `src/core/ratio.ts`, `src/core/bps.ts`
- Test: `test/core/ratio.test.ts`, `test/core/bps.test.ts`

**Interfaces:**
- Consumes: `fail` (Task 1)
- Produces: `type Ratio = { readonly n: bigint; readonly d: bigint }`, `ratio(n, d=1n)`, `ZERO`, `ONE`, `add`, `sub`, `mul`, `div`, `cmp(a,b): -1|0|1`, `sum(iterable)`, `fromBps(bps: number)`, `formatRatio(r): string`, `parseRatio(s, path?)`; `type Bps = number`, `BPS_TOTAL = 10000`, `parseBps(s: unknown, path?)`, `formatBps(v)`, `percentToBps(lit, path?)`.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/core/ratio.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE, ZERO, add, cmp, div, formatRatio, fromBps, mul, parseRatio, ratio, sub, sum } from "../../src/core/ratio.ts";
import { MdrlError } from "../../src/core/errors.ts";

const isCode = (code: string) => (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === code;

test("ratio normalizes sign and lowest terms", () => {
  assert.deepEqual(ratio(6n, -4n), { n: -3n, d: 2n });
  assert.deepEqual(ratio(0n, 7n), ZERO);
});

test("zero denominator throws CORE_TYPE_ERROR", () => {
  assert.throws(() => ratio(1n, 0n), isCode("CORE_TYPE_ERROR"));
  assert.throws(() => div(ONE, ZERO), isCode("CORE_TYPE_ERROR"));
});

test("arithmetic is exact", () => {
  const third = ratio(1n, 3n);
  assert.deepEqual(add(third, third), ratio(2n, 3n));
  assert.deepEqual(sum([third, third, third]), ONE);
  assert.deepEqual(sub(ONE, third), ratio(2n, 3n));
  assert.deepEqual(mul(fromBps(6000), ratio(2n, 3n)), ratio(2n, 5n));
  assert.deepEqual(div(ratio(3n, 5n), ratio(3n, 4n)), ratio(4n, 5n));
  assert.equal(cmp(third, ratio(1n, 2n)), -1);
  assert.equal(cmp(ratio(2n, 4n), ratio(1n, 2n)), 0);
  assert.equal(cmp(ONE, third), 1);
});

test("format and parse round-trip; non-canonical rejected", () => {
  assert.equal(formatRatio(fromBps(1250)), "1/8");
  assert.equal(formatRatio(ONE), "1/1");
  assert.deepEqual(parseRatio("3/7"), ratio(3n, 7n));
  for (const bad of ["2/4", "1.5/2", "3", "-0/1", "1/0"]) assert.throws(() => parseRatio(bad), MdrlError, bad);
});
```

`test/core/bps.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBps, parseBps, percentToBps } from "../../src/core/bps.ts";
import { MdrlError } from "../../src/core/errors.ts";

test("parseBps accepts integer strings 0..10000", () => {
  assert.equal(parseBps("0"), 0);
  assert.equal(parseBps("4500"), 4500);
  assert.equal(parseBps("10000"), 10000);
  for (const bad of ["10001", "-1", "01", "4.5", "", 4500]) assert.throws(() => parseBps(bad), MdrlError, String(bad));
});

test("formatBps rejects out of range", () => {
  assert.equal(formatBps(1250), "1250");
  assert.throws(() => formatBps(10001), MdrlError);
  assert.throws(() => formatBps(1.5), MdrlError);
});

test("percentToBps converts with at most two decimals", () => {
  assert.equal(percentToBps("12.5"), 1250);
  assert.equal(percentToBps("40"), 4000);
  assert.equal(percentToBps("0.01"), 1);
  assert.equal(percentToBps("100"), 10000);
  for (const bad of ["12.345", "100.01", "abc", "-5"]) assert.throws(() => percentToBps(bad), MdrlError, bad);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/core/ratio.test.ts test/core/bps.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 구현**

`src/core/ratio.ts`:
```ts
import { fail } from "./errors.ts";

export type Ratio = { readonly n: bigint; readonly d: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function ratio(n: bigint, d: bigint = 1n): Ratio {
  if (d === 0n) fail("CORE_TYPE_ERROR", "$", "ratio denominator is zero");
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d);
  return { n: (sign * n) / g, d: (sign * d) / g };
}

export const ZERO: Ratio = ratio(0n);
export const ONE: Ratio = ratio(1n);

export function add(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function sub(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.d - b.n * a.d, a.d * b.d);
}
export function mul(a: Ratio, b: Ratio): Ratio {
  return ratio(a.n * b.n, a.d * b.d);
}
export function div(a: Ratio, b: Ratio): Ratio {
  if (b.n === 0n) fail("CORE_TYPE_ERROR", "$", "division by zero ratio");
  return ratio(a.n * b.d, a.d * b.n);
}
export function cmp(a: Ratio, b: Ratio): -1 | 0 | 1 {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
export function sum(rs: Iterable<Ratio>): Ratio {
  let acc = ZERO;
  for (const r of rs) acc = add(acc, r);
  return acc;
}
export function fromBps(bps: number): Ratio {
  return ratio(BigInt(bps), 10000n);
}
export function formatRatio(r: Ratio): string {
  return `${r.n}/${r.d}`;
}

const RATIO_RE = /^(-?(?:0|[1-9]\d*))\/([1-9]\d*)$/;
export function parseRatio(s: string, path = "$"): Ratio {
  const m = RATIO_RE.exec(s);
  if (!m) fail("CORE_TYPE_ERROR", path, `not a ratio literal: ${s}`);
  const r = ratio(BigInt(m[1]!), BigInt(m[2]!));
  if (formatRatio(r) !== s) fail("CORE_TYPE_ERROR", path, `ratio not in lowest terms: ${s}`);
  return r;
}
```

`src/core/bps.ts`:
```ts
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
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/core/ratio.test.ts test/core/bps.test.ts && npx tsc -p tsconfig.json`
Expected: PASS, tsc 출력 없음.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/core/ratio.ts 04_구현_소스코드/mdrl/src/core/bps.ts 04_구현_소스코드/mdrl/test/core/ratio.test.ts 04_구현_소스코드/mdrl/test/core/bps.test.ts && git commit -m "feat(mdrl): 정확한 유리수 Ratio와 bps 파싱"
```

---

### Task 3: 정규형 · digest · 커밋먼트

**Files:**
- Create: `src/core/jcs.ts`, `src/core/digest.ts`, `src/core/commit.ts`
- Test: `test/core/jcs.test.ts`, `test/core/digest.test.ts`

**Interfaces:**
- Consumes: `fail` (Task 1)
- Produces: `canonicalize(value: unknown, path?): string`; `DIGEST_PREFIX = "mdrl:sha256:"`, `sha256Hex(bytes: Uint8Array): string`, `digestOf(value: unknown): string`, `isDigest(v: unknown): v is string`; `type Commitment = { commit: string }`, `commitValue(value, salt: Uint8Array): Commitment`, `openCommitment(c, value, salt): boolean`, `isCommitment(v): v is Commitment`.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/core/jcs.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../../src/core/jcs.ts";
import { MdrlError } from "../../src/core/errors.ts";

test("keys sorted, no whitespace", () => {
  assert.equal(canonicalize({ b: [true, null], a: "1" }), '{"a":"1","b":[true,null]}');
});

test("undefined properties are dropped", () => {
  assert.equal(canonicalize({ a: "1", z: undefined }), '{"a":"1"}');
});

test("numbers are rejected with path", () => {
  assert.throws(
    () => canonicalize({ a: [ "x", 1 ] }),
    (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === "CORE_NUMBER_IN_IR" && e.diagnostics[0]?.path === "$.a[1]",
  );
});

test("non-plain objects rejected", () => {
  assert.throws(() => canonicalize({ d: new Date(0) }), MdrlError);
  assert.throws(() => canonicalize({ b: 1n }), MdrlError);
});

test("keys sorted by UTF-16 code units", () => {
  assert.equal(canonicalize({ "é": "x", z: "y", A: "w" }), '{"A":"w","z":"y","é":"x"}');
});
```

`test/core/digest.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { digestOf, isDigest } from "../../src/core/digest.ts";
import { commitValue, isCommitment, openCommitment } from "../../src/core/commit.ts";
import { MdrlError } from "../../src/core/errors.ts";

test("digest of canonical form (known vector)", () => {
  const d = digestOf({ b: [true, null], a: "1" });
  assert.equal(d, "mdrl:sha256:8770938d7bda22ac6540b6f5bf73cf4466dc9ff189805b7ccc3c6702716c7557");
  assert.equal(digestOf({ a: "1", b: [true, null] }), d);
  assert.equal(isDigest(d), true);
  assert.equal(isDigest("sha256:abc"), false);
});

test("commitment (known vector) and opening", () => {
  const salt = new Uint8Array(32);
  const c = commitValue("x", salt);
  assert.deepEqual(c, { commit: "mdrl:sha256:3c5486f0bbca8dbba1138169ee91d51cc6e06efdfd96044c2e05c43ffee668d4" });
  assert.equal(isCommitment(c), true);
  assert.equal(openCommitment(c, "x", salt), true);
  assert.equal(openCommitment(c, "y", salt), false);
  const other = new Uint8Array(32).fill(1);
  assert.equal(openCommitment(c, "x", other), false);
});

test("salt must be 32 bytes", () => {
  assert.throws(() => commitValue("x", new Uint8Array(16)), MdrlError);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/core/jcs.test.ts test/core/digest.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 구현**

`src/core/jcs.ts`:
```ts
import { fail } from "./errors.ts";

/** RFC 8785 JCS. MDRL IR은 JSON number를 금지하므로 number는 오류로 처리한다. */
export function canonicalize(value: unknown, path = "$"): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
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
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k], `${path}.${k}`)).join(",") + "}";
    }
    default:
      return fail("CORE_TYPE_ERROR", path, `unsupported type ${typeof value}`);
  }
}
```

`src/core/digest.ts`:
```ts
import { createHash } from "node:crypto";
import { canonicalize } from "./jcs.ts";

export const DIGEST_PREFIX = "mdrl:sha256:";
const DIGEST_RE = /^mdrl:sha256:[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestOf(value: unknown): string {
  return DIGEST_PREFIX + sha256Hex(new TextEncoder().encode(canonicalize(value)));
}

export function isDigest(v: unknown): v is string {
  return typeof v === "string" && DIGEST_RE.test(v);
}
```

`src/core/commit.ts`:
```ts
import { DIGEST_PREFIX, isDigest, sha256Hex } from "./digest.ts";
import { fail } from "./errors.ts";
import { canonicalize } from "./jcs.ts";

export type Commitment = { commit: string };
export const SALT_BYTES = 32;

export function commitValue(value: unknown, salt: Uint8Array): Commitment {
  if (salt.length !== SALT_BYTES) fail("CORE_TYPE_ERROR", "$salt", `salt must be ${SALT_BYTES} bytes`);
  const body = new TextEncoder().encode(canonicalize(value));
  const buf = new Uint8Array(salt.length + body.length);
  buf.set(salt, 0);
  buf.set(body, salt.length);
  return { commit: DIGEST_PREFIX + sha256Hex(buf) };
}

export function openCommitment(c: Commitment, value: unknown, salt: Uint8Array): boolean {
  return commitValue(value, salt).commit === c.commit;
}

export function isCommitment(v: unknown): v is Commitment {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.keys(v).length === 1 && isDigest((v as Record<string, unknown>).commit)
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/core/jcs.test.ts test/core/digest.test.ts && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/core/jcs.ts 04_구현_소스코드/mdrl/src/core/digest.ts 04_구현_소스코드/mdrl/src/core/commit.ts 04_구현_소스코드/mdrl/test/core/jcs.test.ts 04_구현_소스코드/mdrl/test/core/digest.test.ts && git commit -m "feat(mdrl): JCS 정규형, digest, 해시 커밋먼트"
```

---

### Task 4: 시각 · 참조 · IR 봉투 · 의존 검증 + envelope 스키마

**Files:**
- Create: `src/core/time.ts`, `src/core/ref.ts`, `src/core/envelope.ts`, `spec/schema/envelope.schema.json`
- Test: `test/core/time.test.ts`, `test/core/envelope.test.ts`

**Interfaces:**
- Consumes: `fail`, `diag`, `capture`, `Diagnostic` (T1), `isEnumValue`, `EnumValue` (T1), `canonicalize` (T3), `digestOf`, `isDigest` (T3)
- Produces: `type Instant = string`, `isInstant(v)`, `type Interval = { from: Instant; to?: Instant }`, `contains(iv, t): boolean`, `checkInterval(v: unknown, path): Diagnostic[]`; `type Ref = { kind: EnumValue<"module">; id: string; version: number }`, `parseRef(s, path?)`, `formatRef(r)`; `LANGUAGE_VERSION = "1.0"`, `type Dependency = { ref: string; digest: string }`, `type IrDocument<B = unknown> = { mdrl: string; module: EnumValue<"module">; id: string; version: string; depends_on: Dependency[]; visibility_default: EnumValue<"visibility">; body: B }`, `MODULE_RANK`, `validateEnvelope(doc: unknown): Diagnostic[]`, `refOf(doc): string`, `checkDependencies(docs: readonly IrDocument[]): Diagnostic[]`.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/core/time.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInterval, contains, isInstant } from "../../src/core/time.ts";
import { formatRef, parseRef } from "../../src/core/ref.ts";
import { MdrlError } from "../../src/core/errors.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-07-01T00:00:00.000Z";

test("isInstant requires canonical UTC millisecond format", () => {
  assert.ok(isInstant(T0));
  for (const bad of ["2026-01-01", "2026-01-01T00:00:00Z", "2026-02-30T00:00:00.000Z", "2026-01-01T00:00:00.000+09:00", 5]) {
    assert.equal(isInstant(bad), false, String(bad));
  }
});

test("contains is half-open [from, to)", () => {
  assert.equal(contains({ from: T0, to: T1 }, T0), true);
  assert.equal(contains({ from: T0, to: T1 }, T1), false);
  assert.equal(contains({ from: T0 }, "2099-01-01T00:00:00.000Z"), true);
  assert.equal(contains({ from: T1 }, T0), false);
});

test("checkInterval", () => {
  assert.deepEqual(checkInterval({ from: T0 }, "$.v"), []);
  assert.deepEqual(checkInterval({ from: T1, to: T0 }, "$.v").map((d) => d.code), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(checkInterval({ from: "2026-01-01" }, "$.v").map((d) => d.path), ["$.v.from"]);
  assert.deepEqual(checkInterval("x", "$.v").map((d) => d.code), ["CORE_TYPE_ERROR"]);
});

test("refs", () => {
  const r = parseRef("vc:facts/nova-debut-01@3");
  assert.deepEqual(r, { kind: "facts", id: "nova-debut-01", version: 3 });
  assert.equal(formatRef(r), "vc:facts/nova-debut-01@3");
  assert.throws(() => parseRef("vc:facts/x"), MdrlError);
  assert.throws(
    () => parseRef("vc:unknown/x@1"),
    (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === "CORE_ENUM_UNKNOWN",
  );
});
```

`test/core/envelope.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { checkDependencies, validateEnvelope, type Dependency, type IrDocument } from "../../src/core/envelope.ts";
import { digestOf } from "../../src/core/digest.ts";
import type { EnumValue } from "../../src/core/enums.ts";

function doc(module: EnumValue<"module">, id: string, deps: Dependency[] = []): IrDocument {
  return { mdrl: "1.0", module, id, version: "1", depends_on: deps, visibility_default: "PARTIES", body: {} };
}

test("valid envelope has no diagnostics", () => {
  assert.deepEqual(validateEnvelope(doc("facts", "f")), []);
});

test("envelope errors are reported", () => {
  const bad = { ...doc("facts", "f"), mdrl: "2.0", version: 1 };
  const codes = validateEnvelope(bad).map((d) => d.code);
  assert.ok(codes.includes("CORE_NUMBER_IN_IR"));
  assert.ok(codes.includes("CORE_TYPE_ERROR"));
  assert.deepEqual(validateEnvelope({ ...doc("facts", "f"), module: "policy" }).map((d) => d.code), ["CORE_ENUM_UNKNOWN"]);
  assert.deepEqual(validateEnvelope([]).map((d) => d.code), ["CORE_TYPE_ERROR"]);
});

test("dependencies: ok, digest mismatch, direction, unknown", () => {
  const facts = doc("facts", "f");
  const alloc = doc("allocation", "a", [{ ref: "vc:facts/f@1", digest: digestOf(facts) }]);
  assert.deepEqual(checkDependencies([facts, alloc]), []);

  const stale = doc("allocation", "a", [{ ref: "vc:facts/f@1", digest: digestOf({ other: "x" }) }]);
  assert.deepEqual(checkDependencies([facts, stale]).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);

  const back = doc("facts", "g", [{ ref: "vc:allocation/a@1", digest: digestOf(alloc) }]);
  assert.deepEqual(checkDependencies([alloc, back, facts]).map((d) => d.code), ["CORE_DEP_DIRECTION"]);

  const missing = doc("allocation", "a", [{ ref: "vc:facts/zzz@1", digest: digestOf(facts) }]);
  assert.deepEqual(checkDependencies([missing]).map((d) => d.code), ["CORE_UNKNOWN_REF"]);
});

test("envelope JSON Schema agrees with validator", () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
  const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
  const schema = JSON.parse(readFileSync(new URL("../../spec/schema/envelope.schema.json", import.meta.url), "utf8"));
  const validate = ajv.compile(schema);
  assert.equal(validate(doc("facts", "f")), true);
  assert.equal(validate({ ...doc("facts", "f"), version: 1 }), false);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/core/time.test.ts test/core/envelope.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 구현**

`src/core/time.ts`:
```ts
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
```

`src/core/ref.ts`:
```ts
import { isEnumValue, type EnumValue } from "./enums.ts";
import { fail } from "./errors.ts";

export type Ref = { kind: EnumValue<"module">; id: string; version: number };
const REF_RE = /^vc:([a-z]+)\/([A-Za-z0-9._-]+)@([1-9]\d*)$/;

export function parseRef(s: string, path = "$"): Ref {
  const m = REF_RE.exec(s);
  if (!m) fail("CORE_TYPE_ERROR", path, `not a ref: ${s}`);
  const kind = m[1];
  if (!isEnumValue("module", kind)) fail("CORE_ENUM_UNKNOWN", path, `module ${kind}`);
  return { kind, id: m[2]!, version: Number(m[3]) };
}

export function formatRef(r: Ref): string {
  return `vc:${r.kind}/${r.id}@${r.version}`;
}
```

`src/core/envelope.ts`:
```ts
import { digestOf, isDigest } from "./digest.ts";
import { isEnumValue, type EnumValue } from "./enums.ts";
import { capture, diag, type Diagnostic } from "./errors.ts";
import { canonicalize } from "./jcs.ts";
import { parseRef } from "./ref.ts";

export const LANGUAGE_VERSION = "1.0";

export type Dependency = { ref: string; digest: string };
export type IrDocument<B = unknown> = {
  mdrl: string;
  module: EnumValue<"module">;
  id: string;
  version: string;
  depends_on: Dependency[];
  visibility_default: EnumValue<"visibility">;
  body: B;
};

/** 의존은 낮은 rank로만 향한다. 같은 rank·역방향은 CORE_DEP_DIRECTION (순환은 이 규칙으로 불가능해진다). */
export const MODULE_RANK: Readonly<Record<EnumValue<"module">, number>> = {
  core: 0, facts: 1, constraint: 2, grant: 2, approval: 3, allocation: 4,
};

const ID_RE = /^[A-Za-z0-9._-]+$/;
const VERSION_RE = /^[1-9]\d*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateEnvelope(doc: unknown): Diagnostic[] {
  if (!isObject(doc)) return [diag("CORE_TYPE_ERROR", "$", "document must be an object")];
  const out: Diagnostic[] = [...capture(() => canonicalize(doc))];
  if (doc.mdrl !== LANGUAGE_VERSION) out.push(diag("CORE_TYPE_ERROR", "$.mdrl", `expected "${LANGUAGE_VERSION}"`));
  if (!isEnumValue("module", doc.module)) out.push(diag("CORE_ENUM_UNKNOWN", "$.module", String(doc.module)));
  if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) out.push(diag("CORE_TYPE_ERROR", "$.id"));
  if (typeof doc.version !== "string" || !VERSION_RE.test(doc.version)) out.push(diag("CORE_TYPE_ERROR", "$.version"));
  if (!isEnumValue("visibility", doc.visibility_default)) {
    out.push(diag("CORE_ENUM_UNKNOWN", "$.visibility_default", String(doc.visibility_default)));
  }
  if (!isObject(doc.body)) out.push(diag("CORE_TYPE_ERROR", "$.body", "body must be an object"));
  if (!Array.isArray(doc.depends_on)) {
    out.push(diag("CORE_TYPE_ERROR", "$.depends_on", "must be an array"));
  } else {
    doc.depends_on.forEach((dep: unknown, i: number) => {
      const p = `$.depends_on[${i}]`;
      if (!isObject(dep) || typeof dep.ref !== "string" || !isDigest(dep.digest)) {
        out.push(diag("CORE_TYPE_ERROR", p, "expected { ref, digest }"));
        return;
      }
      const ref = dep.ref;
      out.push(...capture(() => parseRef(ref, `${p}.ref`)));
    });
  }
  return out;
}

export function refOf(doc: IrDocument): string {
  return `vc:${doc.module}/${doc.id}@${doc.version}`;
}

export function checkDependencies(docs: readonly IrDocument[]): Diagnostic[] {
  const byRef = new Map(docs.map((d) => [refOf(d), d]));
  const out: Diagnostic[] = [];
  for (const doc of docs) {
    doc.depends_on.forEach((dep, i) => {
      const p = `${refOf(doc)}.depends_on[${i}]`;
      const target = byRef.get(dep.ref);
      if (!target) {
        out.push(diag("CORE_UNKNOWN_REF", p, dep.ref));
        return;
      }
      if (MODULE_RANK[target.module] >= MODULE_RANK[doc.module]) {
        out.push(diag("CORE_DEP_DIRECTION", p, `${doc.module} -> ${target.module}`));
      }
      const actual = digestOf(target);
      if (actual !== dep.digest) out.push(diag("CORE_DIGEST_MISMATCH", p, `${dep.digest} != ${actual}`));
    });
  }
  return out;
}
```

`spec/schema/envelope.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mdrl.invalid/1.0/envelope.schema.json",
  "title": "MDRL IR document envelope",
  "type": "object",
  "additionalProperties": false,
  "required": ["mdrl", "module", "id", "version", "depends_on", "visibility_default", "body"],
  "properties": {
    "mdrl": { "const": "1.0" },
    "module": { "enum": ["core", "facts", "constraint", "grant", "approval", "allocation"] },
    "id": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$" },
    "version": { "type": "string", "pattern": "^[1-9][0-9]*$" },
    "depends_on": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["ref", "digest"],
        "properties": {
          "ref": { "type": "string", "pattern": "^vc:[a-z]+/[A-Za-z0-9._-]+@[1-9][0-9]*$" },
          "digest": { "type": "string", "pattern": "^mdrl:sha256:[0-9a-f]{64}$" }
        }
      }
    },
    "visibility_default": { "enum": ["PUBLIC", "PARTIES", "PRIVATE"] },
    "body": { "type": "object" }
  }
}
```

(`mdrl.invalid`은 예약 TLD로, 스키마 식별자일 뿐 네트워크로 조회하지 않는다.)

- [ ] **Step 4: 통과 확인**

Run: `node --test test/core/time.test.ts test/core/envelope.test.ts && npx tsc -p tsconfig.json`
Expected: PASS. tsc가 `ajv/dist/2020.js` 타입 import에서 오류를 내면 해당 줄을 `const Ajv2020 = require("ajv/dist/2020") as new (opts: object) => { compile(s: object): (d: unknown) => boolean };`로 바꾼다.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/core/time.ts 04_구현_소스코드/mdrl/src/core/ref.ts 04_구현_소스코드/mdrl/src/core/envelope.ts 04_구현_소스코드/mdrl/spec/schema/envelope.schema.json 04_구현_소스코드/mdrl/test/core/time.test.ts 04_구현_소스코드/mdrl/test/core/envelope.test.ts && git commit -m "feat(mdrl): 시각·참조·IR 봉투·의존 digest 검증"
```

---

### Task 5: Ed25519 증명 · 내장 SoD + core index

**Files:**
- Create: `src/core/attest.ts`, `src/core/index.ts`
- Test: `test/core/attest.test.ts`

**Interfaces:**
- Consumes: `diag`, `Diagnostic` (T1), `isEnumValue`, `EnumValue` (T1), `digestOf` (T3)
- Produces: `type Attestation = { signer: string; role: EnumValue<"attestation_role">; over: string; alg: "Ed25519"; sig: string }`, `signAttestation({ signer, role, over, privateKeyPem }): Attestation`, `verifyAttestation(att, publicKeyPem): boolean`, `type KeyRegistry = Readonly<Record<string, string>>`, `checkAttestations(atts, expectedDigest, keys): Diagnostic[]`, `BUILTIN_SOD`, `checkSod(atts): Diagnostic[]`. `src/core/index.ts`는 core 전체를 재수출한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/core/attest.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { checkAttestations, checkSod, signAttestation, verifyAttestation, type Attestation } from "../../src/core/attest.ts";
import { digestOf } from "../../src/core/digest.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const D = digestOf({ a: "1" });
const alice = keypair();
const bob = keypair();

test("sign and verify", () => {
  const att = signAttestation({ signer: "pty_alice", role: "EDITOR", over: D, privateKeyPem: alice.priv });
  assert.equal(att.alg, "Ed25519");
  assert.equal(verifyAttestation(att, alice.pub), true);
  assert.equal(verifyAttestation(att, bob.pub), false);
});

test("checkAttestations reports digest, key and signature problems", () => {
  const keys = { pty_alice: alice.pub, pty_bob: bob.pub };
  const good = signAttestation({ signer: "pty_alice", role: "EDITOR", over: D, privateKeyPem: alice.priv });
  assert.deepEqual(checkAttestations([good], D, keys), []);

  const other = signAttestation({ signer: "pty_bob", role: "ACTIVATOR", over: digestOf({ b: "2" }), privateKeyPem: bob.priv });
  assert.deepEqual(checkAttestations([other], D, keys).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);

  const forged: Attestation = { ...good, signer: "pty_bob" };
  assert.deepEqual(checkAttestations([forged], D, keys).map((d) => d.code), ["CORE_SIGNATURE_INVALID"]);

  const unknown: Attestation = { ...good, signer: "pty_carol" };
  assert.deepEqual(checkAttestations([unknown], D, keys).map((d) => d.code), ["CORE_UNKNOWN_REF"]);
});

test("built-in SoD: editor != activator, ops != settle", () => {
  const a = (signer: string, role: Attestation["role"]): Attestation => ({ signer, role, over: D, alg: "Ed25519", sig: "x" });
  assert.deepEqual(checkSod([a("p1", "EDITOR"), a("p2", "ACTIVATOR")]), []);
  assert.deepEqual(checkSod([a("p1", "EDITOR"), a("p1", "ACTIVATOR")]).map((d) => d.code), ["CORE_SOD_VIOLATION"]);
  assert.deepEqual(checkSod([a("p9", "SPACE_OPS"), a("p9", "SPACE_SETTLE")]).map((d) => d.code), ["CORE_SOD_VIOLATION"]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/core/attest.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 구현**

`src/core/attest.ts`:
```ts
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { isEnumValue, type EnumValue } from "./enums.ts";
import { diag, type Diagnostic } from "./errors.ts";

export type AttestationRole = EnumValue<"attestation_role">;
export type Attestation = { signer: string; role: AttestationRole; over: string; alg: "Ed25519"; sig: string };
export type KeyRegistry = Readonly<Record<string, string>>;

/** 서명 대상 메시지는 digest 문자열의 UTF-8 바이트다. */
export function signAttestation(p: { signer: string; role: AttestationRole; over: string; privateKeyPem: string }): Attestation {
  const sig = sign(null, Buffer.from(p.over, "utf8"), createPrivateKey(p.privateKeyPem)).toString("base64url");
  return { signer: p.signer, role: p.role, over: p.over, alg: "Ed25519", sig };
}

export function verifyAttestation(att: Attestation, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(att.over, "utf8"), createPublicKey(publicKeyPem), Buffer.from(att.sig, "base64url"));
  } catch {
    return false;
  }
}

export function checkAttestations(atts: readonly Attestation[], expectedDigest: string, keys: KeyRegistry): Diagnostic[] {
  const out: Diagnostic[] = [];
  atts.forEach((att, i) => {
    const p = `$.attestations[${i}]`;
    if (!isEnumValue("attestation_role", att.role)) {
      out.push(diag("CORE_ENUM_UNKNOWN", `${p}.role`, String(att.role)));
      return;
    }
    if (att.over !== expectedDigest) {
      out.push(diag("CORE_DIGEST_MISMATCH", `${p}.over`, `${att.over} != ${expectedDigest}`));
      return;
    }
    const key = keys[att.signer];
    if (key === undefined) {
      out.push(diag("CORE_UNKNOWN_REF", `${p}.signer`, att.signer));
      return;
    }
    if (!verifyAttestation(att, key)) out.push(diag("CORE_SIGNATURE_INVALID", p, att.signer));
  });
  return out;
}

/** approval 모듈(서브프로젝트 3) 이전까지 코어가 강제하는 직무 분리 규칙. */
export const BUILTIN_SOD: readonly (readonly [AttestationRole, AttestationRole])[] = [
  ["EDITOR", "ACTIVATOR"],
  ["SPACE_OPS", "SPACE_SETTLE"],
];

export function checkSod(atts: readonly Attestation[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [a, b] of BUILTIN_SOD) {
    const holders = new Set(atts.filter((x) => x.role === a).map((x) => x.signer));
    for (const x of atts) {
      if (x.role === b && holders.has(x.signer)) out.push(diag("CORE_SOD_VIOLATION", "$.attestations", `${x.signer} is both ${a} and ${b}`));
    }
  }
  return out;
}
```

`src/core/index.ts`:
```ts
export * from "./errors.ts";
export * from "./enums.ts";
export * from "./ratio.ts";
export * from "./bps.ts";
export * from "./jcs.ts";
export * from "./digest.ts";
export * from "./commit.ts";
export * from "./time.ts";
export * from "./ref.ts";
export * from "./envelope.ts";
export * from "./attest.ts";
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npx tsc -p tsconfig.json`
Expected: core 테스트 전체 PASS, tsc 출력 없음.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/core/attest.ts 04_구현_소스코드/mdrl/src/core/index.ts 04_구현_소스코드/mdrl/test/core/attest.test.ts && git commit -m "feat(mdrl): Ed25519 증명 검증과 내장 SoD"
```

---

### Task 6: facts IR 타입 · 스키마 · 구조 검증 + 기본 픽스처

**Files:**
- Create: `src/facts/types.ts`, `src/facts/validate.ts` (구조 검증만), `spec/schema/facts.ir.schema.json`
- Create: `conformance/facts/001-basic/input.json`, `test/helpers.ts`
- Test: `test/facts/structure.test.ts`

**Interfaces:**
- Consumes: T1~T4 (`parseBps`, `validateEnvelope`, `IrDocument`, `isEnumValue`, `EnumName`, `capture`, `diag`, `checkInterval`, `isInstant`, `Instant`, `Interval`)
- Produces:
  - `types.ts`: `type EntityType = "party"|"work"|"recording"|"voice"|"stem"|"claim"|"mandate"`, `CLAIM_EDGE_KINDS`, `type ClaimEdge`, `MAX_MANDATE_HOPS = 2`, `type Party`, `Work`, `Recording`, `Voice`, `Stem`, `Claim`, `Mandate`, `FactsBody`, `FactsDocument = IrDocument<FactsBody>`, `type ClaimantRole = EnumValue<"claimant_role">`
  - `validate.ts`: `validateFactsStructure(doc: unknown): Diagnostic[]`
  - `test/helpers.ts`: `type BasicInput`, `loadBasic(): BasicInput`, `claimOf(input, id): Claim`, `mandateOf(input, id): Mandate`

- [ ] **Step 1: 타입 파일 작성** (테스트가 타입을 import하므로 먼저 둔다)

`src/facts/types.ts`:
```ts
import type { EnumValue } from "../core/enums.ts";
import type { IrDocument } from "../core/envelope.ts";
import type { Instant, Interval } from "../core/time.ts";

type Visibility = EnumValue<"visibility">;
export type ClaimantRole = EnumValue<"claimant_role">;
export type EntityType = "party" | "work" | "recording" | "voice" | "stem" | "claim" | "mandate";

/** share를 가지는 권리 주장 엣지와 허용 source→target 종류. 구조 관계(stem.of, recording.of)는 필드로 표현한다. */
export const CLAIM_EDGE_KINDS = {
  PERFORMED_BY: ["stem", "voice"],
  OWNED_BY: ["voice", "party"],
  CONTROLLED_BY: ["recording", "party"],
  WRITTEN_BY: ["work", "party"],
  CONTRIBUTED_BY: ["recording", "party"],
} as const satisfies Record<string, readonly [EntityType, EntityType]>;
export type ClaimEdge = keyof typeof CLAIM_EDGE_KINDS;

export const MAX_MANDATE_HOPS = 2;

export type Party = { id: string; kind: EnumValue<"party_kind">; ids?: Record<string, string>; visibility?: Visibility };
export type Work = { id: string; ids?: Record<string, string> };
export type Recording = { id: string; of: string; ids?: Record<string, string> };
export type Voice = { id: string; kind: EnumValue<"voice_kind"> };
export type Stem = { id: string; of: string; slot: string; rights_bearing: boolean };

type Recorded = { recorded_at: Instant; superseded_at?: Instant; status: EnumValue<"claim_status">; valid: Interval };

export type Claim = Recorded & {
  id: string;
  source: string;
  edge: ClaimEdge;
  target: string;
  share: string;
  performer_role?: EnumValue<"performer_role">;
  role_detail?: string;
  evidence?: string;
  visibility?: Visibility;
};

export type Mandate = Recorded & {
  id: string;
  from: string;
  to: string;
  right: EnumValue<"mandate_right">;
  share: string;
  visibility?: Visibility;
};

export type FactsBody = {
  parties: Party[];
  works: Work[];
  recordings: Recording[];
  voices: Voice[];
  stems: Stem[];
  claims: Claim[];
  mandates: Mandate[];
};

export type FactsDocument = IrDocument<FactsBody>;
```

- [ ] **Step 2: 기본 픽스처와 테스트 헬퍼 작성**

`conformance/facts/001-basic/input.json`:
```json
{
  "facts": {
    "mdrl": "1.0",
    "module": "facts",
    "id": "nova-debut-01",
    "version": "1",
    "depends_on": [],
    "visibility_default": "PARTIES",
    "body": {
      "parties": [
        { "id": "pty_agency_s", "kind": "AGENCY" },
        { "id": "pty_author_b", "kind": "AUTHOR" },
        { "id": "pty_author_c", "kind": "AUTHOR" },
        { "id": "pty_komca", "kind": "CMO" },
        { "id": "pty_label_x", "kind": "LABEL", "ids": { "isni": "0000000123456789" } },
        { "id": "pty_member_a", "kind": "PERFORMER" },
        { "id": "pty_member_b", "kind": "PERFORMER" }
      ],
      "works": [{ "id": "wrk_01", "ids": { "iswc": "T-123.456.789-0" } }],
      "recordings": [{ "id": "rcd_01", "of": "wrk_01", "ids": { "isrc": "KRA012600001" } }],
      "voices": [
        { "id": "vo_a", "kind": "HUMAN" },
        { "id": "vo_b", "kind": "HUMAN" }
      ],
      "stems": [
        { "id": "stm_inst", "of": "rcd_01", "slot": "slt_inst", "rights_bearing": true },
        { "id": "stm_v1", "of": "rcd_01", "slot": "slt_v1", "rights_bearing": true },
        { "id": "stm_v2", "of": "rcd_01", "slot": "slt_v2", "rights_bearing": true }
      ],
      "claims": [
        { "id": "c1", "source": "stm_v1", "edge": "PERFORMED_BY", "target": "vo_a", "share": "10000", "performer_role": "FEATURED", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z" },
        { "id": "c2", "source": "stm_v2", "edge": "PERFORMED_BY", "target": "vo_b", "share": "10000", "performer_role": "FEATURED", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z" },
        { "id": "c3", "source": "vo_a", "edge": "OWNED_BY", "target": "pty_member_a", "share": "10000", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z" },
        { "id": "c4", "source": "vo_b", "edge": "OWNED_BY", "target": "pty_member_b", "share": "10000", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z" },
        { "id": "c5", "source": "rcd_01", "edge": "CONTROLLED_BY", "target": "pty_label_x", "share": "10000", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z", "evidence": "mdrl:sha256:0000000000000000000000000000000000000000000000000000000000000017" },
        { "id": "c6", "source": "wrk_01", "edge": "WRITTEN_BY", "target": "pty_author_b", "share": "6000", "role_detail": "LYRICS", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z" },
        { "id": "c7", "source": "wrk_01", "edge": "WRITTEN_BY", "target": "pty_author_c", "share": "4000", "role_detail": "COMPOSITION", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z" }
      ],
      "mandates": [
        { "id": "m1", "from": "pty_author_b", "to": "pty_komca", "right": "WORK", "share": "10000", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z" },
        { "id": "m2", "from": "pty_member_a", "to": "pty_agency_s", "right": "PERFORMER", "share": "10000", "status": "VERIFIED", "valid": { "from": "2026-01-01T00:00:00.000Z" }, "recorded_at": "2026-01-01T00:00:00.000Z" }
      ]
    }
  },
  "usage": { "stm_inst": "90000", "stm_v1": "60000", "stm_v2": "30000" },
  "as_of": "2026-06-01T00:00:00.000Z",
  "known_at": "2026-06-01T00:00:00.000Z",
  "declared_claimants": [
    { "role": "AGENCY", "party": "pty_agency_s" },
    { "role": "CMO", "party": "pty_komca" },
    { "role": "MASTER_OWNER", "party": "pty_label_x" },
    { "role": "PERFORMER_FEATURED", "party": "pty_member_a" },
    { "role": "PERFORMER_FEATURED", "party": "pty_member_b" },
    { "role": "WORK_AUTHOR", "party": "pty_author_b" },
    { "role": "WORK_AUTHOR", "party": "pty_author_c" }
  ]
}
```

`test/helpers.ts`:
```ts
import { readFileSync } from "node:fs";
import type { Claim, ClaimantRole, FactsDocument, Mandate } from "../src/facts/types.ts";

export type BasicInput = {
  facts: FactsDocument;
  usage: Record<string, string>;
  as_of: string;
  known_at: string;
  declared_claimants: { role: ClaimantRole; party: string }[];
};

/** 매 호출마다 파일을 새로 읽으므로 반환값을 자유롭게 변형해도 된다. */
export function loadBasic(): BasicInput {
  return JSON.parse(readFileSync(new URL("../conformance/facts/001-basic/input.json", import.meta.url), "utf8"));
}

export function claimOf(input: BasicInput, id: string): Claim {
  const c = input.facts.body.claims.find((x) => x.id === id);
  if (!c) throw new Error(`no claim ${id}`);
  return c;
}

export function mandateOf(input: BasicInput, id: string): Mandate {
  const m = input.facts.body.mandates.find((x) => x.id === id);
  if (!m) throw new Error(`no mandate ${id}`);
  return m;
}
```

- [ ] **Step 3: 실패하는 테스트 작성**

`test/facts/structure.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { validateFactsStructure } from "../../src/facts/validate.ts";
import { CLAIM_EDGE_KINDS } from "../../src/facts/types.ts";
import { ENUMS } from "../../src/core/enums.ts";
import { claimOf, loadBasic } from "../helpers.ts";

const codes = (doc: unknown) => validateFactsStructure(doc).map((d) => d.code);

test("claim edges are registered edge types", () => {
  for (const e of Object.keys(CLAIM_EDGE_KINDS)) assert.ok((ENUMS.edge_type as readonly string[]).includes(e), e);
});

test("basic fixture is structurally valid", () => {
  assert.deepEqual(validateFactsStructure(loadBasic().facts), []);
});

test("wrong module is rejected", () => {
  const i = loadBasic();
  assert.deepEqual(codes({ ...i.facts, module: "allocation" }), ["CORE_TYPE_ERROR"]);
});

test("duplicate id", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_komca", kind: "CMO" });
  assert.deepEqual(codes(i.facts), ["FACTS_DUPLICATE_ID"]);
});

test("unknown party and unknown entity", () => {
  const i = loadBasic();
  claimOf(i, "c5").target = "pty_ghost";
  i.facts.body.stems[0]!.of = "rcd_ghost";
  assert.deepEqual(codes(i.facts).sort(), ["FACTS_UNKNOWN_ENTITY", "FACTS_UNKNOWN_PARTY"]);
});

test("edge kind mismatch", () => {
  const i = loadBasic();
  claimOf(i, "c5").source = "wrk_01";
  assert.deepEqual(codes(i.facts), ["FACTS_EDGE_KIND"]);
});

test("performer_role required on PERFORMED_BY and forbidden elsewhere", () => {
  const i = loadBasic();
  delete claimOf(i, "c1").performer_role;
  claimOf(i, "c3").performer_role = "FEATURED";
  assert.deepEqual(codes(i.facts).sort(), ["CORE_ENUM_UNKNOWN", "CORE_TYPE_ERROR"]);
});

test("share, status, interval, recorded_at formats", () => {
  const i = loadBasic();
  claimOf(i, "c5").share = "10001";
  claimOf(i, "c6").status = "PENDING" as never;
  claimOf(i, "c7").valid = { from: "2026-01-01" };
  claimOf(i, "c4").superseded_at = "2025-01-01T00:00:00.000Z";
  assert.deepEqual(codes(i.facts).sort(), ["CORE_ENUM_UNKNOWN", "CORE_TYPE_ERROR", "CORE_TYPE_ERROR", "CORE_TYPE_ERROR"]);
});

test("facts JSON Schema agrees with validator", () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
  const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../../spec/schema/${f}`, import.meta.url), "utf8"));
  ajv.addSchema(load("envelope.schema.json"));
  const validate = ajv.compile(load("facts.ir.schema.json"));
  const i = loadBasic();
  assert.equal(validate(i.facts), true, JSON.stringify(validate.errors));
  claimOf(i, "c5").share = 10000 as never;
  assert.equal(validate(i.facts), false);
  assert.ok(codes(i.facts).length > 0);
});
```

- [ ] **Step 4: 실패 확인**

Run: `node --test test/facts/structure.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/facts/validate.ts`).

- [ ] **Step 5: 구조 검증 구현**

`src/facts/validate.ts`:
```ts
import { parseBps } from "../core/bps.ts";
import { validateEnvelope } from "../core/envelope.ts";
import { isEnumValue, type EnumName } from "../core/enums.ts";
import { capture, diag, type Diagnostic } from "../core/errors.ts";
import { checkInterval, isInstant } from "../core/time.ts";
import { CLAIM_EDGE_KINDS, type EntityType, type FactsBody, type FactsDocument } from "./types.ts";

const ARRAYS = ["parties", "works", "recordings", "voices", "stems", "claims", "mandates"] as const;
const ENTITY_OF: Record<(typeof ARRAYS)[number], EntityType> = {
  parties: "party", works: "work", recordings: "recording", voices: "voice",
  stems: "stem", claims: "claim", mandates: "mandate",
};

export function validateFactsStructure(doc: unknown): Diagnostic[] {
  const env = validateEnvelope(doc);
  if (env.length > 0) return env;
  const d = doc as FactsDocument;
  if (d.module !== "facts") return [diag("CORE_TYPE_ERROR", "$.module", "expected facts")];
  const partial = d.body as Partial<FactsBody>;
  const shape = ARRAYS.filter((k) => !Array.isArray(partial[k])).map((k) => diag("CORE_TYPE_ERROR", `$.body.${k}`, "must be an array"));
  if (shape.length > 0) return shape;
  const body = d.body;
  const out: Diagnostic[] = [];

  const kinds = new Map<string, EntityType>();
  for (const key of ARRAYS) {
    (body[key] as readonly { id: string }[]).forEach((e, i) => {
      if (kinds.has(e.id)) out.push(diag("FACTS_DUPLICATE_ID", `$.body.${key}[${i}]`, e.id));
      else kinds.set(e.id, ENTITY_OF[key]);
    });
  }

  const ref = (id: string, expected: EntityType, path: string) => {
    const k = kinds.get(id);
    if (k === undefined) out.push(diag(expected === "party" ? "FACTS_UNKNOWN_PARTY" : "FACTS_UNKNOWN_ENTITY", path, id));
    else if (k !== expected) out.push(diag("FACTS_EDGE_KIND", path, `${id} is ${k}, expected ${expected}`));
  };
  const enumCheck = (name: EnumName, v: unknown, path: string) => {
    if (!isEnumValue(name, v)) out.push(diag("CORE_ENUM_UNKNOWN", path, `${name}: ${String(v)}`));
  };
  const record = (r: { recorded_at: unknown; superseded_at?: unknown; status: unknown; valid: unknown }, p: string) => {
    enumCheck("claim_status", r.status, `${p}.status`);
    out.push(...checkInterval(r.valid, `${p}.valid`));
    if (!isInstant(r.recorded_at)) out.push(diag("CORE_TYPE_ERROR", `${p}.recorded_at`, String(r.recorded_at)));
    else if (r.superseded_at !== undefined && (!isInstant(r.superseded_at) || r.superseded_at <= r.recorded_at)) {
      out.push(diag("CORE_TYPE_ERROR", `${p}.superseded_at`, "must be an instant after recorded_at"));
    }
  };

  body.parties.forEach((x, i) => enumCheck("party_kind", x.kind, `$.body.parties[${i}].kind`));
  body.voices.forEach((x, i) => enumCheck("voice_kind", x.kind, `$.body.voices[${i}].kind`));
  body.recordings.forEach((x, i) => ref(x.of, "work", `$.body.recordings[${i}].of`));
  body.stems.forEach((x, i) => {
    ref(x.of, "recording", `$.body.stems[${i}].of`);
    if (typeof x.rights_bearing !== "boolean") out.push(diag("CORE_TYPE_ERROR", `$.body.stems[${i}].rights_bearing`));
  });

  body.claims.forEach((c, i) => {
    const p = `$.body.claims[${i}]`;
    const kindsFor = Object.hasOwn(CLAIM_EDGE_KINDS, c.edge) ? CLAIM_EDGE_KINDS[c.edge] : undefined;
    if (kindsFor === undefined) {
      out.push(diag("CORE_ENUM_UNKNOWN", `${p}.edge`, String(c.edge)));
    } else {
      ref(c.source, kindsFor[0], `${p}.source`);
      ref(c.target, kindsFor[1], `${p}.target`);
    }
    out.push(...capture(() => parseBps(c.share, `${p}.share`)));
    record(c, p);
    if (c.edge === "PERFORMED_BY") enumCheck("performer_role", c.performer_role, `${p}.performer_role`);
    else if (c.performer_role !== undefined) out.push(diag("CORE_TYPE_ERROR", `${p}.performer_role`, "only allowed on PERFORMED_BY"));
  });

  body.mandates.forEach((m, i) => {
    const p = `$.body.mandates[${i}]`;
    ref(m.from, "party", `${p}.from`);
    ref(m.to, "party", `${p}.to`);
    enumCheck("mandate_right", m.right, `${p}.right`);
    out.push(...capture(() => parseBps(m.share, `${p}.share`)));
    record(m, p);
  });

  return out;
}
```

`spec/schema/facts.ir.schema.json` (share는 원문 bps 또는 공개본의 커밋먼트를 모두 허용한다. 계산 입력은 원문만 허용하며 이는 `validateFactsStructure`가 강제한다):
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mdrl.invalid/1.0/facts.ir.schema.json",
  "title": "MDRL facts IR document",
  "type": "object",
  "allOf": [{ "$ref": "envelope.schema.json" }],
  "properties": {
    "module": { "const": "facts" },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": ["parties", "works", "recordings", "voices", "stems", "claims", "mandates"],
      "properties": {
        "parties": { "type": "array", "items": { "$ref": "#/$defs/party" } },
        "works": { "type": "array", "items": { "$ref": "#/$defs/work" } },
        "recordings": { "type": "array", "items": { "$ref": "#/$defs/recording" } },
        "voices": { "type": "array", "items": { "$ref": "#/$defs/voice" } },
        "stems": { "type": "array", "items": { "$ref": "#/$defs/stem" } },
        "claims": { "type": "array", "items": { "$ref": "#/$defs/claim" } },
        "mandates": { "type": "array", "items": { "$ref": "#/$defs/mandate" } }
      }
    }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$" },
    "bps": { "type": "string", "pattern": "^(0|[1-9][0-9]{0,3}|10000)$" },
    "commitment": {
      "type": "object", "additionalProperties": false, "required": ["commit"],
      "properties": { "commit": { "type": "string", "pattern": "^mdrl:sha256:[0-9a-f]{64}$" } }
    },
    "bpsOrCommit": { "oneOf": [{ "$ref": "#/$defs/bps" }, { "$ref": "#/$defs/commitment" }] },
    "instant": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" },
    "interval": {
      "type": "object", "additionalProperties": false, "required": ["from"],
      "properties": { "from": { "$ref": "#/$defs/instant" }, "to": { "$ref": "#/$defs/instant" } }
    },
    "ids": { "type": "object", "additionalProperties": { "type": "string" } },
    "visibility": { "enum": ["PUBLIC", "PARTIES", "PRIVATE"] },
    "status": { "enum": ["ASSERTED", "VERIFIED", "DISPUTED", "SUPERSEDED"] },
    "party": {
      "type": "object", "additionalProperties": false, "required": ["id", "kind"],
      "properties": {
        "id": { "$ref": "#/$defs/id" },
        "kind": { "enum": ["LABEL", "PERFORMER", "AUTHOR", "PUBLISHER", "CMO", "AGENCY", "AI_PROVIDER", "SESSION"] },
        "ids": { "$ref": "#/$defs/ids" },
        "visibility": { "$ref": "#/$defs/visibility" }
      }
    },
    "work": {
      "type": "object", "additionalProperties": false, "required": ["id"],
      "properties": { "id": { "$ref": "#/$defs/id" }, "ids": { "$ref": "#/$defs/ids" } }
    },
    "recording": {
      "type": "object", "additionalProperties": false, "required": ["id", "of"],
      "properties": { "id": { "$ref": "#/$defs/id" }, "of": { "$ref": "#/$defs/id" }, "ids": { "$ref": "#/$defs/ids" } }
    },
    "voice": {
      "type": "object", "additionalProperties": false, "required": ["id", "kind"],
      "properties": { "id": { "$ref": "#/$defs/id" }, "kind": { "enum": ["HUMAN", "AI"] } }
    },
    "stem": {
      "type": "object", "additionalProperties": false, "required": ["id", "of", "slot", "rights_bearing"],
      "properties": {
        "id": { "$ref": "#/$defs/id" }, "of": { "$ref": "#/$defs/id" },
        "slot": { "type": "string" }, "rights_bearing": { "type": "boolean" }
      }
    },
    "claim": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "source", "edge", "target", "share", "status", "valid", "recorded_at"],
      "properties": {
        "id": { "$ref": "#/$defs/id" },
        "source": { "$ref": "#/$defs/id" },
        "edge": { "enum": ["PERFORMED_BY", "OWNED_BY", "CONTROLLED_BY", "WRITTEN_BY", "CONTRIBUTED_BY"] },
        "target": { "$ref": "#/$defs/id" },
        "share": { "$ref": "#/$defs/bpsOrCommit" },
        "performer_role": { "enum": ["FEATURED", "NON_FEATURED"] },
        "role_detail": { "type": "string" },
        "status": { "$ref": "#/$defs/status" },
        "valid": { "$ref": "#/$defs/interval" },
        "recorded_at": { "$ref": "#/$defs/instant" },
        "superseded_at": { "$ref": "#/$defs/instant" },
        "evidence": { "oneOf": [{ "type": "string" }, { "$ref": "#/$defs/commitment" }] },
        "visibility": { "$ref": "#/$defs/visibility" }
      }
    },
    "mandate": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "from", "to", "right", "share", "status", "valid", "recorded_at"],
      "properties": {
        "id": { "$ref": "#/$defs/id" },
        "from": { "$ref": "#/$defs/id" },
        "to": { "$ref": "#/$defs/id" },
        "right": { "enum": ["MASTER", "WORK", "PERFORMER"] },
        "share": { "$ref": "#/$defs/bpsOrCommit" },
        "status": { "$ref": "#/$defs/status" },
        "valid": { "$ref": "#/$defs/interval" },
        "recorded_at": { "$ref": "#/$defs/instant" },
        "superseded_at": { "$ref": "#/$defs/instant" },
        "visibility": { "$ref": "#/$defs/visibility" }
      }
    }
  }
}
```

- [ ] **Step 6: 통과 확인**

Run: `node --test test/facts/structure.test.ts && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 7: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/facts/types.ts 04_구현_소스코드/mdrl/src/facts/validate.ts 04_구현_소스코드/mdrl/spec/schema/facts.ir.schema.json 04_구현_소스코드/mdrl/conformance/facts/001-basic/input.json 04_구현_소스코드/mdrl/test/helpers.ts 04_구현_소스코드/mdrl/test/facts/structure.test.ts && git commit -m "feat(mdrl): facts IR 타입·스키마·구조 검증"
```

---

### Task 7: 이중 시간축 · share 합 불변식 · 위임 깊이/순환

**Files:**
- Create: `src/facts/temporal.ts`, `src/facts/invariants.ts`
- Modify: `src/facts/validate.ts` (`validateFacts` 추가)
- Test: `test/facts/invariants.test.ts`

**Interfaces:**
- Consumes: `Claim`, `Mandate`, `FactsBody`, `ClaimEdge`, `MAX_MANDATE_HOPS` (T6), `contains`, `Instant`, `Interval` (T4), `BPS_TOTAL` (T2), `diag` (T1)
- Produces:
  - `temporal.ts`: `isVisible(r, knownAt)`, `isEffective(r, asOf, knownAt)`, `isCurrent(r)`, `boundaries(rs): Instant[]`, `groupKey(source, edge, performerRole?)`, `claimGroupKey(c)`, `type ClaimGroup = { key: string; claims: Claim[]; disputed: boolean; sumBps: number }`, `groupClaims(claims): Map<string, ClaimGroup>`
  - `invariants.ts`: `checkClaimSums(body): Diagnostic[]`, `checkMandates(body): Diagnostic[]`
  - `validate.ts`: `validateFacts(doc: unknown): Diagnostic[]`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/facts/invariants.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFacts } from "../../src/facts/validate.ts";
import { groupClaims, isEffective } from "../../src/facts/temporal.ts";
import type { Mandate } from "../../src/facts/types.ts";
import { claimOf, loadBasic, mandateOf } from "../helpers.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const codes = (doc: unknown) => validateFacts(doc).map((d) => d.code).sort();
const mandate = (id: string, from: string, to: string, right: Mandate["right"] = "WORK"): Mandate => ({
  id, from, to, right, share: "10000", status: "VERIFIED", valid: { from: T0 }, recorded_at: T0,
});

test("basic fixture passes all invariants", () => {
  assert.deepEqual(validateFacts(loadBasic().facts), []);
});

test("isEffective applies validity, knowledge time and status", () => {
  const c = claimOf(loadBasic(), "c5");
  assert.equal(isEffective(c, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), true);
  assert.equal(isEffective(c, "2025-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), false);
  assert.equal(isEffective(c, "2026-06-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z"), false);
  assert.equal(isEffective({ ...c, superseded_at: "2026-03-01T00:00:00.000Z" }, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), false);
  assert.equal(isEffective({ ...c, status: "ASSERTED" }, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), false);
  assert.equal(isEffective({ ...c, status: "DISPUTED" }, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), true);
});

test("groups key PERFORMED_BY by performer_role only", () => {
  const i = loadBasic();
  const g = groupClaims(i.facts.body.claims);
  assert.equal(g.get("wrk_01|WRITTEN_BY")?.sumBps, 10000);
  assert.equal(g.get("stm_v1|PERFORMED_BY|FEATURED")?.claims.length, 1);
});

test("sum mismatch", () => {
  const i = loadBasic();
  claimOf(i, "c7").share = "3000";
  assert.deepEqual(codes(i.facts), ["FACTS_SUM_MISMATCH"]);
});

test("sum mismatch inside a validity gap is detected at the boundary", () => {
  const i = loadBasic();
  claimOf(i, "c7").valid = { from: T0, to: "2026-06-01T00:00:00.000Z" };
  i.facts.body.claims.push({
    ...claimOf(i, "c7"), id: "c8", valid: { from: "2026-07-01T00:00:00.000Z" },
  });
  assert.deepEqual(codes(i.facts), ["FACTS_SUM_MISMATCH"]);
});

test("ASSERTED and superseded claims are ignored by sum check", () => {
  const i = loadBasic();
  i.facts.body.claims.push({ ...claimOf(i, "c7"), id: "c9", status: "ASSERTED" });
  i.facts.body.claims.push({ ...claimOf(i, "c7"), id: "c10", superseded_at: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(codes(i.facts), []);
});

test("mandate share over 10000bps", () => {
  const i = loadBasic();
  i.facts.body.mandates.push({ ...mandateOf(i, "m1"), id: "m9", to: "pty_agency_s", share: "1" });
  assert.deepEqual(codes(i.facts), ["FACTS_SUM_MISMATCH"]);
});

test("mandate cycle", () => {
  const i = loadBasic();
  i.facts.body.mandates.push(mandate("m3", "pty_komca", "pty_author_b"));
  assert.ok(codes(i.facts).includes("FACTS_CYCLE"));
});

test("two hops allowed, three rejected", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_pub", kind: "PUBLISHER" });
  mandateOf(i, "m1").to = "pty_pub";
  i.facts.body.mandates.push(mandate("m3", "pty_pub", "pty_komca"));
  assert.deepEqual(codes(i.facts), []);
  i.facts.body.mandates.push(mandate("m4", "pty_komca", "pty_agency_s"));
  assert.deepEqual(codes(i.facts), ["FACTS_MANDATE_DEPTH"]);
});

test("structural errors short-circuit invariants", () => {
  const i = loadBasic();
  claimOf(i, "c5").target = "pty_ghost";
  assert.deepEqual(codes(i.facts), ["FACTS_UNKNOWN_PARTY"]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/facts/invariants.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/facts/temporal.ts`) 또는 `validateFacts` 미정의.

- [ ] **Step 3: 구현**

`src/facts/temporal.ts`:
```ts
import { contains, type Instant, type Interval } from "../core/time.ts";
import type { Claim, ClaimEdge } from "./types.ts";

type TimedRecord = {
  recorded_at: Instant;
  superseded_at?: Instant;
  status: Claim["status"];
  valid: Interval;
};

/** 기록 시간축: known_at 시점에 원장에 보였던 레코드인가. */
export function isVisible(r: TimedRecord, knownAt: Instant): boolean {
  return r.recorded_at <= knownAt && (r.superseded_at === undefined || knownAt < r.superseded_at);
}

/** 계산 대상: 두 시간축을 모두 만족하고 VERIFIED 또는 DISPUTED인 레코드. */
export function isEffective(r: TimedRecord, asOf: Instant, knownAt: Instant): boolean {
  return isVisible(r, knownAt) && contains(r.valid, asOf) && (r.status === "VERIFIED" || r.status === "DISPUTED");
}

/** 정적 검증 대상: 현재 지식(미대체) 기준으로 VERIFIED 또는 DISPUTED인 레코드. */
export function isCurrent(r: TimedRecord): boolean {
  return r.superseded_at === undefined && (r.status === "VERIFIED" || r.status === "DISPUTED");
}

/** 유효 집합이 바뀔 수 있는 모든 시점. 각 시점에서 검사하면 전 기간을 덮는다. */
export function boundaries(rs: readonly { valid: Interval }[]): Instant[] {
  const s = new Set<Instant>();
  for (const r of rs) {
    s.add(r.valid.from);
    if (r.valid.to !== undefined) s.add(r.valid.to);
  }
  return [...s].sort();
}

export function groupKey(source: string, edge: ClaimEdge, performerRole?: string): string {
  return edge === "PERFORMED_BY" ? `${source}|${edge}|${performerRole ?? ""}` : `${source}|${edge}`;
}

export function claimGroupKey(c: Claim): string {
  return groupKey(c.source, c.edge, c.performer_role);
}

export type ClaimGroup = { key: string; claims: Claim[]; disputed: boolean; sumBps: number };

export function groupClaims(claims: readonly Claim[]): Map<string, ClaimGroup> {
  const out = new Map<string, ClaimGroup>();
  for (const c of claims) {
    const key = claimGroupKey(c);
    const g = out.get(key) ?? { key, claims: [], disputed: false, sumBps: 0 };
    g.claims.push(c);
    g.disputed ||= c.status === "DISPUTED";
    g.sumBps += Number(c.share);
    out.set(key, g);
  }
  return out;
}
```

`src/facts/invariants.ts`:
```ts
import { BPS_TOTAL } from "../core/bps.ts";
import { diag, type Diagnostic } from "../core/errors.ts";
import { contains } from "../core/time.ts";
import { boundaries, groupClaims, isCurrent } from "./temporal.ts";
import { MAX_MANDATE_HOPS, type FactsBody } from "./types.ts";

export function checkClaimSums(body: FactsBody): Diagnostic[] {
  const current = body.claims.filter(isCurrent);
  const reported = new Set<string>();
  const out: Diagnostic[] = [];
  for (const t of boundaries(current)) {
    for (const g of groupClaims(current.filter((c) => contains(c.valid, t))).values()) {
      if (g.sumBps !== BPS_TOTAL && !reported.has(g.key)) {
        reported.add(g.key);
        out.push(diag("FACTS_SUM_MISMATCH", `$.body.claims[${g.key}]`, `${g.sumBps}bps at ${t}`));
      }
    }
  }
  return out;
}

export function checkMandates(body: FactsBody): Diagnostic[] {
  const current = body.mandates.filter(isCurrent);
  const out: Diagnostic[] = [];
  const reported = new Set<string>();
  const report = (key: string, d: Diagnostic) => {
    if (!reported.has(key)) {
      reported.add(key);
      out.push(d);
    }
  };
  for (const t of boundaries(current)) {
    const active = current.filter((m) => contains(m.valid, t));
    const sums = new Map<string, number>();
    const next = new Map<string, string[]>();
    for (const m of active) {
      const sk = `${m.from}|${m.right}`;
      sums.set(sk, (sums.get(sk) ?? 0) + Number(m.share));
      const nk = `${m.right}|${m.from}`;
      next.set(nk, [...(next.get(nk) ?? []), m.to]);
    }
    for (const [k, s] of sums) {
      if (s > BPS_TOTAL) report(`sum|${k}`, diag("FACTS_SUM_MISMATCH", `$.body.mandates[${k}]`, `${s}bps > ${BPS_TOTAL} at ${t}`));
    }
    for (const m of active) {
      const walk = (party: string, hops: number, chain: string[]): void => {
        for (const to of next.get(`${m.right}|${party}`) ?? []) {
          const path = [...chain, to].join(" -> ");
          if (chain.includes(to)) {
            report(`cycle|${m.right}|${m.from}`, diag("FACTS_CYCLE", `$.body.mandates[${m.id}]`, path));
          } else if (hops + 1 > MAX_MANDATE_HOPS) {
            report(`depth|${m.right}|${m.from}`, diag("FACTS_MANDATE_DEPTH", `$.body.mandates[${m.id}]`, path));
          } else {
            walk(to, hops + 1, [...chain, to]);
          }
        }
      };
      walk(m.from, 0, [m.from]);
    }
  }
  return out;
}
```

`src/facts/validate.ts` 끝에 추가 (파일 상단 import에 `import { checkClaimSums, checkMandates } from "./invariants.ts";` 추가):
```ts
/** 구조 검증 → (통과 시) share 합 불변식 → 위임 합·순환·깊이. */
export function validateFacts(doc: unknown): Diagnostic[] {
  const structural = validateFactsStructure(doc);
  if (structural.length > 0) return structural;
  const body = (doc as FactsDocument).body;
  return [...checkClaimSums(body), ...checkMandates(body)];
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/facts/invariants.test.ts test/facts/structure.test.ts && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/facts/temporal.ts 04_구현_소스코드/mdrl/src/facts/invariants.ts 04_구현_소스코드/mdrl/src/facts/validate.ts 04_구현_소스코드/mdrl/test/facts/invariants.test.ts && git commit -m "feat(mdrl): 이중 시간축, share 합 불변식, 위임 순환·깊이 검증"
```

---

### Task 8: 조합 지분 계산 — 역할별 기여 벡터

**Files:**
- Create: `src/facts/project.ts`
- Test: `test/facts/project.test.ts`

**Interfaces:**
- Consumes: `validateFactsStructure` (T6), `groupClaims`, `groupKey`, `isEffective`, `ClaimGroup` (T7), `Ratio`, `ratio`, `add`, `mul`, `div`, `fromBps`, `ONE`, `ZERO` (T2), `parseBps`, `BPS_TOTAL` (T2), `diag`, `ok`, `err`, `Result` (T1)
- Produces: `HOLD = "@hold"`, `type PartyVector = Record<string, Ratio>`, `type Usage = Readonly<Record<string, string>>`, `type PathRow = { stem: string; role: ClaimantRole; party: string; weight: Ratio; claims: string[] }`, `type Projection = { vectors: Partial<Record<ClaimantRole, PartyVector>>; paths: PathRow[] }`, `projectVectors(doc: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant): Result<Projection>`

**정의 (스펙 4.4 구체화):**
- 사용량 `usage[stem]`는 `ASSIGNED_LAYER_MS` 정수 문자열. `rights_bearing=true` 스템만 허용, 0은 무시.
- 스템별 경로 행: MASTER_OWNER(`recording CONTROLLED_BY`, 필수), WORK_AUTHOR(`work WRITTEN_BY`, 필수), RECORDING_CONTRIBUTOR(`recording CONTRIBUTED_BY`, 선택), 실연(`stem PERFORMED_BY[performer_role]` → `voice OWNED_BY`; voice.kind=AI면 역할 AI_PROVIDER, 아니면 PERFORMER_FEATURED/NON_FEATURED).
- 행 가중치 = 경로상 share 곱. DISPUTED 그룹은 그 몫 전체를 `@hold` 행으로 보낸다(재정규화 없음).
- 역할 벡터: `w_role[p] = Σ_s ms[s]·weight(s,p) / Σ_s ms[s]·Σ_q weight(s,q)`. 분모는 그 역할 경로가 있는 스템만 포함하므로 모든 벡터 합은 정확히 1이다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/facts/project.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLD, projectVectors } from "../../src/facts/project.ts";
import { ONE, ratio, sum } from "../../src/core/ratio.ts";
import { claimOf, loadBasic, type BasicInput } from "../helpers.ts";

const run = (i: BasicInput) => projectVectors(i.facts, i.usage, i.as_of, i.known_at);
const errCodes = (i: BasicInput) => {
  const r = run(i);
  return r.ok ? [] : r.errors.map((e) => e.code).sort();
};

test("basic projection vectors", () => {
  const r = run(loadBasic());
  assert.ok(r.ok);
  const v = r.value.vectors;
  assert.deepEqual(v.MASTER_OWNER, { pty_label_x: ONE });
  assert.deepEqual(v.WORK_AUTHOR, { pty_author_b: ratio(3n, 5n), pty_author_c: ratio(2n, 5n) });
  assert.deepEqual(v.PERFORMER_FEATURED, { pty_member_a: ratio(2n, 3n), pty_member_b: ratio(1n, 3n) });
  assert.equal(v.PERFORMER_NON_FEATURED, undefined);
  assert.equal(r.value.paths.length, 11);
});

test("every vector sums to exactly 1", () => {
  const r = run(loadBasic());
  assert.ok(r.ok);
  for (const vec of Object.values(r.value.vectors)) assert.deepEqual(sum(Object.values(vec!)), ONE);
});

test("disputed group goes to @hold without renormalization", () => {
  const i = loadBasic();
  claimOf(i, "c5").status = "DISPUTED";
  const r = run(i);
  assert.ok(r.ok);
  assert.deepEqual(r.value.vectors.MASTER_OWNER, { [HOLD]: ONE });
});

test("AI voice contributes to AI_PROVIDER; duet splits the stem", () => {
  const i = loadBasic();
  const b = i.facts.body;
  b.parties.push({ id: "pty_ai", kind: "AI_PROVIDER" });
  b.voices.push({ id: "vo_ai", kind: "AI" });
  claimOf(i, "c1").share = "5000";
  b.claims.push({ ...claimOf(i, "c1"), id: "c1b", target: "vo_ai" });
  b.claims.push({ ...claimOf(i, "c3"), id: "c_ai", source: "vo_ai", target: "pty_ai" });
  const r = run(i);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value.vectors.PERFORMER_FEATURED, { pty_member_a: ratio(1n, 2n), pty_member_b: ratio(1n, 2n) });
  assert.deepEqual(r.value.vectors.AI_PROVIDER, { pty_ai: ONE });
});

test("missing required path", () => {
  const i = loadBasic();
  i.facts.body.claims = i.facts.body.claims.filter((c) => c.id !== "c5");
  assert.deepEqual(errCodes(i), ["FACTS_PATH_MISSING", "FACTS_PATH_MISSING", "FACTS_PATH_MISSING"]);
});

test("as_of before validity breaks paths", () => {
  const i = loadBasic();
  i.as_of = "2025-12-01T00:00:00.000Z";
  assert.ok(errCodes(i).includes("FACTS_PATH_MISSING"));
});

test("known_at before recording breaks paths", () => {
  const i = loadBasic();
  claimOf(i, "c5").recorded_at = "2026-03-01T00:00:00.000Z";
  i.known_at = "2026-02-01T00:00:00.000Z";
  assert.ok(errCodes(i).includes("FACTS_PATH_MISSING"));
});

test("usage validation", () => {
  for (const usage of [{ stm_ghost: "1" }, { stm_v1: "1.5" }, { stm_v1: "0" }]) {
    const i = loadBasic();
    i.usage = usage;
    assert.deepEqual(errCodes(i), ["FACTS_USAGE_INVALID"], JSON.stringify(usage));
  }
  const i = loadBasic();
  i.facts.body.stems[0]!.rights_bearing = false;
  assert.deepEqual(errCodes(i), ["FACTS_USAGE_INVALID"]);
});

test("effective-time sum mismatch surfaces at projection", () => {
  const i = loadBasic();
  claimOf(i, "c7").share = "3000";
  assert.deepEqual(errCodes(i), ["FACTS_SUM_MISMATCH"]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/facts/project.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/facts/project.ts`).

- [ ] **Step 3: 구현**

`src/facts/project.ts`:
```ts
import { BPS_TOTAL, parseBps } from "../core/bps.ts";
import { diag, err, ok, type Diagnostic, type Result } from "../core/errors.ts";
import { ONE, ZERO, add, div, fromBps, mul, ratio, type Ratio } from "../core/ratio.ts";
import type { Instant } from "../core/time.ts";
import { groupClaims, groupKey, isEffective, type ClaimGroup } from "./temporal.ts";
import type { Claim, ClaimantRole, FactsDocument } from "./types.ts";
import { validateFactsStructure } from "./validate.ts";

export const HOLD = "@hold";
export type PartyVector = Record<string, Ratio>;
export type Usage = Readonly<Record<string, string>>;
export type PathRow = { stem: string; role: ClaimantRole; party: string; weight: Ratio; claims: string[] };
export type Projection = { vectors: Partial<Record<ClaimantRole, PartyVector>>; paths: PathRow[] };

const MS_RE = /^(0|[1-9]\d*)$/;
const PERFORMER_ROLE = { FEATURED: "PERFORMER_FEATURED", NON_FEATURED: "PERFORMER_NON_FEATURED" } as const;
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function projectVectors(doc: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant): Result<Projection> {
  const structural = validateFactsStructure(doc);
  if (structural.length > 0) return err(structural);
  const b = doc.body;
  const stems = new Map(b.stems.map((s) => [s.id, s]));
  const recordings = new Map(b.recordings.map((r) => [r.id, r]));
  const voices = new Map(b.voices.map((v) => [v.id, v]));
  const errors: Diagnostic[] = [];

  const ms = new Map<string, bigint>();
  for (const [stemId, raw] of Object.entries(usage)) {
    const stem = stems.get(stemId);
    if (!stem || !stem.rights_bearing || typeof raw !== "string" || !MS_RE.test(raw)) {
      errors.push(diag("FACTS_USAGE_INVALID", `$.usage.${stemId}`, String(raw)));
    } else if (raw !== "0") {
      ms.set(stemId, BigInt(raw));
    }
  }
  if (errors.length === 0 && ms.size === 0) errors.push(diag("FACTS_USAGE_INVALID", "$.usage", "no stem with positive usage"));
  if (errors.length > 0) return err(errors);

  const groups = groupClaims(b.claims.filter((c) => isEffective(c, asOf, knownAt)));
  for (const g of groups.values()) {
    if (!g.disputed && g.sumBps !== BPS_TOTAL) {
      errors.push(diag("FACTS_SUM_MISMATCH", `$.body.claims[${g.key}]`, `${g.sumBps}bps at ${asOf}`));
    }
  }
  if (errors.length > 0) return err(errors);

  const group = (source: string, edge: Claim["edge"], performerRole?: string): ClaimGroup | undefined =>
    groups.get(groupKey(source, edge, performerRole));
  const share = (c: Claim): Ratio => fromBps(parseBps(c.share));
  const rows: PathRow[] = [];

  const direct = (stem: string, role: ClaimantRole, g: ClaimGroup | undefined, required: boolean, path: string) => {
    if (!g) {
      if (required) errors.push(diag("FACTS_PATH_MISSING", path));
      return;
    }
    if (g.disputed) {
      rows.push({ stem, role, party: HOLD, weight: ONE, claims: g.claims.map((c) => c.id) });
      return;
    }
    for (const c of g.claims) rows.push({ stem, role, party: c.target, weight: share(c), claims: [c.id] });
  };

  for (const stemId of ms.keys()) {
    const stem = stems.get(stemId)!;
    const rec = recordings.get(stem.of)!;
    const p = `$.stems.${stemId}`;
    direct(stemId, "MASTER_OWNER", group(rec.id, "CONTROLLED_BY"), true, `${p}->${rec.id}.CONTROLLED_BY`);
    direct(stemId, "WORK_AUTHOR", group(rec.of, "WRITTEN_BY"), true, `${p}->${rec.of}.WRITTEN_BY`);
    direct(stemId, "RECORDING_CONTRIBUTOR", group(rec.id, "CONTRIBUTED_BY"), false, `${p}->${rec.id}.CONTRIBUTED_BY`);

    for (const pr of ["FEATURED", "NON_FEATURED"] as const) {
      const g = group(stemId, "PERFORMED_BY", pr);
      if (!g) continue;
      const total = BigInt(g.sumBps);
      for (const c of g.claims) {
        const voice = voices.get(c.target)!;
        const role: ClaimantRole = voice.kind === "AI" ? "AI_PROVIDER" : PERFORMER_ROLE[pr];
        if (g.disputed) {
          const w = total === 0n ? ratio(1n, BigInt(g.claims.length)) : ratio(BigInt(parseBps(c.share)), total);
          rows.push({ stem: stemId, role, party: HOLD, weight: w, claims: [c.id] });
          continue;
        }
        const w1 = share(c);
        const og = group(voice.id, "OWNED_BY");
        if (!og) {
          errors.push(diag("FACTS_PATH_MISSING", `${p}->${voice.id}.OWNED_BY`));
          continue;
        }
        if (og.disputed) {
          rows.push({ stem: stemId, role, party: HOLD, weight: w1, claims: [c.id, ...og.claims.map((x) => x.id)] });
          continue;
        }
        for (const oc of og.claims) {
          rows.push({ stem: stemId, role, party: oc.target, weight: mul(w1, share(oc)), claims: [c.id, oc.id] });
        }
      }
    }
  }
  if (errors.length > 0) return err(errors);

  const num = new Map<ClaimantRole, Map<string, Ratio>>();
  const den = new Map<ClaimantRole, Ratio>();
  for (const r of rows) {
    const contrib = mul(ratio(ms.get(r.stem)!), r.weight);
    const m = num.get(r.role) ?? new Map<string, Ratio>();
    m.set(r.party, add(m.get(r.party) ?? ZERO, contrib));
    num.set(r.role, m);
    den.set(r.role, add(den.get(r.role) ?? ZERO, contrib));
  }
  const vectors: Partial<Record<ClaimantRole, PartyVector>> = {};
  for (const [role, m] of num) {
    const d = den.get(role)!;
    if (d.n === 0n) continue;
    const v: PartyVector = {};
    for (const party of [...m.keys()].sort(byKey)) v[party] = div(m.get(party)!, d);
    vectors[role] = v;
  }
  return ok({ vectors, paths: rows });
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/facts/project.test.ts && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/facts/project.ts 04_구현_소스코드/mdrl/test/facts/project.test.ts && git commit -m "feat(mdrl): 권리 그래프 투영과 역할별 기여 벡터"
```

---

### Task 9: 위임 라우팅 · 청구권자 도출 · 커버리지

**Files:**
- Create: `src/facts/mandate.ts`
- Test: `test/facts/mandate.test.ts`

**Interfaces:**
- Consumes: `HOLD`, `PartyVector`, `Projection`, `projectVectors` (T8), `isEffective` (T7), `MAX_MANDATE_HOPS`, `Mandate`, `FactsDocument`, `ClaimantRole` (T6), `Ratio` ops (T2), `diag`, `ok`, `err`, `Result`, `Diagnostic` (T1)
- Produces: `ROLE_RIGHT: Partial<Record<ClaimantRole, EnumValue<"mandate_right">>>`, `routeVector(doc, vec, right, asOf, knownAt): Result<PartyVector>`, `type ClaimantEntry = { role: ClaimantRole; party: string }`, `deriveClaimants(doc, projection, asOf, knownAt): Result<ClaimantEntry[]>`, `checkClaimantCoverage(derived, declared): Diagnostic[]`

**정의:** 위임 `m(from→to, right, share)`는 `from`이 받을 몫의 `share/10000`을 `to`가 수령하게 한다. 나머지는 `from`에 남는다. 최대 2홉까지 따라가며 3홉째가 있으면 `FACTS_MANDATE_DEPTH`. DISPUTED 위임의 몫은 `@hold`. 합계는 보존된다. CMO·AGENCY 청구권자는 라우팅 결과에 나타난 party 중 kind가 CMO·AGENCY인 party다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/facts/mandate.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaimantCoverage, deriveClaimants, routeVector } from "../../src/facts/mandate.ts";
import { HOLD, projectVectors } from "../../src/facts/project.ts";
import { ratio } from "../../src/core/ratio.ts";
import { loadBasic, mandateOf, type BasicInput } from "../helpers.ts";

const T0 = "2026-01-01T00:00:00.000Z";

function vectors(i: BasicInput) {
  const r = projectVectors(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(r.ok);
  return r.value;
}

test("full mandate routes WORK author share to CMO", () => {
  const i = loadBasic();
  const r = routeVector(i.facts, vectors(i).vectors.WORK_AUTHOR!, "WORK", i.as_of, i.known_at);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { pty_author_c: ratio(2n, 5n), pty_komca: ratio(3n, 5n) });
});

test("partial mandate keeps the remainder with the principal", () => {
  const i = loadBasic();
  mandateOf(i, "m2").share = "2000";
  const r = routeVector(i.facts, vectors(i).vectors.PERFORMER_FEATURED!, "PERFORMER", i.as_of, i.known_at);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    pty_agency_s: ratio(2n, 15n),
    pty_member_a: ratio(8n, 15n),
    pty_member_b: ratio(1n, 3n),
  });
});

test("two hops route through, a third hop is rejected", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_pub", kind: "PUBLISHER" });
  mandateOf(i, "m1").to = "pty_pub";
  const hop = { right: "WORK" as const, share: "10000", status: "VERIFIED" as const, valid: { from: T0 }, recorded_at: T0 };
  i.facts.body.mandates.push({ id: "m3", from: "pty_pub", to: "pty_komca", ...hop });
  const vec = vectors(i).vectors.WORK_AUTHOR!;
  const two = routeVector(i.facts, vec, "WORK", i.as_of, i.known_at);
  assert.ok(two.ok);
  assert.deepEqual(two.value, { pty_author_c: ratio(2n, 5n), pty_komca: ratio(3n, 5n) });

  i.facts.body.mandates.push({ id: "m4", from: "pty_komca", to: "pty_agency_s", ...hop });
  const three = routeVector(i.facts, vec, "WORK", i.as_of, i.known_at);
  assert.equal(three.ok, false);
  assert.deepEqual(three.ok ? [] : three.errors.map((e) => e.code), ["FACTS_MANDATE_DEPTH"]);
});

test("disputed mandate portion is held", () => {
  const i = loadBasic();
  mandateOf(i, "m1").status = "DISPUTED";
  const r = routeVector(i.facts, vectors(i).vectors.WORK_AUTHOR!, "WORK", i.as_of, i.known_at);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { [HOLD]: ratio(3n, 5n), pty_author_c: ratio(2n, 5n) });
});

test("derive claimants and check coverage", () => {
  const i = loadBasic();
  const derived = deriveClaimants(i.facts, vectors(i), i.as_of, i.known_at);
  assert.ok(derived.ok);
  assert.deepEqual(derived.value, i.declared_claimants);
  assert.deepEqual(checkClaimantCoverage(derived.value, i.declared_claimants), []);

  const missing = i.declared_claimants.filter((c) => c.role !== "CMO");
  assert.deepEqual(checkClaimantCoverage(derived.value, missing).map((d) => d.code), ["FACTS_CLAIMANT_DRIFT"]);

  const ghost = [...i.declared_claimants, { role: "AI_PROVIDER" as const, party: "pty_ghost" }];
  assert.deepEqual(checkClaimantCoverage(derived.value, ghost).map((d) => d.code), ["FACTS_UNCOVERED_CLAIMANT"]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/facts/mandate.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/facts/mandate.ts`).

- [ ] **Step 3: 구현**

`src/facts/mandate.ts`:
```ts
import { parseBps } from "../core/bps.ts";
import type { EnumValue } from "../core/enums.ts";
import { diag, err, ok, type Diagnostic, type Result } from "../core/errors.ts";
import { ZERO, add, fromBps, mul, sub, type Ratio } from "../core/ratio.ts";
import type { Instant } from "../core/time.ts";
import { HOLD, type PartyVector, type Projection } from "./project.ts";
import { isEffective } from "./temporal.ts";
import { MAX_MANDATE_HOPS, type ClaimantRole, type FactsDocument, type Mandate } from "./types.ts";

type MandateRight = EnumValue<"mandate_right">;

export const ROLE_RIGHT: Partial<Record<ClaimantRole, MandateRight>> = {
  MASTER_OWNER: "MASTER",
  WORK_AUTHOR: "WORK",
  PERFORMER_FEATURED: "PERFORMER",
  PERFORMER_NON_FEATURED: "PERFORMER",
};

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function routeVector(
  doc: FactsDocument, vec: PartyVector, right: MandateRight, asOf: Instant, knownAt: Instant,
): Result<PartyVector> {
  const byFrom = new Map<string, Mandate[]>();
  for (const m of doc.body.mandates) {
    if (m.right !== right || !isEffective(m, asOf, knownAt)) continue;
    byFrom.set(m.from, [...(byFrom.get(m.from) ?? []), m]);
  }
  const acc = new Map<string, Ratio>();
  const errors: Diagnostic[] = [];
  const put = (party: string, w: Ratio) => acc.set(party, add(acc.get(party) ?? ZERO, w));

  const route = (party: string, w: Ratio, hops: number, chain: string): void => {
    const ms = party === HOLD ? [] : (byFrom.get(party) ?? []);
    if (ms.length === 0) {
      put(party, w);
      return;
    }
    if (hops === MAX_MANDATE_HOPS) {
      errors.push(diag("FACTS_MANDATE_DEPTH", `$.route.${right}`, chain));
      return;
    }
    let routed = ZERO;
    for (const m of ms) {
      const s = fromBps(parseBps(m.share));
      routed = add(routed, s);
      const part = mul(w, s);
      if (m.status === "DISPUTED") put(HOLD, part);
      else route(m.to, part, hops + 1, `${chain} -> ${m.to}`);
    }
    put(party, sub(w, mul(w, routed)));
  };

  for (const [party, w] of Object.entries(vec)) route(party, w, 0, party);
  if (errors.length > 0) return err(errors);
  const out: PartyVector = {};
  for (const party of [...acc.keys()].sort(byKey)) {
    const w = acc.get(party)!;
    if (w.n !== 0n) out[party] = w;
  }
  return ok(out);
}

export type ClaimantEntry = { role: ClaimantRole; party: string };
const entryKey = (e: ClaimantEntry) => `${e.role}:${e.party}`;

export function deriveClaimants(
  doc: FactsDocument, projection: Projection, asOf: Instant, knownAt: Instant,
): Result<ClaimantEntry[]> {
  const kinds = new Map(doc.body.parties.map((p) => [p.id, p.kind]));
  const found = new Map<string, ClaimantEntry>();
  const put = (role: ClaimantRole, party: string) => found.set(entryKey({ role, party }), { role, party });
  const errors: Diagnostic[] = [];

  for (const [role, vec] of Object.entries(projection.vectors) as [ClaimantRole, PartyVector][]) {
    for (const party of Object.keys(vec)) if (party !== HOLD) put(role, party);
    const right = ROLE_RIGHT[role];
    if (right === undefined) continue;
    const routed = routeVector(doc, vec, right, asOf, knownAt);
    if (!routed.ok) {
      errors.push(...routed.errors);
      continue;
    }
    for (const party of Object.keys(routed.value)) {
      const kind = kinds.get(party);
      if (kind === "CMO" || kind === "AGENCY") put(kind, party);
    }
  }
  if (errors.length > 0) return err(errors);
  return ok([...found.values()].sort((a, b) => byKey(entryKey(a), entryKey(b))));
}

export function checkClaimantCoverage(derived: readonly ClaimantEntry[], declared: readonly ClaimantEntry[]): Diagnostic[] {
  const d = new Set(derived.map(entryKey));
  const s = new Set(declared.map(entryKey));
  const out: Diagnostic[] = [];
  for (const k of [...s].sort()) if (!d.has(k)) out.push(diag("FACTS_UNCOVERED_CLAIMANT", "$.claimants", k));
  for (const k of [...d].sort()) if (!s.has(k)) out.push(diag("FACTS_CLAIMANT_DRIFT", "$.claimants", k));
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npx tsc -p tsconfig.json`
Expected: 전체 PASS.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/facts/mandate.ts 04_구현_소스코드/mdrl/test/facts/mandate.test.ts && git commit -m "feat(mdrl): 위임 라우팅, 청구권자 도출과 커버리지 검증"
```

---

### Task 10: 결과 IR · 공개본 · 적합성 스위트 · 스펙 반영

**Files:**
- Create: `src/facts/result.ts`, `src/facts/public.ts`, `src/facts/index.ts`, `scripts/print-projection.ts`
- Create: `conformance/facts/001-basic/expected.json`, `conformance/facts/002-disputed-master/{input,expected}.json`, `conformance/facts/003-path-missing/{input,expected}.json`
- Modify: `02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md` (끝에 12절 추가)
- Test: `test/facts/result.test.ts`, `test/conformance.test.ts`

**Interfaces:**
- Consumes: `Projection`, `Usage`, `projectVectors` (T8), `digestOf` (T3), `formatRatio` (T2), `commitValue`, `Commitment` (T3), `FactsDocument` (T6)
- Produces: `type ProjectionIr = { facts_digest: string; as_of: string; known_at: string; u_digest: string; vectors: Record<string, Record<string, string>>; paths: { stem: string; role: string; party: string; weight: string; claims: string[] }[]; digest: string }`, `toProjectionIr(p, facts, usage, asOf, knownAt): ProjectionIr`, `type SaltFor = (path: string) => Uint8Array`, `publicFacts(doc, saltFor): { doc: unknown; digest: string }`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/facts/result.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectVectors } from "../../src/facts/project.ts";
import { toProjectionIr } from "../../src/facts/result.ts";
import { publicFacts } from "../../src/facts/public.ts";
import { digestOf } from "../../src/core/digest.ts";
import { openCommitment, type Commitment } from "../../src/core/commit.ts";
import { claimOf, loadBasic } from "../helpers.ts";

function build() {
  const i = loadBasic();
  const r = projectVectors(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(r.ok);
  return toProjectionIr(r.value, i.facts, i.usage, i.as_of, i.known_at);
}

test("projection IR is deterministic and self-digested", () => {
  const a = build();
  assert.equal(a.digest, build().digest);
  assert.equal(a.digest, digestOf({ ...a, digest: undefined }));
  assert.equal(a.facts_digest, digestOf(loadBasic().facts));
  assert.deepEqual(a.vectors.WORK_AUTHOR, { pty_author_b: "3/5", pty_author_c: "2/5" });
});

test("paths are sorted by stem, role, party", () => {
  const keys = build().paths.map((p) => `${p.stem}|${p.role}|${p.party}`);
  assert.deepEqual(keys, [...keys].sort());
});

test("publicFacts commits shares and evidence; PUBLIC claims stay open", () => {
  const i = loadBasic();
  claimOf(i, "c6").visibility = "PUBLIC";
  const salt = new Uint8Array(32).fill(7);
  const { doc, digest } = publicFacts(i.facts, () => salt);
  const claims = (doc as typeof i.facts).body.claims;
  const c5 = claims.find((c) => c.id === "c5")!;
  assert.equal(openCommitment(c5.share as unknown as Commitment, "10000", salt), true);
  assert.equal(openCommitment(c5.evidence as unknown as Commitment, claimOf(i, "c5").evidence, salt), true);
  assert.equal(claims.find((c) => c.id === "c6")!.share, "6000");
  assert.equal((doc as typeof i.facts).body.mandates[0]!.share.constructor, Object);
  assert.deepEqual((doc as typeof i.facts).body.parties, i.facts.body.parties);
  assert.notEqual(digest, digestOf(i.facts));
  assert.equal(digest, digestOf(doc));
});
```

`test/conformance.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { projectVectors } from "../src/facts/project.ts";
import { toProjectionIr } from "../src/facts/result.ts";

const root = new URL("../conformance/facts/", import.meta.url);

for (const name of readdirSync(root).sort()) {
  test(`conformance facts/${name}`, () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`${name}/${f}`, root), "utf8"));
    const input = read("input.json");
    const expected = read("expected.json");
    const r = projectVectors(input.facts, input.usage, input.as_of, input.known_at);
    if (expected.errors !== undefined) {
      assert.equal(r.ok, false);
      assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.code).sort(), expected.errors);
      return;
    }
    assert.ok(r.ok, JSON.stringify(r));
    const ir = toProjectionIr(r.value, input.facts, input.usage, input.as_of, input.known_at);
    assert.deepEqual(ir.vectors, expected.vectors);
    assert.deepEqual(ir.paths, expected.paths);
    assert.equal(ir.digest, expected.digest);
  });
}
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/facts/result.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/facts/result.ts`).

- [ ] **Step 3: 구현**

`src/facts/result.ts`:
```ts
import { digestOf } from "../core/digest.ts";
import { formatRatio } from "../core/ratio.ts";
import type { Instant } from "../core/time.ts";
import type { Projection, Usage } from "./project.ts";
import type { FactsDocument } from "./types.ts";

export type ProjectionIr = {
  facts_digest: string;
  as_of: Instant;
  known_at: Instant;
  u_digest: string;
  vectors: Record<string, Record<string, string>>;
  paths: { stem: string; role: string; party: string; weight: string; claims: string[] }[];
  digest: string;
};

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function toProjectionIr(p: Projection, facts: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant): ProjectionIr {
  const vectors: Record<string, Record<string, string>> = {};
  for (const role of Object.keys(p.vectors).sort(byKey)) {
    const vec = p.vectors[role as keyof typeof p.vectors]!;
    vectors[role] = Object.fromEntries(Object.keys(vec).sort(byKey).map((party) => [party, formatRatio(vec[party]!)]));
  }
  const paths = p.paths
    .map((r) => ({ stem: r.stem, role: r.role, party: r.party, weight: formatRatio(r.weight), claims: [...r.claims] }))
    .sort((a, b) =>
      byKey(a.stem, b.stem) || byKey(a.role, b.role) || byKey(a.party, b.party) || byKey(a.claims.join(","), b.claims.join(",")));
  const body = { facts_digest: digestOf(facts), as_of: asOf, known_at: knownAt, u_digest: digestOf(usage), vectors, paths };
  return { ...body, digest: digestOf(body) };
}
```

`src/facts/public.ts`:
```ts
import { commitValue } from "../core/commit.ts";
import { digestOf } from "../core/digest.ts";
import type { FactsDocument } from "./types.ts";

export type SaltFor = (path: string) => Uint8Array;

/**
 * 공개본: share·evidence는 visibility가 PUBLIC이 아니면(기본 PARTIES) 커밋먼트로 치환한다.
 * party·work·recording·voice·stem의 존재와 식별자는 공개한다(스펙 3.4).
 */
export function publicFacts(doc: FactsDocument, saltFor: SaltFor): { doc: unknown; digest: string } {
  const b = doc.body;
  const claims = b.claims.map((c) => {
    if ((c.visibility ?? "PARTIES") === "PUBLIC") return c;
    const base = `$.body.claims.${c.id}`;
    return {
      ...c,
      share: commitValue(c.share, saltFor(`${base}.share`)),
      ...(c.evidence === undefined ? {} : { evidence: commitValue(c.evidence, saltFor(`${base}.evidence`)) }),
    };
  });
  const mandates = b.mandates.map((m) =>
    (m.visibility ?? "PARTIES") === "PUBLIC" ? m : { ...m, share: commitValue(m.share, saltFor(`$.body.mandates.${m.id}.share`)) });
  const pub = { ...doc, body: { ...b, claims, mandates } };
  return { doc: pub, digest: digestOf(pub) };
}
```

`src/facts/index.ts`:
```ts
export * from "./types.ts";
export * from "./validate.ts";
export * from "./temporal.ts";
export * from "./invariants.ts";
export * from "./project.ts";
export * from "./mandate.ts";
export * from "./result.ts";
export * from "./public.ts";
```

`scripts/print-projection.ts`:
```ts
import { readFileSync } from "node:fs";
import { projectVectors } from "../src/facts/project.ts";
import { toProjectionIr } from "../src/facts/result.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/print-projection.ts <input.json>");
const input = JSON.parse(readFileSync(file, "utf8"));
const r = projectVectors(input.facts, input.usage, input.as_of, input.known_at);
const out = r.ok
  ? toProjectionIr(r.value, input.facts, input.usage, input.as_of, input.known_at)
  : { errors: r.errors.map((e) => e.code).sort() };
console.log(JSON.stringify(out, null, 2));
```

Run: `node --test test/facts/result.test.ts`
Expected: PASS.

- [ ] **Step 4: 적합성 입력 파생**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl" && node -e '
const f = require("fs");
const base = () => JSON.parse(f.readFileSync("conformance/facts/001-basic/input.json", "utf8"));
const write = (dir, i) => { f.mkdirSync(`conformance/facts/${dir}`, { recursive: true }); f.writeFileSync(`conformance/facts/${dir}/input.json`, JSON.stringify(i, null, 2) + "\n"); };
const d = base(); d.facts.body.claims.find((c) => c.id === "c5").status = "DISPUTED"; write("002-disputed-master", d);
const m = base(); m.facts.body.claims = m.facts.body.claims.filter((c) => c.id !== "c5"); write("003-path-missing", m);
'
```
Expected: 두 디렉터리에 `input.json` 생성.

- [ ] **Step 5: 기대값 작성 (손계산 값 + 코드가 낸 digest 고정)**

`conformance/facts/001-basic/expected.json` — `digest`를 제외한 값은 손계산이다 (MASTER: 전 스템 1; WORK: 6000/4000bps → 3/5, 2/5; FEATURED: 60000ms·30000ms → 2/3, 1/3):
```json
{
  "vectors": {
    "MASTER_OWNER": { "pty_label_x": "1/1" },
    "PERFORMER_FEATURED": { "pty_member_a": "2/3", "pty_member_b": "1/3" },
    "WORK_AUTHOR": { "pty_author_b": "3/5", "pty_author_c": "2/5" }
  },
  "paths": [
    { "stem": "stm_inst", "role": "MASTER_OWNER", "party": "pty_label_x", "weight": "1/1", "claims": ["c5"] },
    { "stem": "stm_inst", "role": "WORK_AUTHOR", "party": "pty_author_b", "weight": "3/5", "claims": ["c6"] },
    { "stem": "stm_inst", "role": "WORK_AUTHOR", "party": "pty_author_c", "weight": "2/5", "claims": ["c7"] },
    { "stem": "stm_v1", "role": "MASTER_OWNER", "party": "pty_label_x", "weight": "1/1", "claims": ["c5"] },
    { "stem": "stm_v1", "role": "PERFORMER_FEATURED", "party": "pty_member_a", "weight": "1/1", "claims": ["c1", "c3"] },
    { "stem": "stm_v1", "role": "WORK_AUTHOR", "party": "pty_author_b", "weight": "3/5", "claims": ["c6"] },
    { "stem": "stm_v1", "role": "WORK_AUTHOR", "party": "pty_author_c", "weight": "2/5", "claims": ["c7"] },
    { "stem": "stm_v2", "role": "MASTER_OWNER", "party": "pty_label_x", "weight": "1/1", "claims": ["c5"] },
    { "stem": "stm_v2", "role": "PERFORMER_FEATURED", "party": "pty_member_b", "weight": "1/1", "claims": ["c2", "c4"] },
    { "stem": "stm_v2", "role": "WORK_AUTHOR", "party": "pty_author_b", "weight": "3/5", "claims": ["c6"] },
    { "stem": "stm_v2", "role": "WORK_AUTHOR", "party": "pty_author_c", "weight": "2/5", "claims": ["c7"] }
  ],
  "digest": "REPLACE_WITH_PRINTED_DIGEST"
}
```

`conformance/facts/002-disputed-master/expected.json` — 001과 같되 MASTER_OWNER만 `@hold`:
```json
{
  "vectors": {
    "MASTER_OWNER": { "@hold": "1/1" },
    "PERFORMER_FEATURED": { "pty_member_a": "2/3", "pty_member_b": "1/3" },
    "WORK_AUTHOR": { "pty_author_b": "3/5", "pty_author_c": "2/5" }
  },
  "paths": [
    { "stem": "stm_inst", "role": "MASTER_OWNER", "party": "@hold", "weight": "1/1", "claims": ["c5"] },
    { "stem": "stm_inst", "role": "WORK_AUTHOR", "party": "pty_author_b", "weight": "3/5", "claims": ["c6"] },
    { "stem": "stm_inst", "role": "WORK_AUTHOR", "party": "pty_author_c", "weight": "2/5", "claims": ["c7"] },
    { "stem": "stm_v1", "role": "MASTER_OWNER", "party": "@hold", "weight": "1/1", "claims": ["c5"] },
    { "stem": "stm_v1", "role": "PERFORMER_FEATURED", "party": "pty_member_a", "weight": "1/1", "claims": ["c1", "c3"] },
    { "stem": "stm_v1", "role": "WORK_AUTHOR", "party": "pty_author_b", "weight": "3/5", "claims": ["c6"] },
    { "stem": "stm_v1", "role": "WORK_AUTHOR", "party": "pty_author_c", "weight": "2/5", "claims": ["c7"] },
    { "stem": "stm_v2", "role": "MASTER_OWNER", "party": "@hold", "weight": "1/1", "claims": ["c5"] },
    { "stem": "stm_v2", "role": "PERFORMER_FEATURED", "party": "pty_member_b", "weight": "1/1", "claims": ["c2", "c4"] },
    { "stem": "stm_v2", "role": "WORK_AUTHOR", "party": "pty_author_b", "weight": "3/5", "claims": ["c6"] },
    { "stem": "stm_v2", "role": "WORK_AUTHOR", "party": "pty_author_c", "weight": "2/5", "claims": ["c7"] }
  ],
  "digest": "REPLACE_WITH_PRINTED_DIGEST"
}
```

`conformance/facts/003-path-missing/expected.json`:
```json
{ "errors": ["FACTS_PATH_MISSING", "FACTS_PATH_MISSING", "FACTS_PATH_MISSING"] }
```

Run: `node scripts/print-projection.ts conformance/facts/001-basic/input.json` 그리고 `node scripts/print-projection.ts conformance/facts/002-disputed-master/input.json`
Expected: 출력의 `vectors`·`paths`가 위 손계산 값과 **완전히 일치**해야 한다. 일치하지 않으면 코드 버그이므로 Task 8을 다시 본다. 일치하면 각 출력의 `digest` 값을 해당 `expected.json`의 `"REPLACE_WITH_PRINTED_DIGEST"` 자리에 붙여 넣는다(이 digest는 이후 회귀 고정용이다).

- [ ] **Step 6: 전체 통과 확인**

Run: `npm test && npx tsc -p tsconfig.json && grep -r "REPLACE_WITH_PRINTED_DIGEST" conformance || echo "no placeholders"`
Expected: 전체 PASS (conformance 3건 포함), tsc 출력 없음, `no placeholders`.

- [ ] **Step 7: 스펙에 구현 반영 사항 추가**

`02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md` 맨 끝에 다음 절을 추가한다:
```markdown

---

## 12. 구현 반영 사항 (계획 1-A, 레퍼런스 구현 `04_구현_소스코드/mdrl`)

1. **패키지 구성**: 10.2의 다중 패키지 대신 단일 패키지 `mdrl`에 subpath export(`mdrl/core`, `mdrl/facts`)를 둔다. 외부 배포 시점에 분리한다.
2. **Enum 레지스트리 추가 항목**: `module`, `party_kind`, `voice_kind`, `performer_role`, `mandate_right`(`MASTER|WORK|PERFORMER`), `attestation_role`(`SPACE_OPS`, `SPACE_SETTLE` 포함). 정본은 `src/core/enums.ts`.
3. **IR 수치 표기**: 봉투의 `version`도 문자열이다(`"1"`). 유리수는 기약분수 `"n/d"`(정수도 `"1/1"`).
4. **의존 순환**: 의존은 낮은 rank로만 허용하므로 순환은 `CORE_DEP_DIRECTION`으로 보고한다. `CORE_DEP_CYCLE`은 두지 않는다.
5. **오류 코드 정본**: `spec/error-codes.md`. `FACTS_DUPLICATE_ID`, `FACTS_UNKNOWN_ENTITY`, `FACTS_EDGE_KIND`, `FACTS_USAGE_INVALID`, `FACTS_CLAIMANT_DRIFT`(v2.7 `CLAIMANT_DRIFT` 대응)를 추가했다.
6. **claim 그룹 키**: `(source, edge)`, 단 `PERFORMED_BY`는 `(source, edge, performer_role)`. `performer_role`은 `PERFORMED_BY`에 필수다.
7. **기여 벡터 정규화**: 역할별 분모는 그 역할 경로가 있는 스템의 `ASSIGNED_LAYER_MS × 경로 가중치 합`이다. 분쟁 그룹의 몫은 `@hold` 키로 벡터에 남아 합계 1이 유지된다(재정규화 없음).
8. **위임**: `mandate.share`는 위임인이 받을 몫 중 수임인이 수령하는 비율이다. 위임인별·권리별 합은 10000bps 이하. 분쟁 위임의 몫은 `@hold`.
9. **정적 검증 시점**: share 합·위임 불변식은 현재 지식(미대체 레코드) 기준으로 모든 유효기간 경계 시점에서 검사한다.
```

- [ ] **Step 8: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/facts/result.ts 04_구현_소스코드/mdrl/src/facts/public.ts 04_구현_소스코드/mdrl/src/facts/index.ts 04_구현_소스코드/mdrl/scripts 04_구현_소스코드/mdrl/conformance 04_구현_소스코드/mdrl/test/facts/result.test.ts 04_구현_소스코드/mdrl/test/conformance.test.ts "02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md" && git commit -m "feat(mdrl): 투영 결과 IR, 공개본, facts 적합성 스위트"
```

---

## Self-Review 결과

- **스펙 커버리지 (1-A 범위)**: 3.1 타입(T2) · 3.2 레지스트리(T1) · 3.3 정규형/digest(T3) · 3.4 공개 등급/커밋먼트(T3, T10 `publicFacts`) · 3.5 모듈/참조/의존(T4) · 3.6 서명/SoD(T5) · 3.7 오류 모델(T1) · 4.2 claim·이중 시간축·mandate(T6, T7) · 4.3 불변식 1~4(T7, T8) · 4.4 조합 지분·벡터·경로·커버리지(T8, T9, T10) · 10.3 적합성·오류 테스트(T10, 각 태스크). 1-A 범위 밖: 4.5 DB 파생 생성(운영 스키마 매핑, 별도 계획), 5장 allocation(1-B), 텍스트 문법·EBNF·legacy-v1(1-C), 속성 기반 테스트(1-B에서 안분과 함께 도입).
- **타입 일관성**: `groupKey`/`claimGroupKey`/`groupClaims`(T7) ↔ `project.ts` 사용 일치, `HOLD`/`PartyVector`(T8) ↔ `mandate.ts`·`result.ts` 일치, `MAX_MANDATE_HOPS`는 `types.ts` 한 곳.
- **자리표시자**: `REPLACE_WITH_PRINTED_DIGEST`는 Task 10 Step 5에서 명시적 명령으로 채우고 Step 6에서 잔존 여부를 검사한다.
