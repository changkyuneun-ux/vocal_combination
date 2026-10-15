# MDRL 1-B: allocation(안분 평가기) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스펙 5장의 `allocation` 모듈을 구현한다. 안분 정책 IR 검증, 벡터 식(graph·contract·member_pct·performance_pool·mix·cap·floor_guarantee) 평가, `HIERARCHICAL_LRM_V1` 원 단위 배분, 결정적 평가기(`evaluate`)와 결과 IR·digest, 그리고 스펙 12.20의 팩 활성화 판정(`FACTS_DISPUTE_OPEN`)을 만든다.

**Architecture:** 1-A 패키지(`04_구현_소스코드/mdrl`)에 `src/allocation/`을 추가하고 `mdrl/allocation` subpath로 노출한다. 평가기는 순수 함수다. 입력은 정책 IR, facts 문서, `projectToIr` 결과, 스냅샷(멤버 비율), 매출 이벤트이고, 출력은 풀 라인·권리자 라인·보류 라인·trace·`result_digest`다. 모든 비율은 `Ratio`(BigInt 유리수), 금액은 BigInt 최소 통화 단위다.

**Tech Stack:** Node.js ≥ 24 (네이티브 TypeScript), TypeScript 5.9 (`erasableSyntaxOnly`, 타입검사 전용), `node:test`, devDependency `ajv`(스키마 테스트 전용).

**상위 스펙:** `02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md` 5장, 12장(특히 12.7, 12.13, 12.16, 12.20)

**후속 계획:** 1-C `parser`(텍스트 문법 EBNF, legacy-v1 변환)·`mdrl` CLI·오류 코드별 최소 재현 케이스·공개본 검증 보강. 템플릿 계승(`ALLOC_WIDENING`), 역분개(`REVERSAL`), 다통화는 이번 범위 밖이다(스펙 12.30에 기록).

## Global Constraints

- 런타임 의존성 0. `dependencies` 필드를 만들지 않는다.
- TypeScript는 erasable syntax만 사용: `enum`, `namespace`, 생성자 parameter property 금지. 상대 import는 `.ts` 확장자를 붙인다. 타입 전용 import는 `import type`.
- 라이브러리 코드에서 부동소수 금지. 비율은 `Ratio`, 금액은 BigInt, 저장 비율은 정수 bps(0~10000). (테스트용 난수 생성기만 예외)
- IR에는 JSON number를 쓰지 않는다. 금액·bps·version은 문자열, 유리수는 기약분수 문자열 `"n/d"`.
- digest 표기: `mdrl:sha256:<64 hex>` = sha256(UTF-8(RFC 8785 JCS)).
- 오류 코드는 `src/core/errors.ts`의 `ERROR_CODES`에만 정의하고 `spec/error-codes.md`와 항상 일치시킨다(테스트가 강제). Enum 값은 `src/core/enums.ts`의 `ENUMS`에만 정의한다.
- 검증기는 JSON Schema가 `additionalProperties: false`로 막는 키를 `CORE_TYPE_ERROR`("unknown key")로 거부한다.
- 배열 정규형: 순서가 의미 없는 배열(이벤트 등)은 id 엄격 오름차순(코드 유닛 비교)이어야 한다.
- `JSON.stringify`로 `Ratio`/BigInt가 든 값을 직렬화할 때는 BigInt-safe replacer를 쓴다.
- 작업 디렉터리: `/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl` (git 루트 `/Users/changkyuneun/Vocal Combination`). 저장소에는 이 작업과 무관한 커밋 안 된 변경이 많다. `git add`는 태스크에 나열된 파일만 한다.
- 커밋 메시지: 제목, 빈 줄, 마지막 줄에 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
04_구현_소스코드/mdrl/
  package.json                    (Modify: "./allocation" export)
  spec/error-codes.md             (Modify: ALLOC_*, FACTS_DISPUTE_OPEN)
  spec/schema/allocation.ir.schema.json   (Create)
  src/core/
    errors.ts   (Modify: 코드 추가, attempt, 레거시 매핑)
    enums.ts    (Modify: holding_reason, integrity_status, vector_fn)
    shape.ts    (Create: ID_RE, isId, rejectUnknownKeys — envelope·facts·allocation 공용)
    envelope.ts (Modify: shape.ts 사용)
    index.ts    (Modify: shape.ts 재수출)
  src/facts/
    validate.ts   (Modify: shape.ts 사용)
    activation.ts (Create: checkActivation, FACTS_DISPUTE_OPEN)
    index.ts      (Modify: activation 재수출)
  src/allocation/
    types.ts     IR·입력·결과 타입
    lrm.ts       splitLrm (HIERARCHICAL_LRM_V1 한 층)
    vectors.ts   parseVector, mixVectors, fixedVector, usageVector, capVector, floorGuarantee
    validate.ts  validateAllocation (정책 정적 검증)
    expr.ts      evalVector (벡터 식 평가)
    evaluate.ts  evaluate (평가기, 결과 IR)
    index.ts
  scripts/print-allocation.ts
  conformance/allocation/{001-basic,002-disputed-master,003-fraud-hold}/{input.json,expected.json}
  test/prop.ts, test/helpers.ts (Modify)
  test/core/shape.test.ts, test/allocation/*.test.ts, test/facts/activation.test.ts, test/conformance.test.ts (Modify)
```

---

### Task 1: 레지스트리 확장 · 공용 형태 검사(shape.ts) · allocation 타입

**Files:**
- Modify: `src/core/errors.ts`, `src/core/enums.ts`, `spec/error-codes.md`, `src/core/envelope.ts`, `src/core/index.ts`, `src/facts/validate.ts`
- Create: `src/core/shape.ts`, `src/allocation/types.ts`
- Test: `test/core/shape.test.ts`, `test/core/errors.test.ts` (Modify)

**Interfaces:**
- Consumes: 1-A의 `diag`, `Diagnostic`, `MdrlError`, `ok`, `err`, `Result`, `IrDocument`, `EnumValue`, `ClaimantRole`
- Produces:
  - `errors.ts`: 새 코드 `FACTS_DISPUTE_OPEN`, `ALLOC_SUM_MISMATCH`, `ALLOC_WEIGHT_MISMATCH`, `ALLOC_MODE_REQUIRED`, `ALLOC_DUPLICATE_NAME`, `ALLOC_UNCOVERED_CLAIMANT`, `ALLOC_INFEASIBLE`, `ALLOC_SCOPE_MISMATCH`, `ALLOC_EMPTY_VECTOR`, `ALLOC_ROUNDING_INVARIANT`; `attempt<T>(fn: () => T): Result<T>`
  - `enums.ts`: `holding_reason`, `integrity_status`, `vector_fn`
  - `shape.ts`: `ID_RE`, `isId(v): v is string`, `rejectUnknownKeys(obj: object, allowed: readonly string[], path: string): Diagnostic[]`
  - `allocation/types.ts`: `VectorExpr`, `Tier1Bucket`, `SplitBucket`, `AllocationBody`, `AllocationDocument`, `Snapshot`, `RevenueEvent`, `PoolLine`, `AllocationLine`, `Holding`, `TraceEntry`, `AllocationResult`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/core/shape.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isId, rejectUnknownKeys } from "../../src/core/shape.ts";

test("isId accepts the MDRL id alphabet only", () => {
  for (const ok of ["pty_a", "VC-ALLOC.1", "a"]) assert.equal(isId(ok), true, ok);
  for (const bad of ["@hold", "a|b", "a,b", "", "한글", 1]) assert.equal(isId(bad), false, String(bad));
});

test("rejectUnknownKeys reports each extra key with its path", () => {
  assert.deepEqual(rejectUnknownKeys({ a: "1", b: "2" }, ["a", "b"], "$.x"), []);
  assert.deepEqual(
    rejectUnknownKeys({ a: "1", z: "2", y: "3" }, ["a"], "$.x").map((d) => [d.code, d.path]),
    [["CORE_TYPE_ERROR", "$.x.z"], ["CORE_TYPE_ERROR", "$.x.y"]],
  );
});
```

`test/core/errors.test.ts` 끝에 추가 (상단 import에 `attempt`를 추가):
```ts
test("attempt turns MdrlError into a failed Result and passes values through", () => {
  assert.deepEqual(attempt(() => 7), { ok: true, value: 7 });
  const r = attempt(() => fail("ALLOC_INFEASIBLE", "$.v"));
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.errors.map((d) => d.code), ["ALLOC_INFEASIBLE"]);
  assert.throws(() => attempt(() => { throw new TypeError("boom"); }), TypeError);
});
```
(상단 import 줄은 `import { ERROR_CODES, LEGACY_ERROR_MAP, MdrlError, attempt, capture, diag, fail } from "../../src/core/errors.ts";`가 된다.)

- [ ] **Step 2: 실패 확인**

Run: `node --test test/core/shape.test.ts test/core/errors.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`(`shape.ts`)와 `attempt` 미정의.

- [ ] **Step 3: 구현**

`src/core/shape.ts`:
```ts
import { diag, type Diagnostic } from "./errors.ts";

/** 모든 MDRL 식별자(엔티티 id, 참조, 문서 id, 이벤트 id)의 형식. `@`·`|`·`,`를 배제한다. */
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
```

`src/core/errors.ts` — `ERROR_CODES`의 `FACTS_CLAIMANT_DRIFT` 줄 바로 뒤에 추가:
```ts
  FACTS_DISPUTE_OPEN: "팩이 사용하는 권리 경로에 분쟁 중인 claim·mandate가 있어 활성화할 수 없다",
  ALLOC_SUM_MISMATCH: "버킷 bps 합이 10000이 아니다",
  ALLOC_WEIGHT_MISMATCH: "가중치 합이 10000bps(또는 1)가 아니다",
  ALLOC_MODE_REQUIRED: "performance_pool의 mode와 모드별 필수 가중치를 명시해야 한다",
  ALLOC_DUPLICATE_NAME: "버킷 이름 또는 배분 키가 중복된다",
  ALLOC_UNCOVERED_CLAIMANT: "조합 지분에서 도출된 청구권자 역할을 어느 버킷도 다루지 않는다",
  ALLOC_INFEASIBLE: "cap·floor_guarantee 조건을 만족하는 분배가 없다",
  ALLOC_SCOPE_MISMATCH: "매출 이벤트가 정책 범위(이벤트 유형·통화)를 벗어난다",
  ALLOC_EMPTY_VECTOR: "배분할 벡터가 비어 있다",
  ALLOC_ROUNDING_INVARIANT: "층별 배분 합이 상위 금액과 다르다(평가기 결함)",
```
`err` 함수 바로 뒤에 추가:
```ts
/** fail()이 던진 MdrlError를 실패 Result로 바꾼다. 그 밖의 예외는 그대로 던진다. */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (e) {
    if (e instanceof MdrlError) return err(e.diagnostics);
    throw e;
  }
}
```
`LEGACY_ERROR_MAP` 위 주석을 `/** 기존 설계 문서의 오류 코드 → MDRL 코드. */`로 바꾸고, 객체 끝에 추가:
```ts
  DSL_SUM_MISMATCH: "ALLOC_SUM_MISMATCH",
  DSL_WEIGHT_MISMATCH: "ALLOC_WEIGHT_MISMATCH",
  DSL_UNCOVERED_CLAIMANT: "ALLOC_UNCOVERED_CLAIMANT",
```

`src/core/enums.ts` — `ENUMS`의 `vc_status` 줄 뒤에 추가:
```ts
  holding_reason: ["RIGHTS_DISPUTE", "FRAUD_REVIEW"],
  integrity_status: ["CLEAR", "FLAGGED"],
  vector_fn: ["graph", "contract", "member_pct", "performance_pool", "mix", "cap", "floor_guarantee"],
```

`spec/error-codes.md` — 첫 표의 `FACTS_CLAIMANT_DRIFT` 행 뒤에 추가:
```markdown
| `FACTS_DISPUTE_OPEN` | 분쟁 중인 claim·mandate가 있어 팩 활성화 불가 | `checkActivation` |
| `ALLOC_SUM_MISMATCH` | tier1·tier2 버킷 bps 합 ≠ 10000 | `validateAllocation` |
| `ALLOC_WEIGHT_MISMATCH` | mix·HYBRID 가중치 합 ≠ 10000bps, 벡터 합 ≠ 1 | `validateAllocation`, `parseVector`, `splitLrm` |
| `ALLOC_MODE_REQUIRED` | performance_pool의 mode·필수 가중치 누락 | `validateAllocation` |
| `ALLOC_DUPLICATE_NAME` | 버킷 이름·배분 키 중복 | `validateAllocation`, `splitLrm` |
| `ALLOC_UNCOVERED_CLAIMANT` | 조합 지분 역할을 다루는 버킷 없음 | `evaluate` |
| `ALLOC_INFEASIBLE` | cap·floor_guarantee 불가능 | `validateAllocation`, `capVector`, `floorGuarantee` |
| `ALLOC_SCOPE_MISMATCH` | 이벤트 유형·통화가 정책 범위 밖 | `evaluate` |
| `ALLOC_EMPTY_VECTOR` | 배분할 벡터가 비어 있음 | `parseVector`, `fixedVector`, `usageVector`, `evalVector`, `splitLrm` |
| `ALLOC_ROUNDING_INVARIANT` | 층별 배분 합 ≠ 상위 금액 | `splitLrm` |
```
두 번째 표(기존 코드 매핑) 끝에 추가:
```markdown
| DSL_SUM_MISMATCH | `ALLOC_SUM_MISMATCH` |
| DSL_WEIGHT_MISMATCH | `ALLOC_WEIGHT_MISMATCH` |
| DSL_UNCOVERED_CLAIMANT | `ALLOC_UNCOVERED_CLAIMANT` |
```

`src/core/envelope.ts` — 공용 헬퍼로 교체:
1. import에 `import { isId, rejectUnknownKeys } from "./shape.ts";` 추가.
2. `const ID_RE = /^[A-Za-z0-9._-]+$/;` 줄 삭제.
3. `if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) out.push(diag("CORE_TYPE_ERROR", "$.id"));` → `if (!isId(doc.id)) out.push(diag("CORE_TYPE_ERROR", "$.id"));`
4. depends_on 항목의 주석 포함 for 루프(`// Check for unknown keys in dependency object ...`부터 닫는 `}`까지)를 `out.push(...rejectUnknownKeys(dep, DEPENDENCY_KEYS, p));`로 교체.
5. 최상위 for 루프(`// Check for unknown keys at top level`부터 닫는 `}`까지)를 `out.push(...rejectUnknownKeys(doc, ENVELOPE_KEYS, "$"));`로 교체.

`src/core/index.ts` 끝에 `export * from "./shape.ts";` 추가.

`src/facts/validate.ts` — 공용 헬퍼로 교체:
1. import에 `import { isId, rejectUnknownKeys } from "../core/shape.ts";` 추가.
2. `const ID_RE = ...;`와 `const isId = ...;` 두 줄 삭제.
3. 로컬 `unknownKeys` 함수 본문을 다음으로 교체(시그니처 유지):
```ts
function unknownKeys(obj: object, kind: keyof typeof ALLOWED_KEYS, path: string): Diagnostic[] {
  return rejectUnknownKeys(obj, ALLOWED_KEYS[kind], path);
}
```

`src/allocation/types.ts`:
```ts
import type { EnumValue } from "../core/enums.ts";
import type { IrDocument } from "../core/envelope.ts";
import type { ClaimantRole } from "../facts/types.ts";

/** 벡터 식. 비율 인자는 bps 문자열이다. */
export type VectorExpr =
  | { fn: "graph"; role: ClaimantRole; via_mandate?: boolean }
  | { fn: "contract"; party: string }
  | { fn: "member_pct" }
  | { fn: "performance_pool"; mode: EnumValue<"pool_mode">; fixed?: string; usage?: string; featured_weight?: string }
  | { fn: "mix"; parts: { weight: string; of: VectorExpr }[] }
  | { fn: "cap"; max: string; of: VectorExpr }
  | { fn: "floor_guarantee"; min: string; of: VectorExpr };

export type Tier1Bucket = { name: string; bps: string };
export type SplitBucket = { name: string; bps: string; role: ClaimantRole; vector: VectorExpr };

export type AllocationBody = {
  scope: { pack: string; events: EnumValue<"event_type">[]; currency: string };
  bind: { time: EnumValue<"binding_time"> };
  tier1: { buckets: Tier1Bucket[]; rights: string };
  tier2: { split: SplitBucket[] };
  rounding: { method: EnumValue<"rounding_method">; tie: "party_id_asc" };
};

export type AllocationDocument = IrDocument<AllocationBody>;

/** 발행 스냅샷: 실연 풀 멤버와 팬 빌더 멤버 비율(`"n/d"`, 합 1). */
export type Snapshot = { members: Record<string, string> };

export type RevenueEvent = {
  id: string;
  type: EnumValue<"event_type">;
  amount: string;
  currency: string;
  integrity: EnumValue<"integrity_status">;
};

export type PoolLine = { event_id: string; bucket: string; amount: string };
export type AllocationLine = { event_id: string; party: string; role: ClaimantRole; bucket: string; line_seq: string; amount: string };
export type Holding = { event_id: string; bucket: string; reason: EnumValue<"holding_reason">; amount: string };
export type TraceEntry = { event_id: string; level: string; total: string; parts: { key: string; weight: string; amount: string }[] };

export type AllocationResult = {
  run_id: string;
  policy_digest: string;
  projection_digest: string;
  snapshot_digest: string;
  events_digest: string;
  bind_time: EnumValue<"binding_time">;
  pool_lines: PoolLine[];
  lines: AllocationLine[];
  holdings: Holding[];
  trace: TraceEntry[];
  result_digest: string;
};
```

- [ ] **Step 4: 통과 확인**

Run: `npm test && npx tsc -p tsconfig.json`
Expected: 1-A 테스트 98개 포함 전부 PASS(오류 코드 문서 동기화 테스트 포함), tsc 출력 없음.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/core/errors.ts 04_구현_소스코드/mdrl/src/core/enums.ts 04_구현_소스코드/mdrl/src/core/shape.ts 04_구현_소스코드/mdrl/src/core/envelope.ts 04_구현_소스코드/mdrl/src/core/index.ts 04_구현_소스코드/mdrl/src/facts/validate.ts 04_구현_소스코드/mdrl/src/allocation/types.ts 04_구현_소스코드/mdrl/spec/error-codes.md 04_구현_소스코드/mdrl/test/core/shape.test.ts 04_구현_소스코드/mdrl/test/core/errors.test.ts && git commit -m "$(printf 'feat(mdrl): 안분 오류·Enum 레지스트리, 공용 형태 검사, allocation 타입\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 2: HIERARCHICAL_LRM_V1 한 층 배분 (splitLrm) + 속성 테스트 도구

**Files:**
- Create: `src/allocation/lrm.ts`, `test/prop.ts`
- Test: `test/allocation/lrm.test.ts`

**Interfaces:**
- Consumes: `fail` (errors.ts), `Ratio`, `ratio`, `ONE`, `cmp`, `sum`, `fromBps` (ratio.ts)
- Produces: `type Share = { key: string; weight: Ratio }`, `type Allotment = { key: string; weight: Ratio; amount: bigint }`, `splitLrm(total: bigint, shares: readonly Share[], path?: string): Allotment[]`; 테스트 도구 `rng(seed): () => number`, `int(r, lo, hi)`, `randomSplit(r, n, total?)`, `shuffle(r, xs)`

**규칙 (스펙 5.5):** `a_i = floor(R·w_i)`, `Δ = R − Σa_i`. 소수부 `frac(R·w_i)` 내림차순, 동률은 key 코드 유닛 오름차순으로 상위 Δ개 항목에 1씩 더한다. 결과 순서는 입력 순서를 유지한다. `Σ = R`가 아니면 `ALLOC_ROUNDING_INVARIANT`.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/prop.ts`:
```ts
/** 테스트 전용 결정적 난수(mulberry32). 라이브러리 코드는 이 파일을 쓰지 않는다. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** total을 n개의 음이 아닌 정수로 나눈다(합 = total). */
export function randomSplit(r: () => number, n: number, total = 10000): number[] {
  const cuts = Array.from({ length: n - 1 }, () => int(r, 0, total)).sort((a, b) => a - b);
  const bounds = [0, ...cuts, total];
  return bounds.slice(1).map((b, i) => b - bounds[i]!);
}

export function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
```

`test/allocation/lrm.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLrm, type Share } from "../../src/allocation/lrm.ts";
import { fromBps, ratio } from "../../src/core/ratio.ts";
import { MdrlError } from "../../src/core/errors.ts";
import { int, randomSplit, rng, shuffle } from "../prop.ts";

const shares = (...xs: [string, number][]): Share[] => xs.map(([key, bps]) => ({ key, weight: fromBps(bps) }));
const amounts = (xs: { key: string; amount: bigint }[]) => xs.map((x) => [x.key, x.amount]);
const code = (c: string) => (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === c;

test("exact split keeps input order", () => {
  assert.deepEqual(amounts(splitLrm(10000n, shares(["platform", 2500], ["ops", 500], ["rights", 7000]))), [
    ["platform", 2500n], ["ops", 500n], ["rights", 7000n],
  ]);
});

test("remainder goes to the largest fraction", () => {
  // 1001 × (0.25, 0.05, 0.7) = 250.25, 50.05, 700.7 → Δ=1 → rights
  assert.deepEqual(amounts(splitLrm(1001n, shares(["platform", 2500], ["ops", 500], ["rights", 7000]))), [
    ["platform", 250n], ["ops", 50n], ["rights", 701n],
  ]);
});

test("equal fractions break ties by key ascending", () => {
  // 701 × (0.45, 0.45, 0.1) = 315.45, 315.45, 70.1 → Δ=1 → "master" < "performer"
  assert.deepEqual(amounts(splitLrm(701n, shares(["performer", 4500], ["master", 4500], ["work", 1000]))), [
    ["performer", 315n], ["master", 316n], ["work", 70n],
  ]);
  // 1 × (1/3, 1/3, 1/3) → Δ=1 → 가장 작은 key
  const third = ratio(1n, 3n);
  assert.deepEqual(amounts(splitLrm(1n, [{ key: "b", weight: third }, { key: "a", weight: third }, { key: "c", weight: third }])), [
    ["b", 0n], ["a", 1n], ["c", 0n],
  ]);
});

test("zero total and zero weights", () => {
  assert.deepEqual(amounts(splitLrm(0n, shares(["a", 5000], ["b", 5000]))), [["a", 0n], ["b", 0n]]);
  assert.deepEqual(amounts(splitLrm(3n, shares(["a", 0], ["b", 10000]))), [["a", 0n], ["b", 3n]]);
});

test("invalid inputs", () => {
  assert.throws(() => splitLrm(10n, []), code("ALLOC_EMPTY_VECTOR"));
  assert.throws(() => splitLrm(10n, shares(["a", 5000], ["a", 5000])), code("ALLOC_DUPLICATE_NAME"));
  assert.throws(() => splitLrm(10n, shares(["a", 5000], ["b", 4000])), code("ALLOC_WEIGHT_MISMATCH"));
  assert.throws(() => splitLrm(-1n, shares(["a", 10000])), code("CORE_TYPE_ERROR"));
  assert.throws(() => splitLrm(10n, [{ key: "a", weight: ratio(-1n, 2n) }, { key: "b", weight: ratio(3n, 2n) }]), code("CORE_TYPE_ERROR"));
});

test("property: sums are exact, each amount is floor or floor+1, order-independent per key", () => {
  const r = rng(20260928);
  for (let round = 0; round < 300; round++) {
    const n = int(r, 1, 8);
    const bps = randomSplit(r, n);
    const input = bps.map((b, i) => ({ key: `k${i}`, weight: fromBps(b) }));
    const total = BigInt(int(r, 0, 10_000_000));
    const out = splitLrm(total, input);
    assert.equal(out.reduce((a, x) => a + x.amount, 0n), total);
    for (const x of out) {
      const floor = (total * x.weight.n) / x.weight.d;
      assert.ok(x.amount === floor || x.amount === floor + 1n, `${x.key}`);
    }
    const again = new Map(splitLrm(total, shuffle(r, input)).map((x) => [x.key, x.amount]));
    for (const x of out) assert.equal(again.get(x.key), x.amount);
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/allocation/lrm.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/allocation/lrm.ts`).

- [ ] **Step 3: 구현**

`src/allocation/lrm.ts`:
```ts
import { fail } from "../core/errors.ts";
import { ONE, cmp, sum, type Ratio } from "../core/ratio.ts";

export type Share = { key: string; weight: Ratio };
export type Allotment = { key: string; weight: Ratio; amount: bigint };

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * HIERARCHICAL_LRM_V1의 한 층(스펙 5.5): floor(R·w) 후 잔여 Δ를 소수부 내림차순,
 * 동률은 key 오름차순으로 1씩 배분한다. 결과는 입력 순서를 유지한다.
 */
export function splitLrm(total: bigint, shares: readonly Share[], path = "$"): Allotment[] {
  if (total < 0n) fail("CORE_TYPE_ERROR", path, "negative total");
  if (shares.length === 0) fail("ALLOC_EMPTY_VECTOR", path);
  if (new Set(shares.map((s) => s.key)).size !== shares.length) fail("ALLOC_DUPLICATE_NAME", path, "duplicate key");
  if (shares.some((s) => s.weight.n < 0n)) fail("CORE_TYPE_ERROR", path, "negative weight");
  if (cmp(sum(shares.map((s) => s.weight)), ONE) !== 0) fail("ALLOC_WEIGHT_MISMATCH", path, "weights must sum to 1");

  const rows = shares.map((s) => {
    const num = total * s.weight.n;
    return { key: s.key, weight: s.weight, amount: num / s.weight.d, rem: num % s.weight.d };
  });
  let delta = total - rows.reduce((a, r) => a + r.amount, 0n);
  const order = [...rows].sort((a, b) => {
    const l = a.rem * b.weight.d;
    const r = b.rem * a.weight.d;
    return l > r ? -1 : l < r ? 1 : byKey(a.key, b.key);
  });
  for (const row of order) {
    if (delta === 0n) break;
    row.amount += 1n;
    delta -= 1n;
  }
  const out = rows.map(({ key, weight, amount }) => ({ key, weight, amount }));
  if (out.reduce((a, r) => a + r.amount, 0n) !== total) fail("ALLOC_ROUNDING_INVARIANT", path);
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/allocation/lrm.test.ts && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/allocation/lrm.ts 04_구현_소스코드/mdrl/test/prop.ts 04_구현_소스코드/mdrl/test/allocation/lrm.test.ts && git commit -m "$(printf 'feat(mdrl): HIERARCHICAL_LRM_V1 한 층 배분과 속성 테스트 도구\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 3: 벡터 연산 (parse · mix · fixed · usage · cap · floor)

**Files:**
- Create: `src/allocation/vectors.ts`
- Test: `test/allocation/vectors.test.ts`

**Interfaces:**
- Consumes: `fail`; `Ratio`, `ratio`, `ONE`, `ZERO`, `add`, `sub`, `mul`, `div`, `cmp`, `sum`, `parseRatio`; `isId`; `HOLD`, `PartyVector` (facts/project.ts)
- Produces: `collect(entries: Iterable<[string, Ratio]>): PartyVector`, `parseVector(v: unknown, path: string): PartyVector`, `mixVectors(parts: readonly { weight: Ratio; vec: PartyVector }[]): PartyVector`, `fixedVector(members: readonly string[], path: string): PartyVector`, `usageVector(featured: PartyVector | undefined, nonFeatured: PartyVector | undefined, featuredWeight: Ratio, path: string): PartyVector`, `capVector(vec: PartyVector, max: Ratio, path: string): PartyVector`, `floorGuarantee(vec: PartyVector, members: readonly string[], min: Ratio, path: string): PartyVector`

**규칙 (스펙 12.22·12.23로 기록):**
- 모든 결과 벡터는 키가 코드 유닛 오름차순이고 합이 정확히 1이다.
- `usageVector`: 주실연 F와 부실연 N이 모두 있으면 `fw·F + (1−fw)·N`, 한쪽만 있으면 그 벡터, 둘 다 없으면 `ALLOC_EMPTY_VECTOR`.
- `capVector`: 반복 수위 채우기. max를 넘는 party를 max로 묶고, 남은 가중치를 묶이지 않은 party에 원래 비율대로 재분배한다. `@hold`는 제한하지도 재분배받지도 않는다. 결과 합이 1이 될 수 없으면 `ALLOC_INFEASIBLE`.
- `floorGuarantee`: 영역 = members ∪ 벡터의 party(`@hold` 제외). min 미만인 party를 min으로 올리고 나머지를 비율대로 줄인다(반복). `|영역|·min > 1 − hold`면 `ALLOC_INFEASIBLE`.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/allocation/vectors.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capVector, fixedVector, floorGuarantee, mixVectors, parseVector, usageVector,
} from "../../src/allocation/vectors.ts";
import { ONE, fromBps, ratio, sum } from "../../src/core/ratio.ts";
import { MdrlError } from "../../src/core/errors.ts";

const r = (n: bigint, d: bigint) => ratio(n, d);
const code = (c: string) => (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === c;

test("parseVector parses ratios, sorts keys and requires sum 1", () => {
  const v = parseVector({ pty_b: "1/3", "@hold": "1/3", pty_a: "1/3" }, "$.v");
  assert.deepEqual(Object.keys(v), ["@hold", "pty_a", "pty_b"]);
  assert.deepEqual(v.pty_a, r(1n, 3n));
  assert.throws(() => parseVector({ a: "1/2" }, "$.v"), code("ALLOC_WEIGHT_MISMATCH"));
  assert.throws(() => parseVector({}, "$.v"), code("ALLOC_EMPTY_VECTOR"));
  assert.throws(() => parseVector({ "a|b": "1/1" }, "$.v"), code("CORE_TYPE_ERROR"));
  assert.throws(() => parseVector({ a: "2/4" }, "$.v"), code("CORE_TYPE_ERROR"));
  assert.throws(() => parseVector({ a: 1 }, "$.v"), code("CORE_TYPE_ERROR"));
  assert.throws(() => parseVector({ a: "3/2", b: "-1/2" }, "$.v"), code("CORE_TYPE_ERROR"));
});

test("mixVectors merges keys with weights", () => {
  const v = mixVectors([
    { weight: fromBps(4000), vec: { a: r(1n, 2n), b: r(1n, 2n) } },
    { weight: fromBps(6000), vec: { a: r(2n, 3n), b: r(1n, 3n) } },
  ]);
  assert.deepEqual(v, { a: r(3n, 5n), b: r(2n, 5n) });
});

test("fixedVector splits equally", () => {
  assert.deepEqual(fixedVector(["b", "a", "c"], "$"), { a: r(1n, 3n), b: r(1n, 3n), c: r(1n, 3n) });
  assert.throws(() => fixedVector([], "$"), code("ALLOC_EMPTY_VECTOR"));
});

test("usageVector mixes featured and non-featured, or uses the one present", () => {
  const f = { a: ONE };
  const n = { b: ONE };
  assert.deepEqual(usageVector(f, n, fromBps(7000), "$"), { a: r(7n, 10n), b: r(3n, 10n) });
  assert.deepEqual(usageVector(f, undefined, fromBps(7000), "$"), f);
  assert.deepEqual(usageVector(undefined, n, fromBps(7000), "$"), n);
  assert.throws(() => usageVector(undefined, undefined, fromBps(7000), "$"), code("ALLOC_EMPTY_VECTOR"));
});

test("capVector redistributes the excess proportionally", () => {
  assert.deepEqual(capVector({ a: r(3n, 5n), b: r(3n, 10n), c: r(1n, 10n) }, r(1n, 2n), "$"), {
    a: r(1n, 2n), b: r(3n, 8n), c: r(1n, 8n),
  });
  assert.deepEqual(capVector({ a: r(2n, 3n), b: r(1n, 3n) }, fromBps(6000), "$"), { a: r(3n, 5n), b: r(2n, 5n) });
  // @hold는 제한·재분배 대상이 아니다
  assert.deepEqual(capVector({ "@hold": r(1n, 5n), a: r(3n, 5n), b: r(1n, 5n) }, r(1n, 2n), "$"), {
    "@hold": r(1n, 5n), a: r(1n, 2n), b: r(3n, 10n),
  });
  assert.throws(() => capVector({ a: ONE }, r(1n, 2n), "$"), code("ALLOC_INFEASIBLE"));
});

test("floorGuarantee raises unselected members and scales the rest", () => {
  assert.deepEqual(floorGuarantee({ a: r(9n, 10n), b: r(1n, 10n) }, ["a", "b", "c"], r(1n, 10n), "$"), {
    a: r(4n, 5n), b: r(1n, 10n), c: r(1n, 10n),
  });
  assert.deepEqual(floorGuarantee({ label: ONE }, ["a", "b"], fromBps(1000), "$"), {
    a: r(1n, 10n), b: r(1n, 10n), label: r(4n, 5n),
  });
  assert.throws(() => floorGuarantee({ a: ONE }, ["a", "b", "c"], r(2n, 5n), "$"), code("ALLOC_INFEASIBLE"));
});

test("results always sum to exactly 1", () => {
  const v = floorGuarantee(capVector({ a: r(7n, 10n), b: r(2n, 10n), c: r(1n, 10n) }, r(1n, 2n), "$"), ["a", "b", "c", "d"], r(1n, 20n), "$");
  assert.deepEqual(sum(Object.values(v)), ONE);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/allocation/vectors.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/allocation/vectors.ts`).

- [ ] **Step 3: 구현**

`src/allocation/vectors.ts`:
```ts
import { fail } from "../core/errors.ts";
import { ONE, ZERO, add, cmp, div, mul, parseRatio, ratio, sub, sum, type Ratio } from "../core/ratio.ts";
import { isId } from "../core/shape.ts";
import { HOLD, type PartyVector } from "../facts/project.ts";

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 같은 키는 더하고 키를 코드 유닛 오름차순으로 정렬한 벡터를 만든다. */
export function collect(entries: Iterable<[string, Ratio]>): PartyVector {
  const m = new Map<string, Ratio>();
  for (const [k, w] of entries) m.set(k, add(m.get(k) ?? ZERO, w));
  const out: PartyVector = {};
  for (const k of [...m.keys()].sort(byKey)) out[k] = m.get(k)!;
  return out;
}

/** `{ party: "n/d" }` 문자열 벡터를 파싱한다. 키는 party id 또는 `@hold`, 합은 정확히 1이어야 한다. */
export function parseVector(v: unknown, path: string): PartyVector {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("CORE_TYPE_ERROR", path, "vector must be an object");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) fail("ALLOC_EMPTY_VECTOR", path);
  const parsed = entries.map(([k, s]): [string, Ratio] => {
    const p = `${path}.${k}`;
    if (k !== HOLD && !isId(k)) fail("CORE_TYPE_ERROR", p, "not a party id");
    if (typeof s !== "string") fail("CORE_TYPE_ERROR", p, "ratio string required");
    const w = parseRatio(s, p);
    if (w.n < 0n) fail("CORE_TYPE_ERROR", p, "negative weight");
    return [k, w];
  });
  if (cmp(sum(parsed.map(([, w]) => w)), ONE) !== 0) fail("ALLOC_WEIGHT_MISMATCH", path, "vector must sum to 1");
  return collect(parsed);
}

export function mixVectors(parts: readonly { weight: Ratio; vec: PartyVector }[]): PartyVector {
  return collect(parts.flatMap(({ weight, vec }) => Object.entries(vec).map(([k, w]): [string, Ratio] => [k, mul(weight, w)])));
}

export function fixedVector(members: readonly string[], path: string): PartyVector {
  if (members.length === 0) fail("ALLOC_EMPTY_VECTOR", path, "no pool members");
  const w = ratio(1n, BigInt(members.length));
  return collect(members.map((m): [string, Ratio] => [m, w]));
}

/** USAGE_WEIGHTED: 주실연 F와 부실연 N을 featured_weight로 섞는다. 한쪽만 있으면 그 벡터 전체를 쓴다. */
export function usageVector(
  featured: PartyVector | undefined, nonFeatured: PartyVector | undefined, featuredWeight: Ratio, path: string,
): PartyVector {
  if (featured !== undefined && nonFeatured !== undefined) {
    return mixVectors([{ weight: featuredWeight, vec: featured }, { weight: sub(ONE, featuredWeight), vec: nonFeatured }]);
  }
  const only = featured ?? nonFeatured;
  if (only === undefined) fail("ALLOC_EMPTY_VECTOR", path, "no performer vector in projection");
  return only;
}

/** `@hold`는 그대로 두고 parties에 value를 매긴 벡터. 합이 1이 아니면 조건을 만족하는 분배가 없는 것이다. */
function build(vec: PartyVector, parties: readonly string[], value: (k: string) => Ratio, path: string): PartyVector {
  const hold: [string, Ratio][] = HOLD in vec ? [[HOLD, vec[HOLD]!]] : [];
  const out = collect([...hold, ...parties.map((k): [string, Ratio] => [k, value(k)])]);
  if (cmp(sum(Object.values(out)), ONE) !== 0) fail("ALLOC_INFEASIBLE", path, "no distribution satisfies the constraint");
  return out;
}

/** 한 party의 몫을 max로 제한하고 초과분을 제한되지 않은 party에 원래 비율대로 재분배한다(반복 수위 채우기). */
export function capVector(vec: PartyVector, max: Ratio, path: string): PartyVector {
  const parties = Object.keys(vec).filter((k) => k !== HOLD);
  const capped = new Set<string>();
  for (;;) {
    const free = parties.filter((k) => !capped.has(k));
    const remaining = sub(sub(ONE, vec[HOLD] ?? ZERO), mul(ratio(BigInt(capped.size)), max));
    const freeSum = sum(free.map((k) => vec[k]!));
    const scale = freeSum.n === 0n ? ZERO : div(remaining, freeSum);
    const over = free.filter((k) => cmp(mul(vec[k]!, scale), max) > 0);
    if (over.length === 0) return build(vec, parties, (k) => (capped.has(k) ? max : mul(vec[k]!, scale)), path);
    for (const k of over) capped.add(k);
  }
}

/** members와 벡터의 party 각각이 최소 min을 받도록 올리고, 나머지를 원래 비율대로 줄인다(반복). */
export function floorGuarantee(vec: PartyVector, members: readonly string[], min: Ratio, path: string): PartyVector {
  const domain = [...new Set([...Object.keys(vec).filter((k) => k !== HOLD), ...members])];
  const available = sub(ONE, vec[HOLD] ?? ZERO);
  if (cmp(mul(ratio(BigInt(domain.length)), min), available) > 0) fail("ALLOC_INFEASIBLE", path, "floor exceeds available weight");
  const val = (k: string) => vec[k] ?? ZERO;
  const floored = new Set(domain.filter((k) => cmp(val(k), min) < 0));
  for (;;) {
    const others = domain.filter((k) => !floored.has(k));
    const remaining = sub(available, mul(ratio(BigInt(floored.size)), min));
    const othersSum = sum(others.map(val));
    const scale = othersSum.n === 0n ? ZERO : div(remaining, othersSum);
    const under = others.filter((k) => cmp(mul(val(k), scale), min) < 0);
    if (under.length === 0) return build(vec, domain, (k) => (floored.has(k) ? min : mul(val(k), scale)), path);
    for (const k of under) floored.add(k);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/allocation/vectors.test.ts && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/allocation/vectors.ts 04_구현_소스코드/mdrl/test/allocation/vectors.test.ts && git commit -m "$(printf 'feat(mdrl): 안분 벡터 연산(mix·usage·cap·floor)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 4: 정책 정적 검증 (validateAllocation) · allocation 스키마 · 기본 픽스처

**Files:**
- Create: `src/allocation/validate.ts`, `spec/schema/allocation.ir.schema.json`, `conformance/allocation/001-basic/input.json`
- Modify: `test/helpers.ts`
- Test: `test/allocation/validate.test.ts`

**Interfaces:**
- Consumes: `validateEnvelope`; `isEnumValue`, `EnumName`, `ENUMS`; `capture`, `diag`, `Diagnostic`; `isPlainObject`; `isId`, `rejectUnknownKeys`; `parseBps`, `BPS_TOTAL`
- Produces: `validateAllocation(doc: unknown): Diagnostic[]`; helpers `type AllocationCase = { facts_case: string; policy: AllocationDocument; snapshot: Snapshot; events: RevenueEvent[]; run_id: string }`, `loadAllocationCase(name?: string): AllocationCase`, `loadFactsCase(name: string): BasicInput`

**검사 목록:** 봉투·`module === "allocation"`, 알 수 없는 키(모든 객체), scope(pack id, events 비어 있지 않은 고유 event_type 배열, 통화 `^[A-Z]{3}$`), bind.time, rounding(method enum, tie `"party_id_asc"`), tier1·tier2 버킷(이름 `^[a-z][a-z0-9_]*$`, 중복 → `ALLOC_DUPLICATE_NAME`, bps 합 10000 → `ALLOC_SUM_MISMATCH`), `tier1.rights`가 tier1 버킷 이름(→ `CORE_UNKNOWN_REF`), split 버킷 role, 벡터 식(fn은 `vector_fn`, fn별 허용 키, mix 가중치 합 10000 → `ALLOC_WEIGHT_MISMATCH`, cap max 0 → `ALLOC_INFEASIBLE`), performance_pool(mode 없음 → `ALLOC_MODE_REQUIRED`; USAGE_WEIGHTED는 featured_weight 필수; HYBRID는 fixed·usage·featured_weight 필수, fixed+usage=10000 아니면 `ALLOC_WEIGHT_MISMATCH`; MEMBER_PCT·FIXED에 가중치 인자가 있으면 `CORE_TYPE_ERROR`).

- [ ] **Step 1: 픽스처와 헬퍼 작성**

`conformance/allocation/001-basic/input.json` (depends_on digest는 `conformance/facts/001-basic`의 facts 문서 digest다):
```json
{
  "facts_case": "001-basic",
  "policy": {
    "mdrl": "1.0",
    "module": "allocation",
    "id": "VC-ALLOC-NOVA-02",
    "version": "1",
    "depends_on": [
      { "ref": "vc:facts/nova-debut-01@1", "digest": "mdrl:sha256:c298f06c54947a4874935de562f47bff43aa491d784233f117e80a5eac3fffdd" }
    ],
    "visibility_default": "PARTIES",
    "body": {
      "scope": { "pack": "pak_nova_summer_02", "events": ["PRIMARY", "RESALE"], "currency": "KRW" },
      "bind": { "time": "ISSUE_TIME" },
      "tier1": {
        "buckets": [
          { "name": "platform", "bps": "2500" },
          { "name": "ops", "bps": "500" },
          { "name": "rights", "bps": "7000" }
        ],
        "rights": "rights"
      },
      "tier2": {
        "split": [
          { "name": "master", "bps": "4500", "role": "MASTER_OWNER", "vector": { "fn": "graph", "role": "MASTER_OWNER" } },
          {
            "name": "performer", "bps": "4500", "role": "PERFORMER_FEATURED",
            "vector": { "fn": "performance_pool", "mode": "HYBRID", "fixed": "4000", "usage": "6000", "featured_weight": "7000" }
          },
          { "name": "work", "bps": "1000", "role": "WORK_AUTHOR", "vector": { "fn": "graph", "role": "WORK_AUTHOR", "via_mandate": true } }
        ]
      },
      "rounding": { "method": "HIERARCHICAL_LRM_V1", "tie": "party_id_asc" }
    }
  },
  "snapshot": { "members": { "pty_member_a": "1/2", "pty_member_b": "1/2" } },
  "events": [
    { "id": "ev_001", "type": "PRIMARY", "amount": "10000", "currency": "KRW", "integrity": "CLEAR" },
    { "id": "ev_002", "type": "PRIMARY", "amount": "1001", "currency": "KRW", "integrity": "CLEAR" }
  ],
  "run_id": "run_2026_06"
}
```

`test/helpers.ts` — 상단 import 뒤에 추가하고 파일 끝에 함수를 추가:
```ts
import type { AllocationDocument, RevenueEvent, Snapshot } from "../src/allocation/types.ts";

export type AllocationCase = {
  facts_case: string;
  policy: AllocationDocument;
  snapshot: Snapshot;
  events: RevenueEvent[];
  run_id: string;
};

export function loadAllocationCase(name = "001-basic"): AllocationCase {
  return JSON.parse(readFileSync(new URL(`../conformance/allocation/${name}/input.json`, import.meta.url), "utf8"));
}

export function loadFactsCase(name: string): BasicInput {
  return JSON.parse(readFileSync(new URL(`../conformance/facts/${name}/input.json`, import.meta.url), "utf8"));
}
```
(`import type` 줄은 파일 맨 위 import 묶음에 둔다.)

- [ ] **Step 2: 실패하는 테스트 작성**

`test/allocation/validate.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { validateAllocation } from "../../src/allocation/validate.ts";
import type { VectorExpr } from "../../src/allocation/types.ts";
import { loadAllocationCase } from "../helpers.ts";

const codes = (doc: unknown) => validateAllocation(doc).map((d) => d.code).sort();
const policy = () => loadAllocationCase().policy;
const withVector = (v: unknown) => {
  const p = policy();
  p.body.tier2.split[1]!.vector = v as VectorExpr;
  return p;
};

test("basic policy is valid", () => {
  assert.deepEqual(validateAllocation(policy()), []);
});

test("wrong module", () => {
  assert.deepEqual(codes({ ...policy(), module: "facts" }), ["CORE_TYPE_ERROR"]);
});

test("tier sums, duplicate names and rights reference", () => {
  const p = policy();
  p.body.tier1.buckets[0]!.bps = "2600";
  assert.deepEqual(codes(p), ["ALLOC_SUM_MISMATCH"]);
  const q = policy();
  q.body.tier2.split[2]!.name = "master";
  assert.deepEqual(codes(q), ["ALLOC_DUPLICATE_NAME"]);
  const s = policy();
  s.body.tier1.rights = "royalty";
  assert.deepEqual(codes(s), ["CORE_UNKNOWN_REF"]);
});

test("scope, bind, rounding and role checks", () => {
  const p = policy();
  p.body.scope.currency = "krw";
  p.body.scope.events = ["PRIMARY", "PRIMARY"];
  assert.deepEqual(codes(p), ["CORE_TYPE_ERROR", "CORE_TYPE_ERROR"]);
  const q = policy();
  q.body.bind.time = "NOW" as never;
  q.body.tier2.split[0]!.role = "OWNER" as never;
  q.body.rounding.tie = "party_id_desc" as never;
  assert.deepEqual(codes(q), ["CORE_ENUM_UNKNOWN", "CORE_ENUM_UNKNOWN", "CORE_TYPE_ERROR"]);
});

test("performance_pool mode rules", () => {
  assert.deepEqual(codes(withVector({ fn: "performance_pool" })), ["ALLOC_MODE_REQUIRED"]);
  assert.deepEqual(codes(withVector({ fn: "performance_pool", mode: "USAGE_WEIGHTED" })), ["ALLOC_MODE_REQUIRED"]);
  assert.deepEqual(
    codes(withVector({ fn: "performance_pool", mode: "HYBRID", fixed: "4000", usage: "5000", featured_weight: "7000" })),
    ["ALLOC_WEIGHT_MISMATCH"],
  );
  assert.deepEqual(codes(withVector({ fn: "performance_pool", mode: "FIXED", featured_weight: "7000" })), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(codes(withVector({ fn: "performance_pool", mode: "MEMBER_PCT" })), []);
});

test("vector expressions", () => {
  assert.deepEqual(codes(withVector({ fn: "magic" })), ["CORE_ENUM_UNKNOWN"]);
  assert.deepEqual(codes(withVector({ fn: "graph", role: "MASTER_OWNER", extra: "x" })), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(codes(withVector({ fn: "contract", party: "@hold" })), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(
    codes(withVector({ fn: "mix", parts: [
      { weight: "5000", of: { fn: "member_pct" } },
      { weight: "4000", of: { fn: "graph", role: "MASTER_OWNER" } },
    ] })),
    ["ALLOC_WEIGHT_MISMATCH"],
  );
  assert.deepEqual(codes(withVector({ fn: "cap", max: "0", of: { fn: "member_pct" } })), ["ALLOC_INFEASIBLE"]);
  assert.deepEqual(
    codes(withVector({ fn: "floor_guarantee", min: "300", of: { fn: "cap", max: "5000", of: { fn: "member_pct" } } })),
    [],
  );
});

test("unknown keys are rejected", () => {
  const p = policy() as unknown as { body: Record<string, unknown> & { tier1: Record<string, unknown> } };
  p.body.extra = "x";
  p.body.tier1.note = "y";
  assert.deepEqual(codes(p), ["CORE_TYPE_ERROR", "CORE_TYPE_ERROR"]);
});

test("allocation JSON Schema agrees with the validator", () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
  const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../../spec/schema/${f}`, import.meta.url), "utf8"));
  ajv.addSchema(load("envelope.schema.json"));
  const validate = ajv.compile(load("allocation.ir.schema.json"));
  assert.equal(validate(policy()), true, JSON.stringify(validate.errors));
  for (const bad of [
    withVector({ fn: "magic" }),
    withVector({ fn: "graph", role: "MASTER_OWNER", extra: "x" }),
    withVector({ fn: "contract", party: "@hold" }),
  ]) {
    assert.equal(validate(bad), false);
    assert.ok(codes(bad).length > 0);
  }
  const numeric = policy() as unknown as { body: { tier1: { buckets: { bps: unknown }[] } } };
  numeric.body.tier1.buckets[0]!.bps = 2500;
  assert.equal(validate(numeric), false);
  assert.ok(codes(numeric).length > 0);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/allocation/validate.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/allocation/validate.ts`).

- [ ] **Step 4: 구현**

`src/allocation/validate.ts`:
```ts
import { BPS_TOTAL, parseBps } from "../core/bps.ts";
import { validateEnvelope } from "../core/envelope.ts";
import { isEnumValue, type EnumName, type EnumValue } from "../core/enums.ts";
import { capture, diag, type Diagnostic } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** 벡터 식 fn별 허용 키. `additionalProperties: false` 스키마와 일치시킨다. */
const VECTOR_KEYS: Readonly<Record<EnumValue<"vector_fn">, readonly string[]>> = {
  graph: ["fn", "role", "via_mandate"],
  contract: ["fn", "party"],
  member_pct: ["fn"],
  performance_pool: ["fn", "mode", "fixed", "usage", "featured_weight"],
  mix: ["fn", "parts"],
  cap: ["fn", "max", "of"],
  floor_guarantee: ["fn", "min", "of"],
};

type Obj = Record<string, unknown>;

/** 안분 정책 IR의 정적 검증(스펙 5.4). 조합 지분·스냅샷이 필요한 검사(커버리지 등)는 evaluate가 한다. */
export function validateAllocation(doc: unknown): Diagnostic[] {
  const env = validateEnvelope(doc);
  if (env.length > 0) return env;
  const d = doc as { module: unknown; body: Obj };
  if (d.module !== "allocation") return [diag("CORE_TYPE_ERROR", "$.module", "expected allocation")];
  const out: Diagnostic[] = [];

  const obj = (v: unknown, p: string): v is Obj => {
    if (isPlainObject(v)) return true;
    out.push(diag("CORE_TYPE_ERROR", p, "must be an object"));
    return false;
  };
  const enumCheck = (name: EnumName, v: unknown, p: string) => {
    if (!isEnumValue(name, v)) out.push(diag("CORE_ENUM_UNKNOWN", p, `${name}: ${String(v)}`));
  };
  /** bps를 검사하고 값을 돌려준다. 잘못되면 오류를 기록하고 undefined. */
  const bps = (v: unknown, p: string): number | undefined => {
    const e = capture(() => parseBps(v, p));
    out.push(...e);
    return e.length === 0 ? Number(v) : undefined;
  };
  const silentBps = (v: unknown): number | undefined => (capture(() => parseBps(v)).length === 0 ? Number(v) : undefined);

  const buckets = (arr: unknown, p: string, extra: readonly string[], each?: (bk: Obj, bp: string) => void): string[] => {
    if (!Array.isArray(arr) || arr.length === 0) {
      out.push(diag("CORE_TYPE_ERROR", p, "non-empty array required"));
      return [];
    }
    const names: string[] = [];
    let total = 0;
    let complete = true;
    arr.forEach((bk: unknown, i: number) => {
      const bp = `${p}[${i}]`;
      if (!obj(bk, bp)) {
        complete = false;
        return;
      }
      out.push(...rejectUnknownKeys(bk, ["name", "bps", ...extra], bp));
      if (typeof bk.name !== "string" || !NAME_RE.test(bk.name)) out.push(diag("CORE_TYPE_ERROR", `${bp}.name`, String(bk.name)));
      else if (names.includes(bk.name)) out.push(diag("ALLOC_DUPLICATE_NAME", `${bp}.name`, bk.name));
      else names.push(bk.name);
      const v = bps(bk.bps, `${bp}.bps`);
      if (v === undefined) complete = false;
      else total += v;
      each?.(bk, bp);
    });
    if (complete && total !== BPS_TOTAL) out.push(diag("ALLOC_SUM_MISMATCH", p, `${total}bps`));
    return names;
  };

  const pool = (v: Obj, p: string): void => {
    if (v.mode === undefined) {
      out.push(diag("ALLOC_MODE_REQUIRED", `${p}.mode`));
      return;
    }
    enumCheck("pool_mode", v.mode, `${p}.mode`);
    const need = (k: string) => {
      if (v[k] === undefined) out.push(diag("ALLOC_MODE_REQUIRED", `${p}.${k}`, `required for ${String(v.mode)}`));
      else bps(v[k], `${p}.${k}`);
    };
    const forbid = (k: string) => {
      if (v[k] !== undefined) out.push(diag("CORE_TYPE_ERROR", `${p}.${k}`, `not allowed for ${String(v.mode)}`));
    };
    switch (v.mode) {
      case "MEMBER_PCT":
      case "FIXED":
        forbid("fixed");
        forbid("usage");
        forbid("featured_weight");
        break;
      case "USAGE_WEIGHTED":
        need("featured_weight");
        forbid("fixed");
        forbid("usage");
        break;
      case "HYBRID": {
        need("featured_weight");
        need("fixed");
        need("usage");
        const f = silentBps(v.fixed);
        const u = silentBps(v.usage);
        if (f !== undefined && u !== undefined && f + u !== BPS_TOTAL) {
          out.push(diag("ALLOC_WEIGHT_MISMATCH", p, `fixed + usage = ${f + u}bps`));
        }
        break;
      }
    }
  };

  const vector = (v: unknown, p: string): void => {
    if (!obj(v, p)) return;
    if (!isEnumValue("vector_fn", v.fn)) {
      out.push(diag("CORE_ENUM_UNKNOWN", `${p}.fn`, String(v.fn)));
      return;
    }
    out.push(...rejectUnknownKeys(v, VECTOR_KEYS[v.fn], p));
    switch (v.fn) {
      case "graph":
        enumCheck("claimant_role", v.role, `${p}.role`);
        if (v.via_mandate !== undefined && typeof v.via_mandate !== "boolean") out.push(diag("CORE_TYPE_ERROR", `${p}.via_mandate`));
        break;
      case "contract":
        if (!isId(v.party)) out.push(diag("CORE_TYPE_ERROR", `${p}.party`, String(v.party)));
        break;
      case "member_pct":
        break;
      case "performance_pool":
        pool(v, p);
        break;
      case "mix": {
        if (!Array.isArray(v.parts) || v.parts.length === 0) {
          out.push(diag("CORE_TYPE_ERROR", `${p}.parts`, "non-empty array required"));
          break;
        }
        let total = 0;
        let complete = true;
        v.parts.forEach((part: unknown, i: number) => {
          const pp = `${p}.parts[${i}]`;
          if (!obj(part, pp)) {
            complete = false;
            return;
          }
          out.push(...rejectUnknownKeys(part, ["weight", "of"], pp));
          const w = bps(part.weight, `${pp}.weight`);
          if (w === undefined) complete = false;
          else total += w;
          vector(part.of, `${pp}.of`);
        });
        if (complete && total !== BPS_TOTAL) out.push(diag("ALLOC_WEIGHT_MISMATCH", `${p}.parts`, `${total}bps`));
        break;
      }
      case "cap":
        if (bps(v.max, `${p}.max`) === 0) out.push(diag("ALLOC_INFEASIBLE", `${p}.max`, "0bps"));
        vector(v.of, `${p}.of`);
        break;
      case "floor_guarantee":
        bps(v.min, `${p}.min`);
        vector(v.of, `${p}.of`);
        break;
    }
  };

  const b = d.body;
  out.push(...rejectUnknownKeys(b, ["scope", "bind", "tier1", "tier2", "rounding"], "$.body"));

  if (obj(b.scope, "$.body.scope")) {
    const s = b.scope;
    out.push(...rejectUnknownKeys(s, ["pack", "events", "currency"], "$.body.scope"));
    if (!isId(s.pack)) out.push(diag("CORE_TYPE_ERROR", "$.body.scope.pack", String(s.pack)));
    if (!Array.isArray(s.events) || s.events.length === 0) {
      out.push(diag("CORE_TYPE_ERROR", "$.body.scope.events", "non-empty array required"));
    } else {
      s.events.forEach((e: unknown, i: number) => enumCheck("event_type", e, `$.body.scope.events[${i}]`));
      if (new Set(s.events).size !== s.events.length) out.push(diag("CORE_TYPE_ERROR", "$.body.scope.events", "duplicate event type"));
    }
    if (typeof s.currency !== "string" || !CURRENCY_RE.test(s.currency)) out.push(diag("CORE_TYPE_ERROR", "$.body.scope.currency", String(s.currency)));
  }
  if (obj(b.bind, "$.body.bind")) {
    out.push(...rejectUnknownKeys(b.bind, ["time"], "$.body.bind"));
    enumCheck("binding_time", b.bind.time, "$.body.bind.time");
  }
  if (obj(b.tier1, "$.body.tier1")) {
    out.push(...rejectUnknownKeys(b.tier1, ["buckets", "rights"], "$.body.tier1"));
    const names = buckets(b.tier1.buckets, "$.body.tier1.buckets", []);
    if (typeof b.tier1.rights !== "string" || !names.includes(b.tier1.rights)) {
      out.push(diag("CORE_UNKNOWN_REF", "$.body.tier1.rights", String(b.tier1.rights)));
    }
  }
  if (obj(b.tier2, "$.body.tier2")) {
    out.push(...rejectUnknownKeys(b.tier2, ["split"], "$.body.tier2"));
    buckets(b.tier2.split, "$.body.tier2.split", ["role", "vector"], (bk, bp) => {
      enumCheck("claimant_role", bk.role, `${bp}.role`);
      vector(bk.vector, `${bp}.vector`);
    });
  }
  if (obj(b.rounding, "$.body.rounding")) {
    out.push(...rejectUnknownKeys(b.rounding, ["method", "tie"], "$.body.rounding"));
    enumCheck("rounding_method", b.rounding.method, "$.body.rounding.method");
    if (b.rounding.tie !== "party_id_asc") out.push(diag("CORE_TYPE_ERROR", "$.body.rounding.tie", String(b.rounding.tie)));
  }
  return out;
}
```

`spec/schema/allocation.ir.schema.json` (합·모드별 필수 인자는 스키마로 표현할 수 없어 코드 검증기만 검사한다):
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mdrl.invalid/1.0/allocation.ir.schema.json",
  "title": "MDRL allocation IR document",
  "type": "object",
  "allOf": [{ "$ref": "envelope.schema.json" }],
  "properties": {
    "module": { "const": "allocation" },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": ["scope", "bind", "tier1", "tier2", "rounding"],
      "properties": {
        "scope": {
          "type": "object", "additionalProperties": false, "required": ["pack", "events", "currency"],
          "properties": {
            "pack": { "$ref": "#/$defs/id" },
            "events": { "type": "array", "minItems": 1, "uniqueItems": true, "items": { "enum": ["PRIMARY", "RESALE", "TRAFFIC"] } },
            "currency": { "type": "string", "pattern": "^[A-Z]{3}$" }
          }
        },
        "bind": {
          "type": "object", "additionalProperties": false, "required": ["time"],
          "properties": { "time": { "enum": ["ISSUE_TIME", "USAGE_TIME", "SALE_TIME", "REPORT_PERIOD"] } }
        },
        "tier1": {
          "type": "object", "additionalProperties": false, "required": ["buckets", "rights"],
          "properties": {
            "buckets": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/tier1Bucket" } },
            "rights": { "$ref": "#/$defs/name" }
          }
        },
        "tier2": {
          "type": "object", "additionalProperties": false, "required": ["split"],
          "properties": { "split": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/splitBucket" } } }
        },
        "rounding": {
          "type": "object", "additionalProperties": false, "required": ["method", "tie"],
          "properties": { "method": { "enum": ["HIERARCHICAL_LRM_V1"] }, "tie": { "const": "party_id_asc" } }
        }
      }
    }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$" },
    "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
    "bps": { "type": "string", "pattern": "^(0|[1-9][0-9]{0,3}|10000)$" },
    "role": {
      "enum": [
        "MASTER_OWNER", "WORK_AUTHOR", "CMO", "PERFORMER_FEATURED",
        "PERFORMER_NON_FEATURED", "AGENCY", "AI_PROVIDER", "RECORDING_CONTRIBUTOR"
      ]
    },
    "tier1Bucket": {
      "type": "object", "additionalProperties": false, "required": ["name", "bps"],
      "properties": { "name": { "$ref": "#/$defs/name" }, "bps": { "$ref": "#/$defs/bps" } }
    },
    "splitBucket": {
      "type": "object", "additionalProperties": false, "required": ["name", "bps", "role", "vector"],
      "properties": {
        "name": { "$ref": "#/$defs/name" },
        "bps": { "$ref": "#/$defs/bps" },
        "role": { "$ref": "#/$defs/role" },
        "vector": { "$ref": "#/$defs/vector" }
      }
    },
    "vector": {
      "oneOf": [
        {
          "type": "object", "additionalProperties": false, "required": ["fn", "role"],
          "properties": { "fn": { "const": "graph" }, "role": { "$ref": "#/$defs/role" }, "via_mandate": { "type": "boolean" } }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["fn", "party"],
          "properties": { "fn": { "const": "contract" }, "party": { "$ref": "#/$defs/id" } }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["fn"],
          "properties": { "fn": { "const": "member_pct" } }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["fn", "mode"],
          "properties": {
            "fn": { "const": "performance_pool" },
            "mode": { "enum": ["USAGE_WEIGHTED", "FIXED", "HYBRID", "MEMBER_PCT"] },
            "fixed": { "$ref": "#/$defs/bps" },
            "usage": { "$ref": "#/$defs/bps" },
            "featured_weight": { "$ref": "#/$defs/bps" }
          }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["fn", "parts"],
          "properties": {
            "fn": { "const": "mix" },
            "parts": {
              "type": "array", "minItems": 1,
              "items": {
                "type": "object", "additionalProperties": false, "required": ["weight", "of"],
                "properties": { "weight": { "$ref": "#/$defs/bps" }, "of": { "$ref": "#/$defs/vector" } }
              }
            }
          }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["fn", "max", "of"],
          "properties": { "fn": { "const": "cap" }, "max": { "$ref": "#/$defs/bps" }, "of": { "$ref": "#/$defs/vector" } }
        },
        {
          "type": "object", "additionalProperties": false, "required": ["fn", "min", "of"],
          "properties": { "fn": { "const": "floor_guarantee" }, "min": { "$ref": "#/$defs/bps" }, "of": { "$ref": "#/$defs/vector" } }
        }
      ]
    }
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --test test/allocation/validate.test.ts && npm test && npx tsc -p tsconfig.json`
Expected: 전부 PASS. tsc가 `ajv/dist/2020.js` 타입 import에서 오류를 내면, 같은 줄을 `test/facts/structure.test.ts`의 기존 방식과 똑같이 맞춘다.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/allocation/validate.ts 04_구현_소스코드/mdrl/spec/schema/allocation.ir.schema.json 04_구현_소스코드/mdrl/conformance/allocation/001-basic/input.json 04_구현_소스코드/mdrl/test/helpers.ts 04_구현_소스코드/mdrl/test/allocation/validate.test.ts && git commit -m "$(printf 'feat(mdrl): 안분 정책 정적 검증과 allocation 스키마\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 5: 벡터 식 평가 (evalVector)

**Files:**
- Create: `src/allocation/expr.ts`
- Test: `test/allocation/expr.test.ts`

**Interfaces:**
- Consumes: `parseBps`; `MdrlError`, `fail`; `ONE`, `fromBps`; `Instant`; `ROLE_RIGHT`, `routeVector` (facts/mandate.ts); `PartyVector`; `ClaimantRole`, `FactsDocument`; `VectorExpr`; Task 3의 `capVector`, `fixedVector`, `floorGuarantee`, `mixVectors`, `usageVector`
- Produces: `type ExprContext = { facts: FactsDocument; parties: ReadonlySet<string>; vectors: Partial<Record<ClaimantRole, PartyVector>>; members: PartyVector; asOf: Instant; knownAt: Instant }`, `evalVector(e: VectorExpr, ctx: ExprContext, path: string): PartyVector` (실패 시 `MdrlError`를 던진다)

**의미:** `graph(role)` = 조합 지분 벡터(없으면 `ALLOC_EMPTY_VECTOR`). `via_mandate: true`면 `routeVector`로 위임 라우팅(`ROLE_RIGHT`에 없는 역할이면 `CORE_TYPE_ERROR`). `contract(party)` = 그 party 100%(facts에 없으면 `FACTS_UNKNOWN_PARTY`). `member_pct` = 스냅샷 멤버 비율. `performance_pool`: MEMBER_PCT = 멤버 비율, FIXED = 멤버 균등, USAGE_WEIGHTED = `usageVector(F, N, featured_weight)`, HYBRID = `fixed·FIXED + usage·USAGE`. `mix`, `cap`, `floor_guarantee`(영역에 스냅샷 멤버 포함)는 Task 3 함수 그대로.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/allocation/expr.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalVector, type ExprContext } from "../../src/allocation/expr.ts";
import type { VectorExpr } from "../../src/allocation/types.ts";
import { projectVectors } from "../../src/facts/project.ts";
import { ONE, ratio } from "../../src/core/ratio.ts";
import { MdrlError } from "../../src/core/errors.ts";
import { loadBasic } from "../helpers.ts";

const r = (n: bigint, d: bigint) => ratio(n, d);
const code = (c: string) => (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === c;

function ctx(): ExprContext {
  const i = loadBasic();
  const p = projectVectors(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(p.ok);
  return {
    facts: i.facts,
    parties: new Set(i.facts.body.parties.map((x) => x.id)),
    vectors: p.value.vectors,
    members: { pty_member_a: r(1n, 2n), pty_member_b: r(1n, 2n) },
    asOf: i.as_of,
    knownAt: i.known_at,
  };
}
const ev = (e: unknown, c: ExprContext = ctx()) => evalVector(e as VectorExpr, c, "$.v");

test("graph uses the projection vector, optionally routed through mandates", () => {
  assert.deepEqual(ev({ fn: "graph", role: "MASTER_OWNER" }), { pty_label_x: ONE });
  assert.deepEqual(ev({ fn: "graph", role: "WORK_AUTHOR", via_mandate: true }), { pty_author_c: r(2n, 5n), pty_komca: r(3n, 5n) });
  assert.throws(() => ev({ fn: "graph", role: "RECORDING_CONTRIBUTOR" }), code("ALLOC_EMPTY_VECTOR"));
  const c = ctx();
  c.vectors.AI_PROVIDER = { pty_member_a: ONE };
  assert.throws(() => ev({ fn: "graph", role: "AI_PROVIDER", via_mandate: true }, c), code("CORE_TYPE_ERROR"));
});

test("contract and member_pct", () => {
  assert.deepEqual(ev({ fn: "contract", party: "pty_agency_s" }), { pty_agency_s: ONE });
  assert.throws(() => ev({ fn: "contract", party: "pty_ghost" }), code("FACTS_UNKNOWN_PARTY"));
  assert.deepEqual(ev({ fn: "member_pct" }), { pty_member_a: r(1n, 2n), pty_member_b: r(1n, 2n) });
});

test("performance_pool modes", () => {
  const half = { pty_member_a: r(1n, 2n), pty_member_b: r(1n, 2n) };
  assert.deepEqual(ev({ fn: "performance_pool", mode: "MEMBER_PCT" }), half);
  assert.deepEqual(ev({ fn: "performance_pool", mode: "FIXED" }), half);
  assert.deepEqual(ev({ fn: "performance_pool", mode: "USAGE_WEIGHTED", featured_weight: "7000" }), {
    pty_member_a: r(2n, 3n), pty_member_b: r(1n, 3n),
  });
  assert.deepEqual(ev({ fn: "performance_pool", mode: "HYBRID", fixed: "4000", usage: "6000", featured_weight: "7000" }), {
    pty_member_a: r(3n, 5n), pty_member_b: r(2n, 5n),
  });
});

test("mix, cap and floor_guarantee compose", () => {
  assert.deepEqual(
    ev({ fn: "mix", parts: [{ weight: "5000", of: { fn: "graph", role: "MASTER_OWNER" } }, { weight: "5000", of: { fn: "contract", party: "pty_komca" } }] }),
    { pty_komca: r(1n, 2n), pty_label_x: r(1n, 2n) },
  );
  assert.deepEqual(ev({ fn: "cap", max: "6000", of: { fn: "performance_pool", mode: "USAGE_WEIGHTED", featured_weight: "7000" } }), {
    pty_member_a: r(3n, 5n), pty_member_b: r(2n, 5n),
  });
  assert.deepEqual(ev({ fn: "floor_guarantee", min: "1000", of: { fn: "graph", role: "MASTER_OWNER" } }), {
    pty_label_x: r(4n, 5n), pty_member_a: r(1n, 10n), pty_member_b: r(1n, 10n),
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/allocation/expr.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/allocation/expr.ts`).

- [ ] **Step 3: 구현**

`src/allocation/expr.ts`:
```ts
import { parseBps } from "../core/bps.ts";
import { MdrlError, fail } from "../core/errors.ts";
import { ONE, fromBps, type Ratio } from "../core/ratio.ts";
import type { Instant } from "../core/time.ts";
import { ROLE_RIGHT, routeVector } from "../facts/mandate.ts";
import type { PartyVector } from "../facts/project.ts";
import type { ClaimantRole, FactsDocument } from "../facts/types.ts";
import type { VectorExpr } from "./types.ts";
import { capVector, fixedVector, floorGuarantee, mixVectors, usageVector } from "./vectors.ts";

export type ExprContext = {
  facts: FactsDocument;
  parties: ReadonlySet<string>;
  vectors: Partial<Record<ClaimantRole, PartyVector>>;
  members: PartyVector;
  asOf: Instant;
  knownAt: Instant;
};

type PoolExpr = Extract<VectorExpr, { fn: "performance_pool" }>;

const bps = (v: unknown, path: string): Ratio => fromBps(parseBps(v, path));

/** 벡터 식을 평가한다. 정책은 validateAllocation을 통과했다고 가정하며, 실패는 MdrlError로 던진다. */
export function evalVector(e: VectorExpr, ctx: ExprContext, path: string): PartyVector {
  switch (e.fn) {
    case "graph":
      return graphVector(e.role, e.via_mandate === true, ctx, path);
    case "contract":
      if (!ctx.parties.has(e.party)) return fail("FACTS_UNKNOWN_PARTY", `${path}.party`, e.party);
      return { [e.party]: ONE };
    case "member_pct":
      return ctx.members;
    case "performance_pool":
      return poolVector(e, ctx, path);
    case "mix":
      return mixVectors(e.parts.map((p, i) => ({
        weight: bps(p.weight, `${path}.parts[${i}].weight`),
        vec: evalVector(p.of, ctx, `${path}.parts[${i}].of`),
      })));
    case "cap":
      return capVector(evalVector(e.of, ctx, `${path}.of`), bps(e.max, `${path}.max`), path);
    case "floor_guarantee":
      return floorGuarantee(evalVector(e.of, ctx, `${path}.of`), Object.keys(ctx.members), bps(e.min, `${path}.min`), path);
  }
}

function graphVector(role: ClaimantRole, viaMandate: boolean, ctx: ExprContext, path: string): PartyVector {
  const vec = ctx.vectors[role];
  if (vec === undefined) return fail("ALLOC_EMPTY_VECTOR", path, `no ${role} vector in projection`);
  if (!viaMandate) return vec;
  const right = ROLE_RIGHT[role];
  if (right === undefined) return fail("CORE_TYPE_ERROR", `${path}.via_mandate`, `${role} has no mandate right`);
  const routed = routeVector(ctx.facts, vec, right, ctx.asOf, ctx.knownAt);
  if (!routed.ok) throw new MdrlError(routed.errors);
  return routed.value;
}

function poolVector(e: PoolExpr, ctx: ExprContext, path: string): PartyVector {
  const fixed = () => fixedVector(Object.keys(ctx.members), path);
  const usage = () => usageVector(
    ctx.vectors.PERFORMER_FEATURED, ctx.vectors.PERFORMER_NON_FEATURED, bps(e.featured_weight, `${path}.featured_weight`), path,
  );
  switch (e.mode) {
    case "MEMBER_PCT":
      return ctx.members;
    case "FIXED":
      return fixed();
    case "USAGE_WEIGHTED":
      return usage();
    case "HYBRID":
      return mixVectors([
        { weight: bps(e.fixed, `${path}.fixed`), vec: fixed() },
        { weight: bps(e.usage, `${path}.usage`), vec: usage() },
      ]);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/allocation/expr.test.ts && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/allocation/expr.ts 04_구현_소스코드/mdrl/test/allocation/expr.test.ts && git commit -m "$(printf 'feat(mdrl): 안분 벡터 식 평가\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 6: 결정적 평가기 (evaluate)

**Files:**
- Create: `src/allocation/evaluate.ts`
- Modify: `test/helpers.ts`
- Test: `test/allocation/evaluate.test.ts`

**Interfaces:**
- Consumes: `validateAllocation` (T4), `evalVector`, `ExprContext` (T5), `splitLrm`, `Allotment`, `Share` (T2), `parseVector` (T3), `projectToIr`, `ProjectionIr` (facts/result.ts), `HOLD`, `PartyVector`, `digestOf`, `attempt`, `diag`, `err`, `ok`, `fail`, `isEnumValue`, `isPlainObject`, `isId`, `rejectUnknownKeys`, `fromBps`, `formatRatio`, `parseBps`, allocation 타입들
- Produces: `type EvaluationInput = { policy: AllocationDocument; facts: FactsDocument; projection: ProjectionIr; snapshot: Snapshot; events: RevenueEvent[]; runId: string }`, `evaluate(input: EvaluationInput): Result<AllocationResult>`; helper `evaluationInput(c: AllocationCase): EvaluationInput`

**평가 순서와 규칙 (스펙 12.24~12.28로 기록):**
1. `validateAllocation(policy)` 실패 시 그대로 반환.
2. 결합 검사: `run_id`는 id 형식. `policy.depends_on`에 `{ ref: "vc:facts/<facts.id>@<facts.version>", digest: digestOf(facts) }`가 있어야 하고, `projection.facts_digest === digestOf(facts)`, `projection.digest === digestOf({ ...projection, digest: undefined })`(아니면 `CORE_DIGEST_MISMATCH`).
3. 이벤트: 비어 있지 않은 배열, 알 수 없는 키 거부, id 엄격 오름차순(아니면 `CORE_TYPE_ERROR` "not sorted by id"), type은 event_type이며 `scope.events` 안(아니면 `ALLOC_SCOPE_MISMATCH`), amount `^[1-9]\d*$`, currency = `scope.currency`(아니면 `ALLOC_SCOPE_MISMATCH`), integrity는 integrity_status.
4. 스냅샷 `members`는 `parseVector`(합 1). 키는 facts의 party여야 한다(`FACTS_UNKNOWN_PARTY`).
5. 조합 지분 벡터(문자열)를 `parseVector`로 파싱한다. 역할 키는 claimant_role이어야 한다.
6. 커버리지: `@hold`·0이 아닌 party가 있는 조합 지분 역할마다 그 역할을 다루는 버킷이 있어야 한다. `graph(role)`은 그 역할을, `performance_pool`·`member_pct`는 PERFORMER_FEATURED·PERFORMER_NON_FEATURED를 다룬다. `mix`·`cap`·`floor_guarantee`는 하위 식을 따른다. 없으면 `ALLOC_UNCOVERED_CLAIMANT`(detail = 역할).
7. 버킷 벡터는 이벤트와 무관하므로 한 번만 평가한다.
8. 이벤트마다: tier1을 `splitLrm`(키 = 버킷 이름)으로 나눠 모든 tier1 버킷의 pool_line을 기록(0 포함). integrity가 FLAGGED면 권리자 풀 전액을 `holding(bucket = tier1.rights, reason = FRAUD_REVIEW)`로 보내고 끝. 아니면 권리자 풀을 tier2로 나누고(키 = 버킷 이름), 각 버킷 금액을 버킷 벡터로 나눈다(키 = party id, `@hold` 포함). `@hold` 몫은 `holding(reason = RIGHTS_DISPUTE)`, 나머지는 line. 금액 0인 line·holding은 만들지 않는다(trace에는 남는다).
9. line의 role: party kind가 CMO·AGENCY면 그 kind, 아니면 버킷 role. `line_seq`는 `"1"`.
10. trace: 층마다 `{ event_id, level: "tier1" | "tier2" | "bucket:<name>", total, parts: [{ key, weight: "n/d", amount }] }`.
11. 결과: `{ run_id, policy_digest: digestOf(policy), projection_digest: projection.digest, snapshot_digest: digestOf(snapshot), events_digest: digestOf(events), bind_time, pool_lines, lines, holdings, trace }`에 `result_digest = digestOf(그 객체)`를 붙인다.

- [ ] **Step 1: 헬퍼 추가**

`test/helpers.ts` — import 묶음에 추가:
```ts
import type { EvaluationInput } from "../src/allocation/evaluate.ts";
import { projectToIr } from "../src/facts/result.ts";
```
파일 끝에 추가:
```ts
/** 할당 케이스의 facts 케이스로 조합 지분 IR을 만들어 평가기 입력을 구성한다. */
export function evaluationInput(c: AllocationCase): EvaluationInput {
  const f = loadFactsCase(c.facts_case);
  const p = projectToIr(f.facts, f.usage, f.as_of, f.known_at);
  if (!p.ok) throw new Error(p.errors.map((e) => e.code).join(","));
  return { policy: c.policy, facts: f.facts, projection: p.value, snapshot: c.snapshot, events: c.events, runId: c.run_id };
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/allocation/evaluate.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type EvaluationInput } from "../../src/allocation/evaluate.ts";
import type { AllocationResult } from "../../src/allocation/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import { evaluationInput, loadAllocationCase, loadFactsCase } from "../helpers.ts";

const basic = () => evaluationInput(loadAllocationCase());
function run(i: EvaluationInput): AllocationResult {
  const r = evaluate(i);
  assert.ok(r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return r.value;
}
const codes = (i: EvaluationInput) => {
  const r = evaluate(i);
  return r.ok ? [] : r.errors.map((e) => e.code).sort();
};
const linesOf = (res: AllocationResult, ev: string) =>
  res.lines.filter((l) => l.event_id === ev).map((l) => [l.bucket, l.party, l.role, l.amount]);

test("basic event: tier1, tier2 and party lines (hand-computed)", () => {
  const res = run(basic());
  assert.deepEqual(res.pool_lines.filter((l) => l.event_id === "ev_001").map((l) => [l.bucket, l.amount]), [
    ["platform", "2500"], ["ops", "500"], ["rights", "7000"],
  ]);
  assert.deepEqual(linesOf(res, "ev_001"), [
    ["master", "pty_label_x", "MASTER_OWNER", "3150"],
    ["performer", "pty_member_a", "PERFORMER_FEATURED", "1890"],
    ["performer", "pty_member_b", "PERFORMER_FEATURED", "1260"],
    ["work", "pty_author_c", "WORK_AUTHOR", "280"],
    ["work", "pty_komca", "CMO", "420"],
  ]);
  assert.deepEqual(res.holdings, []);
});

test("rounding event 1001: remainders follow HIERARCHICAL_LRM_V1", () => {
  const res = run(basic());
  assert.deepEqual(res.pool_lines.filter((l) => l.event_id === "ev_002").map((l) => l.amount), ["250", "50", "701"]);
  assert.deepEqual(linesOf(res, "ev_002").map((l) => l[3]), ["316", "189", "126", "28", "42"]);
});

test("money is conserved per event", () => {
  const res = run(basic());
  for (const ev of basic().events) {
    const pool = res.pool_lines.filter((l) => l.event_id === ev.id);
    assert.equal(pool.reduce((a, l) => a + BigInt(l.amount), 0n), BigInt(ev.amount));
    const rights = BigInt(pool.find((l) => l.bucket === "rights")!.amount);
    const paid = [...res.lines, ...res.holdings].filter((l) => l.event_id === ev.id).reduce((a, l) => a + BigInt(l.amount), 0n);
    assert.equal(paid, rights);
  }
});

test("result is deterministic and self-digested", () => {
  const a = run(basic());
  assert.equal(a.result_digest, run(basic()).result_digest);
  assert.equal(a.result_digest, digestOf({ ...a, result_digest: undefined }));
  assert.equal(a.policy_digest, digestOf(basic().policy));
});

test("disputed master share is held as RIGHTS_DISPUTE", () => {
  const c = loadAllocationCase();
  c.facts_case = "002-disputed-master";
  c.policy.depends_on[0]!.digest = digestOf(loadFactsCase("002-disputed-master").facts);
  const res = run(evaluationInput(c));
  assert.deepEqual(res.holdings, [
    { event_id: "ev_001", bucket: "master", reason: "RIGHTS_DISPUTE", amount: "3150" },
    { event_id: "ev_002", bucket: "master", reason: "RIGHTS_DISPUTE", amount: "316" },
  ]);
  assert.equal(res.lines.some((l) => l.bucket === "master"), false);
});

test("flagged event holds the whole rights pool as FRAUD_REVIEW", () => {
  const i = basic();
  i.events[0]!.integrity = "FLAGGED";
  const res = run(i);
  assert.deepEqual(res.holdings, [{ event_id: "ev_001", bucket: "rights", reason: "FRAUD_REVIEW", amount: "7000" }]);
  assert.equal(linesOf(res, "ev_001").length, 0);
  assert.equal(res.pool_lines.filter((l) => l.event_id === "ev_001").length, 3);
});

test("binding checks: digests", () => {
  const i = basic();
  i.projection = { ...i.projection, facts_digest: digestOf({ other: "x" }) };
  assert.ok(codes(i).includes("CORE_DIGEST_MISMATCH"));
  const j = basic();
  j.policy.depends_on[0]!.digest = digestOf({ other: "x" });
  assert.deepEqual(codes(j), ["CORE_DIGEST_MISMATCH"]);
  const k = basic();
  k.projection = { ...k.projection, as_of: "2026-07-01T00:00:00.000Z" };
  assert.deepEqual(codes(k), ["CORE_DIGEST_MISMATCH"]);
});

test("event checks: scope, currency, order, amount", () => {
  const i = basic();
  i.events[0]!.type = "TRAFFIC";
  i.events[1]!.currency = "USD";
  assert.deepEqual(codes(i), ["ALLOC_SCOPE_MISMATCH", "ALLOC_SCOPE_MISMATCH"]);
  const j = basic();
  j.events.reverse();
  assert.deepEqual(codes(j), ["CORE_TYPE_ERROR"]);
  const k = basic();
  k.events[0]!.amount = "0";
  assert.deepEqual(codes(k), ["CORE_TYPE_ERROR"]);
});

test("snapshot members must be parties and sum to 1", () => {
  const i = basic();
  i.snapshot = { members: { pty_member_a: "1/2", pty_ghost: "1/2" } };
  assert.deepEqual(codes(i), ["FACTS_UNKNOWN_PARTY"]);
  const j = basic();
  j.snapshot = { members: { pty_member_a: "1/2" } };
  assert.deepEqual(codes(j), ["ALLOC_WEIGHT_MISMATCH"]);
});

test("coverage and empty vectors", () => {
  const i = basic();
  i.policy.body.tier2.split = [
    { ...i.policy.body.tier2.split[0]!, bps: "5500" },
    i.policy.body.tier2.split[1]!,
  ];
  assert.deepEqual(codes(i), ["ALLOC_UNCOVERED_CLAIMANT"]);
  const j = basic();
  j.policy.body.tier2.split[0]!.vector = { fn: "graph", role: "RECORDING_CONTRIBUTOR" };
  assert.deepEqual(codes(j), ["ALLOC_EMPTY_VECTOR", "ALLOC_UNCOVERED_CLAIMANT"]);
});

test("invalid policy short-circuits", () => {
  const i = basic();
  i.policy.body.tier1.buckets[0]!.bps = "2600";
  assert.deepEqual(codes(i), ["ALLOC_SUM_MISMATCH"]);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/allocation/evaluate.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/allocation/evaluate.ts`).

- [ ] **Step 4: 구현**

`src/allocation/evaluate.ts`:
```ts
import { parseBps } from "../core/bps.ts";
import { digestOf } from "../core/digest.ts";
import { isEnumValue } from "../core/enums.ts";
import { attempt, diag, err, fail, ok, type Diagnostic, type Result } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { formatRatio, fromBps } from "../core/ratio.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";
import { HOLD, type PartyVector } from "../facts/project.ts";
import type { ProjectionIr } from "../facts/result.ts";
import type { ClaimantRole, FactsDocument } from "../facts/types.ts";
import { evalVector, type ExprContext } from "./expr.ts";
import { splitLrm, type Allotment, type Share } from "./lrm.ts";
import type {
  AllocationBody, AllocationDocument, AllocationLine, AllocationResult, Holding, PoolLine,
  RevenueEvent, Snapshot, SplitBucket, TraceEntry, VectorExpr,
} from "./types.ts";
import { validateAllocation } from "./validate.ts";
import { parseVector } from "./vectors.ts";

export type EvaluationInput = {
  policy: AllocationDocument;
  facts: FactsDocument;
  projection: ProjectionIr;
  snapshot: Snapshot;
  events: RevenueEvent[];
  runId: string;
};

type Output = { pool_lines: PoolLine[]; lines: AllocationLine[]; holdings: Holding[]; trace: TraceEntry[] };
type Vectors = Partial<Record<ClaimantRole, PartyVector>>;

const AMOUNT_RE = /^[1-9]\d*$/;
const EVENT_KEYS = ["id", "type", "amount", "currency", "integrity"] as const;
const PERFORMER_ROLES: readonly ClaimantRole[] = ["PERFORMER_FEATURED", "PERFORMER_NON_FEATURED"];

/** 결정적 안분 평가기(스펙 5.6). 같은 입력은 같은 result_digest를 낸다. */
export function evaluate(input: EvaluationInput): Result<AllocationResult> {
  const { policy, facts, projection, snapshot, events, runId } = input;
  const policyErrors = validateAllocation(policy);
  if (policyErrors.length > 0) return err(policyErrors);
  const body = policy.body;
  const parties = new Set(facts.body.parties.map((p) => p.id));
  const kinds = new Map(facts.body.parties.map((p) => [p.id, p.kind]));

  const errors: Diagnostic[] = [];
  if (!isId(runId)) errors.push(diag("CORE_TYPE_ERROR", "$.run_id", String(runId)));
  errors.push(...checkDigests(policy, facts, projection), ...checkEvents(events, body));
  const members = attempt(() => parseVector(snapshot.members, "$.snapshot.members"));
  if (!members.ok) errors.push(...members.errors);
  else for (const k of Object.keys(members.value)) if (!parties.has(k)) errors.push(diag("FACTS_UNKNOWN_PARTY", `$.snapshot.members.${k}`, k));
  const vectors = attempt(() => parseProjectionVectors(projection));
  if (!vectors.ok) errors.push(...vectors.errors);
  if (!members.ok || !vectors.ok || errors.length > 0) return err(errors);

  errors.push(...checkCoverage(body.tier2.split, vectors.value));
  const ctx: ExprContext = {
    facts, parties, vectors: vectors.value, members: members.value, asOf: projection.as_of, knownAt: projection.known_at,
  };
  const bucketVectors: PartyVector[] = [];
  body.tier2.split.forEach((b, i) => {
    const r = attempt(() => evalVector(b.vector, ctx, `$.body.tier2.split[${i}].vector`));
    if (r.ok) bucketVectors.push(r.value);
    else errors.push(...r.errors);
  });
  if (errors.length > 0) return err(errors);

  const out: Output = { pool_lines: [], lines: [], holdings: [], trace: [] };
  const allocated = attempt(() => {
    for (const ev of events) allocateEvent(ev, body, bucketVectors, kinds, out);
  });
  if (!allocated.ok) return err(allocated.errors);
  const result = {
    run_id: runId,
    policy_digest: digestOf(policy),
    projection_digest: projection.digest,
    snapshot_digest: digestOf(snapshot),
    events_digest: digestOf(events),
    bind_time: body.bind.time,
    ...out,
  };
  return ok({ ...result, result_digest: digestOf(result) });
}

function checkDigests(policy: AllocationDocument, facts: FactsDocument, projection: ProjectionIr): Diagnostic[] {
  const out: Diagnostic[] = [];
  const factsDigest = digestOf(facts);
  const factsRef = `vc:facts/${facts.id}@${facts.version}`;
  if (!policy.depends_on.some((d) => d.ref === factsRef && d.digest === factsDigest)) {
    out.push(diag("CORE_DIGEST_MISMATCH", "$.policy.depends_on", `${factsRef} ${factsDigest}`));
  }
  if (projection.facts_digest !== factsDigest) out.push(diag("CORE_DIGEST_MISMATCH", "$.projection.facts_digest", factsDigest));
  if (digestOf({ ...projection, digest: undefined }) !== projection.digest) out.push(diag("CORE_DIGEST_MISMATCH", "$.projection.digest"));
  return out;
}

function checkEvents(events: unknown, body: AllocationBody): Diagnostic[] {
  if (!Array.isArray(events) || events.length === 0) return [diag("CORE_TYPE_ERROR", "$.events", "non-empty array required")];
  const out: Diagnostic[] = [];
  let prev: string | undefined;
  events.forEach((e: unknown, i: number) => {
    const p = `$.events[${i}]`;
    if (!isPlainObject(e)) {
      out.push(diag("CORE_TYPE_ERROR", p, "must be an object"));
      return;
    }
    out.push(...rejectUnknownKeys(e, EVENT_KEYS, p));
    if (!isId(e.id)) {
      out.push(diag("CORE_TYPE_ERROR", `${p}.id`, String(e.id)));
    } else {
      if (prev !== undefined && prev >= e.id) out.push(diag("CORE_TYPE_ERROR", "$.events", "not sorted by id"));
      prev = e.id;
    }
    if (!isEnumValue("event_type", e.type)) out.push(diag("CORE_ENUM_UNKNOWN", `${p}.type`, String(e.type)));
    else if (!body.scope.events.includes(e.type)) out.push(diag("ALLOC_SCOPE_MISMATCH", `${p}.type`, e.type));
    if (typeof e.amount !== "string" || !AMOUNT_RE.test(e.amount)) out.push(diag("CORE_TYPE_ERROR", `${p}.amount`, String(e.amount)));
    if (e.currency !== body.scope.currency) out.push(diag("ALLOC_SCOPE_MISMATCH", `${p}.currency`, String(e.currency)));
    if (!isEnumValue("integrity_status", e.integrity)) out.push(diag("CORE_ENUM_UNKNOWN", `${p}.integrity`, String(e.integrity)));
  });
  return out;
}

function parseProjectionVectors(projection: ProjectionIr): Vectors {
  const out: Vectors = {};
  for (const [role, vec] of Object.entries(projection.vectors)) {
    const p = `$.projection.vectors.${role}`;
    if (!isEnumValue("claimant_role", role)) fail("CORE_ENUM_UNKNOWN", p, role);
    out[role] = parseVector(vec, p);
  }
  return out;
}

/** 실제 권리자(`@hold`·가중치 0 제외)가 있는 조합 지분 역할마다 그 역할을 다루는 버킷이 있어야 한다. */
function checkCoverage(split: readonly SplitBucket[], vectors: Vectors): Diagnostic[] {
  const covered = new Set<ClaimantRole>();
  const visit = (e: VectorExpr): void => {
    switch (e.fn) {
      case "graph":
        covered.add(e.role);
        break;
      case "performance_pool":
      case "member_pct":
        for (const r of PERFORMER_ROLES) covered.add(r);
        break;
      case "mix":
        for (const p of e.parts) visit(p.of);
        break;
      case "cap":
      case "floor_guarantee":
        visit(e.of);
        break;
      case "contract":
        break;
    }
  };
  for (const b of split) visit(b.vector);
  const out: Diagnostic[] = [];
  for (const [role, vec] of Object.entries(vectors) as [ClaimantRole, PartyVector][]) {
    const real = Object.entries(vec).some(([k, w]) => k !== HOLD && w.n !== 0n);
    if (real && !covered.has(role)) out.push(diag("ALLOC_UNCOVERED_CLAIMANT", "$.body.tier2.split", role));
  }
  return out;
}

/** 위임 수령인의 역할 규칙(스펙 12.16): CMO·AGENCY는 그 역할, 그 외는 버킷 역할. */
function lineRole(kind: string | undefined, role: ClaimantRole): ClaimantRole {
  return kind === "CMO" || kind === "AGENCY" ? kind : role;
}

function level(out: Output, eventId: string, name: string, total: bigint, shares: readonly Share[]): Allotment[] {
  const parts = splitLrm(total, shares, `$.events.${eventId}.${name}`);
  out.trace.push({
    event_id: eventId,
    level: name,
    total: total.toString(),
    parts: parts.map((p) => ({ key: p.key, weight: formatRatio(p.weight), amount: p.amount.toString() })),
  });
  return parts;
}

function allocateEvent(
  ev: RevenueEvent, body: AllocationBody, bucketVectors: readonly PartyVector[],
  kinds: ReadonlyMap<string, string>, out: Output,
): void {
  const tier1 = level(out, ev.id, "tier1", BigInt(ev.amount), body.tier1.buckets.map((b) => ({ key: b.name, weight: fromBps(parseBps(b.bps)) })));
  for (const a of tier1) out.pool_lines.push({ event_id: ev.id, bucket: a.key, amount: a.amount.toString() });
  const rights = tier1.find((a) => a.key === body.tier1.rights)!.amount;
  if (ev.integrity === "FLAGGED") {
    if (rights > 0n) out.holdings.push({ event_id: ev.id, bucket: body.tier1.rights, reason: "FRAUD_REVIEW", amount: rights.toString() });
    return;
  }
  const tier2 = level(out, ev.id, "tier2", rights, body.tier2.split.map((b) => ({ key: b.name, weight: fromBps(parseBps(b.bps)) })));
  tier2.forEach((bucketAmount, i) => {
    const bucket = body.tier2.split[i]!;
    const shares = Object.entries(bucketVectors[i]!).map(([key, weight]) => ({ key, weight }));
    for (const p of level(out, ev.id, `bucket:${bucket.name}`, bucketAmount.amount, shares)) {
      if (p.amount === 0n) continue;
      if (p.key === HOLD) {
        out.holdings.push({ event_id: ev.id, bucket: bucket.name, reason: "RIGHTS_DISPUTE", amount: p.amount.toString() });
      } else {
        out.lines.push({
          event_id: ev.id, party: p.key, role: lineRole(kinds.get(p.key), bucket.role),
          bucket: bucket.name, line_seq: "1", amount: p.amount.toString(),
        });
      }
    }
  });
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --test test/allocation/evaluate.test.ts && npm test && npx tsc -p tsconfig.json`
Expected: 전부 PASS. "hand-computed" 테스트가 실패하면 기대값을 고치지 말고 평가기를 다시 본다(손계산: tier1 10000 → 2500/500/7000, tier2 7000 → 3150/3150/700, HYBRID = 0.4·(½,½) + 0.6·(⅔,⅓) = (3/5, 2/5), work 위임 라우팅 = (author_c 2/5, komca 3/5)).

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/allocation/evaluate.ts 04_구현_소스코드/mdrl/test/helpers.ts 04_구현_소스코드/mdrl/test/allocation/evaluate.test.ts && git commit -m "$(printf 'feat(mdrl): 결정적 안분 평가기와 결과 IR\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 7: 팩 활성화 판정 (checkActivation · FACTS_DISPUTE_OPEN)

**Files:**
- Create: `src/facts/activation.ts`
- Modify: `src/facts/index.ts`
- Test: `test/facts/activation.test.ts`

**Interfaces:**
- Consumes: `projectVectors`, `HOLD`, `Usage` (project.ts), `deriveClaimants`, `checkClaimantCoverage`, `ClaimantEntry` (mandate.ts), `isEffective` (temporal.ts), `diag`, `Diagnostic`, `Instant`, `FactsDocument`
- Produces: `type ActivationInput = { facts: FactsDocument; usage: Usage; asOf: Instant; knownAt: Instant; declared: readonly ClaimantEntry[] }`, `checkActivation(input: ActivationInput): Diagnostic[]`

**규칙 (스펙 12.20):** 조합 지분 계산이 실패하면 그 오류를 반환한다. 그렇지 않으면 (a) `@hold` 경로 행에 걸린 claim 중 status가 DISPUTED인 것, (b) 유효한 DISPUTED mandate 중 `from`이 조합 지분 벡터(또는 도출 청구권자)의 party인 것을 모아, 하나라도 있으면 `FACTS_DISPUTE_OPEN` 하나(path `$.activation`, detail = 정렬된 id를 `,`로 연결)를 보고한다. 이어서 청구권자 도출과 커버리지 결과를 덧붙인다. 빈 배열이면 활성화할 수 있다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/facts/activation.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkActivation } from "../../src/facts/activation.ts";
import { loadBasic, loadFactsCase, mandateOf, type BasicInput } from "../helpers.ts";

const input = (i: BasicInput) => ({ facts: i.facts, usage: i.usage, asOf: i.as_of, knownAt: i.known_at, declared: i.declared_claimants });

test("a clean pack can be activated", () => {
  assert.deepEqual(checkActivation(input(loadBasic())), []);
});

test("an open master dispute blocks activation with its claim id", () => {
  const d = checkActivation(input(loadFactsCase("002-disputed-master")));
  assert.deepEqual(d.map((x) => [x.code, x.path]), [["FACTS_DISPUTE_OPEN", "$.activation"]]);
  assert.match(d[0]!.message, /c5$/);
});

test("competing disputed claims are all listed", () => {
  const d = checkActivation(input(loadFactsCase("004-competing-dispute")));
  assert.equal(d[0]?.code, "FACTS_DISPUTE_OPEN");
  const ids = d[0]!.message.split(": ")[1]!.split(",");
  assert.ok(ids.length >= 2, d[0]!.message);
});

test("a disputed mandate blocks activation and breaks coverage", () => {
  const i = loadBasic();
  mandateOf(i, "m1").status = "DISPUTED";
  const d = checkActivation(input(i));
  assert.deepEqual(d.map((x) => x.code).sort(), ["FACTS_DISPUTE_OPEN", "FACTS_UNCOVERED_CLAIMANT"]);
  assert.match(d.find((x) => x.code === "FACTS_DISPUTE_OPEN")!.message, /m1$/);
});

test("projection errors are returned as-is", () => {
  const i = loadBasic();
  i.usage = { stm_ghost: "1" };
  assert.deepEqual(checkActivation(input(i)).map((x) => x.code), ["FACTS_USAGE_INVALID"]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/facts/activation.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/facts/activation.ts`).

- [ ] **Step 3: 구현**

`src/facts/activation.ts`:
```ts
import { diag, type Diagnostic } from "../core/errors.ts";
import type { Instant } from "../core/time.ts";
import { checkClaimantCoverage, deriveClaimants, type ClaimantEntry } from "./mandate.ts";
import { HOLD, projectVectors, type Usage } from "./project.ts";
import { isEffective } from "./temporal.ts";
import type { FactsDocument } from "./types.ts";

export type ActivationInput = {
  facts: FactsDocument;
  usage: Usage;
  asOf: Instant;
  knownAt: Instant;
  declared: readonly ClaimantEntry[];
};

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 팩 활성화 판정(스펙 12.20): 사용 스템의 권리 경로에 분쟁 중인 claim·mandate가 있으면 FACTS_DISPUTE_OPEN,
 * 그리고 청구권자 커버리지 결과를 함께 보고한다. 빈 배열이면 활성화할 수 있다.
 */
export function checkActivation(input: ActivationInput): Diagnostic[] {
  const { facts, usage, asOf, knownAt, declared } = input;
  const projection = projectVectors(facts, usage, asOf, knownAt);
  if (!projection.ok) return projection.errors;

  const status = new Map(facts.body.claims.map((c) => [c.id, c.status]));
  const disputedClaims = projection.value.paths
    .filter((r) => r.party === HOLD)
    .flatMap((r) => r.claims)
    .filter((id) => status.get(id) === "DISPUTED");

  const out: Diagnostic[] = [];
  const derived = deriveClaimants(facts, projection.value, asOf, knownAt);
  const involved = new Set([
    ...Object.values(projection.value.vectors).flatMap((v) => Object.keys(v ?? {})),
    ...(derived.ok ? derived.value.map((c) => c.party) : []),
  ]);
  const disputedMandates = facts.body.mandates
    .filter((m) => m.status === "DISPUTED" && isEffective(m, asOf, knownAt) && involved.has(m.from))
    .map((m) => m.id);

  const ids = [...new Set([...disputedClaims, ...disputedMandates])].sort(byKey);
  if (ids.length > 0) out.push(diag("FACTS_DISPUTE_OPEN", "$.activation", ids.join(",")));
  if (!derived.ok) return [...out, ...derived.errors];
  return [...out, ...checkClaimantCoverage(derived.value, declared)];
}
```

`src/facts/index.ts` 끝에 `export * from "./activation.ts";` 추가.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/facts/activation.test.ts && npm test && npx tsc -p tsconfig.json`
Expected: PASS. (`004-competing-dispute`의 선언 청구권자에 따라 커버리지 진단이 뒤따를 수 있다. 이 테스트는 첫 진단이 `FACTS_DISPUTE_OPEN`이고 id가 둘 이상인지만 본다.)

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/facts/activation.ts 04_구현_소스코드/mdrl/src/facts/index.ts 04_구현_소스코드/mdrl/test/facts/activation.test.ts && git commit -m "$(printf 'feat(mdrl): 팩 활성화 판정과 FACTS_DISPUTE_OPEN\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 8: 적합성 스위트 · 속성 테스트 · 패키지 노출 · 스펙 반영

**Files:**
- Create: `src/allocation/index.ts`, `scripts/print-allocation.ts`, `conformance/allocation/001-basic/expected.json`, `conformance/allocation/{002-disputed-master,003-fraud-hold}/{input,expected}.json`, `test/allocation/property.test.ts`
- Modify: `package.json`, `test/conformance.test.ts`, `02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md`

**Interfaces:**
- Consumes: `evaluate`, `EvaluationInput` (T6), `evaluationInput`, `loadAllocationCase`, `loadFactsCase` (helpers), `projectToIr`, `digestOf`, `rng`, `int`, `shuffle` (test/prop.ts)
- Produces: `mdrl/allocation` subpath export

- [ ] **Step 1: 패키지 노출**

`src/allocation/index.ts`:
```ts
export * from "./types.ts";
export * from "./lrm.ts";
export * from "./vectors.ts";
export * from "./validate.ts";
export * from "./expr.ts";
export * from "./evaluate.ts";
```
`package.json`의 `exports`에 `"./allocation": "./src/allocation/index.ts"`를 추가한다(`"./facts"` 줄 다음).

- [ ] **Step 2: 적합성 입력 파생**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl" && node -e '
const f = require("fs");
const base = () => JSON.parse(f.readFileSync("conformance/allocation/001-basic/input.json", "utf8"));
const write = (dir, i) => { f.mkdirSync(`conformance/allocation/${dir}`, { recursive: true }); f.writeFileSync(`conformance/allocation/${dir}/input.json`, JSON.stringify(i, null, 2) + "\n"); };
const d = base(); d.facts_case = "002-disputed-master";
d.policy.depends_on[0].digest = "mdrl:sha256:8bad38e50141eef5daedffa8aa3e64f0fb858bcad592ef6aee01ca6f86c0149b";
write("002-disputed-master", d);
const x = base(); x.events[0].integrity = "FLAGGED"; write("003-fraud-hold", x);
'
```
(002의 digest는 `conformance/facts/002-disputed-master` facts 문서의 digest다.)

- [ ] **Step 3: 기대값 작성 (손계산) + 러너 확장 + 출력 스크립트**

`conformance/allocation/001-basic/expected.json`:
```json
{
  "pool_lines": [
    { "event_id": "ev_001", "bucket": "platform", "amount": "2500" },
    { "event_id": "ev_001", "bucket": "ops", "amount": "500" },
    { "event_id": "ev_001", "bucket": "rights", "amount": "7000" },
    { "event_id": "ev_002", "bucket": "platform", "amount": "250" },
    { "event_id": "ev_002", "bucket": "ops", "amount": "50" },
    { "event_id": "ev_002", "bucket": "rights", "amount": "701" }
  ],
  "lines": [
    { "event_id": "ev_001", "party": "pty_label_x", "role": "MASTER_OWNER", "bucket": "master", "line_seq": "1", "amount": "3150" },
    { "event_id": "ev_001", "party": "pty_member_a", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "1890" },
    { "event_id": "ev_001", "party": "pty_member_b", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "1260" },
    { "event_id": "ev_001", "party": "pty_author_c", "role": "WORK_AUTHOR", "bucket": "work", "line_seq": "1", "amount": "280" },
    { "event_id": "ev_001", "party": "pty_komca", "role": "CMO", "bucket": "work", "line_seq": "1", "amount": "420" },
    { "event_id": "ev_002", "party": "pty_label_x", "role": "MASTER_OWNER", "bucket": "master", "line_seq": "1", "amount": "316" },
    { "event_id": "ev_002", "party": "pty_member_a", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "189" },
    { "event_id": "ev_002", "party": "pty_member_b", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "126" },
    { "event_id": "ev_002", "party": "pty_author_c", "role": "WORK_AUTHOR", "bucket": "work", "line_seq": "1", "amount": "28" },
    { "event_id": "ev_002", "party": "pty_komca", "role": "CMO", "bucket": "work", "line_seq": "1", "amount": "42" }
  ],
  "holdings": [],
  "result_digest": "REPLACE_WITH_PRINTED_DIGEST"
}
```

`conformance/allocation/002-disputed-master/expected.json` — 001에서 master 라인을 빼고 보류로 옮긴 값:
```json
{
  "pool_lines": [
    { "event_id": "ev_001", "bucket": "platform", "amount": "2500" },
    { "event_id": "ev_001", "bucket": "ops", "amount": "500" },
    { "event_id": "ev_001", "bucket": "rights", "amount": "7000" },
    { "event_id": "ev_002", "bucket": "platform", "amount": "250" },
    { "event_id": "ev_002", "bucket": "ops", "amount": "50" },
    { "event_id": "ev_002", "bucket": "rights", "amount": "701" }
  ],
  "lines": [
    { "event_id": "ev_001", "party": "pty_member_a", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "1890" },
    { "event_id": "ev_001", "party": "pty_member_b", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "1260" },
    { "event_id": "ev_001", "party": "pty_author_c", "role": "WORK_AUTHOR", "bucket": "work", "line_seq": "1", "amount": "280" },
    { "event_id": "ev_001", "party": "pty_komca", "role": "CMO", "bucket": "work", "line_seq": "1", "amount": "420" },
    { "event_id": "ev_002", "party": "pty_member_a", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "189" },
    { "event_id": "ev_002", "party": "pty_member_b", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "126" },
    { "event_id": "ev_002", "party": "pty_author_c", "role": "WORK_AUTHOR", "bucket": "work", "line_seq": "1", "amount": "28" },
    { "event_id": "ev_002", "party": "pty_komca", "role": "CMO", "bucket": "work", "line_seq": "1", "amount": "42" }
  ],
  "holdings": [
    { "event_id": "ev_001", "bucket": "master", "reason": "RIGHTS_DISPUTE", "amount": "3150" },
    { "event_id": "ev_002", "bucket": "master", "reason": "RIGHTS_DISPUTE", "amount": "316" }
  ],
  "result_digest": "REPLACE_WITH_PRINTED_DIGEST"
}
```

`conformance/allocation/003-fraud-hold/expected.json` — ev_001은 권리자 풀 전액 보류, ev_002는 001과 같음:
```json
{
  "pool_lines": [
    { "event_id": "ev_001", "bucket": "platform", "amount": "2500" },
    { "event_id": "ev_001", "bucket": "ops", "amount": "500" },
    { "event_id": "ev_001", "bucket": "rights", "amount": "7000" },
    { "event_id": "ev_002", "bucket": "platform", "amount": "250" },
    { "event_id": "ev_002", "bucket": "ops", "amount": "50" },
    { "event_id": "ev_002", "bucket": "rights", "amount": "701" }
  ],
  "lines": [
    { "event_id": "ev_002", "party": "pty_label_x", "role": "MASTER_OWNER", "bucket": "master", "line_seq": "1", "amount": "316" },
    { "event_id": "ev_002", "party": "pty_member_a", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "189" },
    { "event_id": "ev_002", "party": "pty_member_b", "role": "PERFORMER_FEATURED", "bucket": "performer", "line_seq": "1", "amount": "126" },
    { "event_id": "ev_002", "party": "pty_author_c", "role": "WORK_AUTHOR", "bucket": "work", "line_seq": "1", "amount": "28" },
    { "event_id": "ev_002", "party": "pty_komca", "role": "CMO", "bucket": "work", "line_seq": "1", "amount": "42" }
  ],
  "holdings": [
    { "event_id": "ev_001", "bucket": "rights", "reason": "FRAUD_REVIEW", "amount": "7000" }
  ],
  "result_digest": "REPLACE_WITH_PRINTED_DIGEST"
}
```

`scripts/print-allocation.ts`:
```ts
import { readFileSync } from "node:fs";
import { evaluate } from "../src/allocation/evaluate.ts";
import { projectToIr } from "../src/facts/result.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/print-allocation.ts <conformance/allocation/case-dir>");
const read = (p: string | URL) => JSON.parse(readFileSync(p, "utf8"));
const input = read(`${dir}/input.json`);
const facts = read(new URL(`../conformance/facts/${input.facts_case}/input.json`, import.meta.url));
const projection = projectToIr(facts.facts, facts.usage, facts.as_of, facts.known_at);
if (!projection.ok) throw new Error(projection.errors.map((e) => e.code).join(","));
const r = evaluate({ policy: input.policy, facts: facts.facts, projection: projection.value, snapshot: input.snapshot, events: input.events, runId: input.run_id });
const out = r.ok
  ? { pool_lines: r.value.pool_lines, lines: r.value.lines, holdings: r.value.holdings, result_digest: r.value.result_digest }
  : { errors: r.errors.map((e) => e.code).sort() };
console.log(JSON.stringify(out, null, 2));
```

`test/conformance.test.ts` 끝에 추가(상단 import에 `import { evaluate } from "../src/allocation/evaluate.ts";`와 `import { evaluationInput } from "./helpers.ts";` 추가):
```ts
const allocationRoot = new URL("../conformance/allocation/", import.meta.url);
const allocationCases = readdirSync(allocationRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

for (const name of allocationCases) {
  test(`conformance allocation/${name}`, () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`${name}/${f}`, allocationRoot), "utf8"));
    const expected = read("expected.json");
    const r = evaluate(evaluationInput(read("input.json")));
    if (expected.errors !== undefined) {
      assert.equal(r.ok, false);
      assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.code).sort(), expected.errors);
      return;
    }
    assert.ok(r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.deepEqual(r.value.pool_lines, expected.pool_lines);
    assert.deepEqual(r.value.lines, expected.lines);
    assert.deepEqual(r.value.holdings, expected.holdings);
    assert.equal(r.value.result_digest, expected.result_digest);
  });
}
```

Run: 세 케이스 각각 `node scripts/print-allocation.ts conformance/allocation/<case>`
Expected: 출력의 `pool_lines`·`lines`·`holdings`가 위 손계산 값과 **완전히 같아야** 한다. 다르면 기대값을 고치지 말고 평가기(Task 6)를 다시 본다. 같으면 각 출력의 `result_digest`를 해당 `expected.json`의 `"REPLACE_WITH_PRINTED_DIGEST"` 자리에 붙여 넣는다.

- [ ] **Step 4: 속성 테스트 작성**

`test/allocation/property.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/allocation/evaluate.ts";
import { projectToIr } from "../../src/facts/result.ts";
import { evaluationInput, loadAllocationCase, loadBasic } from "../helpers.ts";
import { int, rng, shuffle } from "../prop.ts";

test("property: every event conserves money and results are reproducible", () => {
  const r = rng(1234);
  for (let round = 0; round < 40; round++) {
    const c = loadAllocationCase();
    const n = int(r, 1, 6);
    c.events = Array.from({ length: n }, (_, k) => ({
      id: `ev_${String(k).padStart(3, "0")}`,
      type: "PRIMARY" as const,
      amount: String(int(r, 1, 50_000_000)),
      currency: "KRW",
      integrity: int(r, 0, 9) === 0 ? ("FLAGGED" as const) : ("CLEAR" as const),
    }));
    const first = evaluate(evaluationInput(c));
    assert.ok(first.ok);
    for (const ev of c.events) {
      const pool = first.value.pool_lines.filter((l) => l.event_id === ev.id);
      assert.equal(pool.reduce((a, l) => a + BigInt(l.amount), 0n), BigInt(ev.amount));
      const rights = BigInt(pool.find((l) => l.bucket === "rights")!.amount);
      const paid = [...first.value.lines, ...first.value.holdings]
        .filter((l) => l.event_id === ev.id)
        .reduce((a, l) => a + BigInt(l.amount), 0n);
      assert.equal(paid, rights);
    }
    const second = evaluate(evaluationInput(c));
    assert.ok(second.ok);
    assert.equal(second.value.result_digest, first.value.result_digest);
  }
});

test("property: projection digest ignores usage scale and key order", () => {
  const r = rng(99);
  const i = loadBasic();
  const base = projectToIr(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(base.ok);
  for (let round = 0; round < 20; round++) {
    const k = BigInt(int(r, 1, 1000));
    const scaled = Object.fromEntries(shuffle(r, Object.entries(i.usage)).map(([s, v]) => [s, (BigInt(v) * k).toString()]));
    const p = projectToIr(i.facts, scaled, i.as_of, i.known_at);
    assert.ok(p.ok);
    assert.equal(p.value.digest, base.value.digest);
  }
});
```

- [ ] **Step 5: 스펙 12절에 반영**

`02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md` 맨 끝(12.20 다음)에 추가:
```markdown
21. **allocation IR 형태(계획 1-B)**: `body = { scope{pack, events[], currency}, bind{time}, tier1{buckets[{name,bps}], rights}, tier2{split[{name,bps,role,vector}]}, rounding{method,tie} }`. 벡터 식은 `fn` 7종(`graph{role, via_mandate?}`, `contract{party}`, `member_pct`, `performance_pool{mode, fixed?, usage?, featured_weight?}`, `mix{parts[{weight, of}]}`, `cap{max, of}`, `floor_guarantee{min, of}`)이며 비율 인자는 bps 문자열이다. 스키마는 `spec/schema/allocation.ir.schema.json`. 텍스트 문법(5.2의 예시)은 1-C 파서가 이 IR로 변환한다.
22. **실연 풀 의미**: 풀 멤버는 발행 스냅샷 `members`(멤버 비율, 합 1)의 키다. `MEMBER_PCT` = 멤버 비율, `FIXED` = 멤버 균등, `USAGE_WEIGHTED` = `featured_weight·F + (1−featured_weight)·N`(F·N은 조합 지분의 PERFORMER_FEATURED·NON_FEATURED 벡터, 한쪽만 있으면 그 벡터), `HYBRID` = `fixed·FIXED + usage·USAGE_WEIGHTED`.
23. **cap·floor_guarantee**: 반복 수위 채우기로 정확히 계산한다. `@hold`는 제한·보장·재분배 대상이 아니다. floor의 영역은 스냅샷 멤버와 벡터의 party 합집합이다. 조건을 만족하는 분배가 없으면 `ALLOC_INFEASIBLE`.
24. **라인 역할과 순번**: line의 role은 party kind가 CMO·AGENCY면 그 kind, 아니면 버킷 role이다(12.16과 같은 규칙). `line_seq`는 `"1"`이며 역분개(REVERSAL)는 후속 계획에서 다룬다.
25. **보류 규칙**: 벡터의 `@hold` 몫은 `holding(RIGHTS_DISPUTE)`. `integrity = FLAGGED` 이벤트는 tier1은 그대로 기록하고 권리자 풀 전액을 `holding(bucket = tier1.rights, FRAUD_REVIEW)`로 보낸다. pool_line은 0원도 기록하고, 0원 line·holding은 만들지 않는다(trace에는 남는다).
26. **이벤트 정규형**: 이벤트 배열은 id 엄격 오름차순, amount는 양의 정수 문자열(최소 통화 단위), type과 currency는 정책 scope 안이어야 한다(`ALLOC_SCOPE_MISMATCH`).
27. **입력 결합**: `policy.depends_on`에 `vc:facts/<id>@<version>`과 그 facts digest가 있어야 하고, `projection.facts_digest`와 조합 지분 자기 digest가 일치해야 한다(`CORE_DIGEST_MISMATCH`). `bind.time`은 결과에 기록되며, 어떤 시점으로 조합 지분을 계산할지는 호출자가 그 규칙대로 `as_of`를 정한다.
28. **안분 커버리지**: 실제 권리자가 있는 조합 지분 역할마다 그 역할을 다루는 버킷이 있어야 한다(`graph(role)`; `performance_pool`·`member_pct`는 실연 두 역할). 없으면 `ALLOC_UNCOVERED_CLAIMANT`.
29. **활성화 판정 `checkActivation`**: 12.20의 규칙을 구현한다. 분쟁 claim·mandate id 목록을 담은 `FACTS_DISPUTE_OPEN`과 청구권자 커버리지 결과를 함께 반환하며, 빈 결과일 때만 활성화할 수 있다.
30. **1-B 범위 밖**: 템플릿 계승(`ALLOC_WIDENING`), 역분개(`REVERSAL`), 다통화 정산, 섀도 시뮬레이션 리포트는 후속 계획에서 다룬다.
```

- [ ] **Step 6: 전체 확인**

Run: `npm test && npx tsc -p tsconfig.json && (grep -rl "REPLACE_WITH_PRINTED_DIGEST" conformance || echo "no placeholders")`
Expected: 전체 PASS(적합성 facts 4건 + allocation 3건 포함), tsc 출력 없음, `no placeholders`.

- [ ] **Step 7: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 04_구현_소스코드/mdrl/src/allocation/index.ts 04_구현_소스코드/mdrl/package.json 04_구현_소스코드/mdrl/scripts/print-allocation.ts 04_구현_소스코드/mdrl/conformance/allocation 04_구현_소스코드/mdrl/test/conformance.test.ts 04_구현_소스코드/mdrl/test/allocation/property.test.ts "02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md" && git commit -m "$(printf 'feat(mdrl): allocation 적합성 스위트, 속성 테스트, 패키지 노출과 스펙 반영\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

## Self-Review 결과

- **스펙 커버리지:** 5.1 Tier1·Tier2 통합(T4 IR, T6) · 5.2 문법 예시의 의미(T4 IR로 대응, 텍스트는 1-C) · 5.3 내장 함수 7종(T3, T5) · 5.4 정적 검증(T4; 커버리지는 T6; `ALLOC_WIDENING`은 범위 밖으로 12.30 기록) · 5.5 `HIERARCHICAL_LRM_V1`(T2, T6) · 5.6 평가기 계약·trace·결과 digest(T6) · 5.7 거버넌스(서명·SoD는 1-A 코어가 담당, 섀도 시뮬레이션은 범위 밖) · 12.13 분쟁 보류(T6) · 12.16 수령인 역할(T6) · 12.20 활성화 금지(T7) · 10.3 속성 테스트(T2, T8).
- **타입 일관성:** `Share`·`Allotment`(T2) ↔ T6, `PartyVector`·`HOLD`(1-A) ↔ T3·T5·T6·T7, `ExprContext`(T5) ↔ T6, `AllocationCase`·`evaluationInput`(helpers, T4·T6) ↔ T8, `EvaluationInput`(T6) ↔ helpers.
- **자리표시자:** `REPLACE_WITH_PRINTED_DIGEST`는 T8 Step 3에서 손계산 값 일치를 확인한 뒤 명령 출력으로 채우고, Step 6에서 남은 것이 없는지 검사한다.
