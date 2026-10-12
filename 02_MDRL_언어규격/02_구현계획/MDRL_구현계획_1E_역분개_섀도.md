# 1-E 역분개·섀도 리포트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MDRL 엔진에 환불·정정 역분개(`reverse`/`verifyReversal`, `mdrl-reversal-result/1`)와 정책 섀도 비교(`shadowReport`/`verifyShadowReport`, `mdrl-shadow-report/1`)를 순수 함수로 추가해 I-2 정산 MVP의 선행 과제를 끝낸다.

**Architecture:** 둘 다 `src/allocation/`의 결정적 순수 함수다. 역분개는 정책·facts를 다시 평가하지 않고 봉인된 원 안분 결과만으로 계산한다. 계산 방식 `REVERSAL_REMAINING_LRM_V1`은 원 결과와 같은 계층(tier1 풀 → tier2 버킷 그룹 → 라인·보류)에서 각 항목의 **남은 금액** 비례로 이번 환불액을 HIERARCHICAL LRM으로 나눈다. 이전 역분개는 입력으로 받아 체인으로 재도출·대조한다. 섀도 리포트는 같은 이벤트를 두 입력으로 `evaluate`해 당사자·버킷·보류별 차액을 집계한다.

**Tech Stack:** 기존 mdrl 패키지 그대로(Node ≥ 24, TypeScript 직접 실행, `node:test`, BigInt, 런타임 의존성 0, ajv는 테스트 전용).

**상위 스펙:** `02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md`(12절, 11.2), `MDRL_시스템통합_아키텍처_설계_v1.0.md` 5.7. 설계 결정은 이 계획의 "설계 결정" 절이 정본이며 Task 4가 코어 규격 12.53~12.57로 옮긴다.

## Global Constraints

- 작업 디렉터리: `/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl` (git 루트 `/Users/changkyuneun/Vocal Combination`). 저장소에는 무관한 커밋 안 된 변경이 많다. `git add`는 태스크에 나열된 파일만 한다. `git stash`, `git reset`, `git checkout -- <path>`는 쓰지 않는다. 임시 파일은 남기지 않는다.
- 커밋 메시지: 제목, 빈 줄, 마지막 줄에 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- TypeScript는 erasable syntax만(`enum`·`namespace`·parameter property 금지). 상대 import는 `.ts` 확장자, 타입 전용 import는 `import type`.
- 런타임 의존성 0. 라이브러리 코드에서 부동소수 금지(금액·비율은 BigInt·Ratio). IR의 숫자는 모두 문자열.
- 정렬은 코드 유닛 비교(`a < b`), `localeCompare` 금지.
- 모든 오류는 `Diagnostic { code, path, message }`로 보고하고, 새 코드는 `src/core/errors.ts`의 `ERROR_CODES`와 `spec/error-codes.md`에 함께 등록한다(동기화 테스트가 강제). 모든 코드는 테스트나 적합성 케이스에서 한 번 이상 `"CODE"` 형태로 단언되어야 한다(`test/error-catalog.test.ts`가 강제).
- 테스트 실행: `node --test "test/**/*.test.ts"`(= `npm test`). 디렉터리 형태(`node --test test/allocation/`)는 이 Node에서 실패하므로 파일 경로나 glob을 쓴다. 타입 검사 `npx tsc -p tsconfig.json`.
- 기존 공개 API·적합성 digest(`5dc63e54…` 등)를 바꾸지 않는다.

## 설계 결정

1. **역분개 입력**: `{ original: AllocationResult, policy: AllocationDocument, eventId, refund: { id, reason, amount }, priors: ReversalResult[], runId }`. `reason`은 새 Enum `reversal_reason` = `REFUND | CORRECTION | FRAUD`. `policy`는 원 결과의 `policy_digest`와 같아야 하며 tier1 권리 풀 이름(`body.tier1.rights`)을 알기 위해서만 쓴다.
2. **원 결과 검증**: 객체이고 `format = mdrl-allocation-result/1`, `digestOf({...original, trace: undefined, result_digest: undefined}) = result_digest`(아니면 `REV_ORIGINAL_DIGEST`). 되돌릴 이벤트의 풀 라인이 없으면 `REV_UNKNOWN_EVENT`. 그 이벤트의 권리 풀 금액 ≠ 라인+보류 합이면 `REV_ORIGINAL_INCONSISTENT`.
3. **계산 `REVERSAL_REMAINING_LRM_V1`**: 항목의 남은 금액 = 원 금액 − 이전 역분개 합. 이번 환불액 Δ를 (1) 그 이벤트의 tier1 풀 라인에 남은 금액 비례, (2) 권리 풀 증분을 라인·보류의 `bucket` 그룹(첫 등장 순)에 그룹 남은 합 비례, (3) 그룹 증분을 그룹 안 항목에 남은 금액 비례로 `splitLrm`한다. 남은 금액이 0인 항목은 제외한다. LRM 키: 풀·그룹은 버킷 이름, 라인은 `line:<party>`, 보류는 `hold:<reason>`. 성질: 증분 ≥ 0, 증분 ≤ 남은 금액, 층별 합 보존, 누적 = 원 금액이면 모든 항목이 정확히 0.
4. **한도**: 이전 누적 + Δ > 원 금액이면 `REV_EXCEEDS_REMAINING`. Δ는 양의 정수 문자열(아니면 `REV_AMOUNT`).
5. **체인**: `priors[k]`는 같은 원 결과·이벤트의 k+1번째 역분개여야 한다. 원 결과에서 `priors[0..k-1]`을 적용한 상태로 `priors[k].refund`·`run_id`를 다시 계산해 `result_digest`가 같고, `priors[k]` 자신의 digest도 맞아야 한다. 아니면 `REV_CHAIN_BROKEN`(`$.priors[k]`).
6. **출력 `mdrl-reversal-result/1`**: `format, run_id, original_run_id, original_result_digest, policy_digest, event_id, refund, sequence("k"), cumulative, original_amount, previous_digest?(k>1), method("REVERSAL_REMAINING_LRM_V1"), pool_lines, lines, holdings, result_digest`. 금액은 음수 문자열(`"-2100"`), 증분 0인 항목은 뺀다. 라인은 원 키에 `line_seq = k+1`, `reverses_line_seq = 원 line_seq`. 순서는 원 결과의 배열 순서. `result_digest = digestOf(result_digest를 뺀 전체)`. 통화 필드는 없다(원 결과와 같은 통화).
7. **검증** `verifyReversal({original, policy, priors}, given)`: `given`이 객체가 아니면 `CORE_TYPE_ERROR`(`$.result`), `format`이 다르면 `CORE_TYPE_ERROR`(`$.result.format`), `given`의 `event_id`·`refund`·`run_id`로 다시 계산해 digest가 다르면 `CORE_DIGEST_MISMATCH`(`$.result`). 재계산 진단은 그대로 돌려준다.
8. **섀도 입력**: `pairs: { baseline: EvaluationInput, candidate: EvaluationInput }[]`(비어 있으면 `CORE_TYPE_ERROR`). 각 쪽 평가 오류는 `$.pairs[i].baseline`/`.candidate` 접두로 돌려준다. 두 쪽 `events_digest`가 다르면 `SHADOW_EVENTS_MISMATCH`(`$.pairs[i]`), 한 이벤트 id가 두 쌍에 나오면 `SHADOW_DUPLICATE_EVENT`.
9. **출력 `mdrl-shadow-report/1`**: `format, pairs[{events_digest, baseline_policy_digest, candidate_policy_digest, baseline_result_digest, candidate_result_digest}], parties[{party, role, baseline, candidate, delta}], buckets[{level: "tier1"|"tier2", bucket, baseline, candidate, delta}], holdings[{reason, baseline, candidate, delta}], totals{events, amount}, report_digest`. 금액은 부호 있는 정수 문자열, `delta = candidate − baseline`, 한쪽에만 있으면 0. `tier1`은 풀 라인, `tier2`는 라인의 버킷, 보류는 사유별. 정렬은 키 성분별 코드 유닛 오름차순. `report_digest = digestOf(report_digest를 뺀 전체)`. `verifyShadowReport(pairs, given)`은 재계산 대조(오류 규칙은 7과 같다).

## File Structure

```
mdrl/
  src/core/enums.ts                   (Modify: reversal_reason)
  src/core/errors.ts                  (Modify: REV_* 6개, SHADOW_* 2개)
  spec/error-codes.md                 (Modify: 새 코드 8개)
  src/allocation/reverse.ts           (Create: reverse, verifyReversal, 타입·상수)
  src/allocation/shadow.ts            (Create: shadowReport, verifyShadowReport)
  src/allocation/index.ts             (Modify: export)
  spec/schema/reversal.result.schema.json   (Create)
  spec/schema/shadow.report.schema.json     (Create)
  conformance/reversal/001-partial-then-full/{input,expected}.json  (Create)
  conformance/reversal/002-fraud-hold-full/{input,expected}.json    (Create)
  test/allocation/reverse.test.ts     (Create)
  test/allocation/reverse.property.test.ts (Create)
  test/allocation/shadow.test.ts      (Create)
  test/conformance.test.ts            (Modify: reversal 케이스)
  test/schema.test.ts                 (Modify: 두 스키마)
02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md   (Modify, Task 4)
02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md (Modify, Task 4)
```

---

### Task 1: 역분개 `reverse`

**Files:**
- Modify: `src/core/enums.ts`, `src/core/errors.ts`, `spec/error-codes.md`, `src/allocation/index.ts`
- Create: `src/allocation/reverse.ts`
- Test: `test/allocation/reverse.test.ts`

**Interfaces:**
- Consumes: `AllocationResult`, `AllocationDocument`, `PoolLine`, `AllocationLine`, `Holding`, `ALLOCATION_RESULT_FORMAT` (`src/allocation/types.ts`), `splitLrm` (`lrm.ts`), `validateAllocation` (`validate.ts`), `digestOf`, `ratio`, `isId`, `rejectUnknownKeys`, `isPlainObject`, `attempt`, `fail`, `diag`, `err`, `underPath`, `describe`, `isEnumValue`; 테스트는 `evaluate`와 `test/helpers.ts`의 `evaluationInput`, `loadAllocationCase`.
- Produces (`src/allocation/reverse.ts`, `mdrl/allocation`으로 export):
```ts
export const REVERSAL_RESULT_FORMAT = "mdrl-reversal-result/1";
export const REVERSAL_METHOD = "REVERSAL_REMAINING_LRM_V1";
export type ReversalReason = EnumValue<"reversal_reason">;
export type Refund = { id: string; reason: ReversalReason; amount: string };
export type ReversalLine = AllocationLine & { reverses_line_seq: string };
export type ReversalResult = { format; run_id; original_run_id; original_result_digest; policy_digest; event_id; refund: Refund;
  sequence: string; cumulative: string; original_amount: string; previous_digest?: string; method;
  pool_lines: PoolLine[]; lines: ReversalLine[]; holdings: Holding[]; result_digest: string };
export type ReversalInput = { original: AllocationResult; policy: AllocationDocument; eventId: string; refund: Refund; priors: readonly ReversalResult[]; runId: string };
export function reverse(input: ReversalInput): Result<ReversalResult>;
```

- [ ] **Step 1: Enum·오류 코드 등록**

`src/core/enums.ts`의 `ENUMS`에 `holding_reason` 줄 아래 추가:
```ts
  reversal_reason: ["REFUND", "CORRECTION", "FRAUD"],
```

`src/core/errors.ts`의 `ERROR_CODES`에서 `ALLOC_ROUNDING_INVARIANT` 줄 아래 추가(`SHADOW_*` 코드는 단언하는 테스트가 생기는 Task 3에서 등록한다):
```ts
  REV_ORIGINAL_DIGEST: "원 안분 결과의 result_digest가 내용과 다르다",
  REV_ORIGINAL_INCONSISTENT: "원 안분 결과의 권리 풀 금액과 라인·보류 합이 다르다",
  REV_UNKNOWN_EVENT: "원 안분 결과에 역분개할 이벤트가 없다",
  REV_CHAIN_BROKEN: "이전 역분개가 같은 원 결과·이벤트에서 순서대로 재도출되지 않는다",
  REV_EXCEEDS_REMAINING: "누적 역분개액이 원 이벤트 금액을 넘는다",
  REV_AMOUNT: "역분개 금액은 양의 정수 문자열이어야 한다",
```

`spec/error-codes.md`의 `ALLOC_ROUNDING_INVARIANT` 행 아래(표 안)에 추가:
```markdown
| `REV_ORIGINAL_DIGEST` | 원 안분 결과의 result_digest 불일치 | `reverse` |
| `REV_ORIGINAL_INCONSISTENT` | 원 결과의 권리 풀 ≠ 라인·보류 합 | `reverse` |
| `REV_UNKNOWN_EVENT` | 원 결과에 역분개할 이벤트 없음 | `reverse` |
| `REV_CHAIN_BROKEN` | 이전 역분개 체인이 재도출되지 않음 | `reverse` |
| `REV_EXCEEDS_REMAINING` | 누적 역분개액 > 원 이벤트 금액 | `reverse` |
| `REV_AMOUNT` | 역분개 금액이 양의 정수 문자열이 아님 | `reverse` |
```
(표의 실제 열 구성과 순서가 다르면 기존 행 형식에 맞춘다. `test/core/errors.test.ts`의 동기화 테스트가 통과해야 한다.)

- [ ] **Step 2: 실패하는 테스트 작성**

`test/allocation/reverse.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/allocation/evaluate.ts";
import { reverse, type ReversalResult, type Refund } from "../../src/allocation/reverse.ts";
import type { AllocationResult } from "../../src/allocation/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import { evaluationInput, loadAllocationCase } from "../helpers.ts";

function original(name = "001-basic"): { result: AllocationResult; policy: ReturnType<typeof loadAllocationCase>["policy"] } {
  const c = loadAllocationCase(name);
  const r = evaluate(evaluationInput(c));
  if (!r.ok) throw new Error(r.errors.map((e) => e.code).join(","));
  return { result: r.value, policy: c.policy };
}
const refund = (amount: string, id = "rf_1", reason: Refund["reason"] = "REFUND"): Refund => ({ id, reason, amount });
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));
const sum = (xs: readonly { amount: string }[]) => xs.reduce((a, x) => a + BigInt(x.amount), 0n);

test("a 30% refund of ev_001 reverses every pool, bucket and line exactly (hand-computed)", () => {
  const { result, policy } = original();
  const r = reverse({ original: result, policy, eventId: "ev_001", refund: refund("3000"), priors: [], runId: "run_rev_1" });
  assert.ok(r.ok, JSON.stringify(r));
  const v = r.value;
  assert.equal(v.format, "mdrl-reversal-result/1");
  assert.equal(v.method, "REVERSAL_REMAINING_LRM_V1");
  assert.equal(v.sequence, "1");
  assert.equal(v.cumulative, "3000");
  assert.equal(v.original_amount, "10000");
  assert.equal(v.previous_digest, undefined);
  assert.equal(v.original_result_digest, result.result_digest);
  assert.deepEqual(v.pool_lines, [
    { event_id: "ev_001", bucket: "platform", amount: "-750" },
    { event_id: "ev_001", bucket: "ops", amount: "-150" },
    { event_id: "ev_001", bucket: "rights", amount: "-2100" },
  ]);
  assert.deepEqual(v.lines.map((l) => [l.party, l.bucket, l.line_seq, l.reverses_line_seq, l.amount]), [
    ["pty_label_x", "master", "2", "1", "-945"],
    ["pty_member_a", "performer", "2", "1", "-567"],
    ["pty_member_b", "performer", "2", "1", "-378"],
    ["pty_author_c", "work", "2", "1", "-84"],
    ["pty_komca", "work", "2", "1", "-126"],
  ]);
  assert.deepEqual(v.holdings, []);
  const { result_digest, ...body } = v;
  assert.equal(result_digest, digestOf(body));
});

test("partial refunds chained to the full amount net every line of the event to exactly zero", () => {
  const { result, policy } = original();
  const priors: ReversalResult[] = [];
  for (const [i, amount] of ["3333", "1", "6666"].entries()) {
    const r = reverse({ original: result, policy, eventId: "ev_001", refund: refund(amount, `rf_${i}`), priors, runId: `run_${i}` });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.sequence, String(i + 1));
    assert.equal(r.value.previous_digest, i === 0 ? undefined : priors[i - 1]!.result_digest);
    assert.ok(r.value.lines.every((l) => l.line_seq === String(i + 2)));
    assert.equal(-sum(r.value.pool_lines), BigInt(amount));
    priors.push(r.value);
  }
  const net = new Map<string, bigint>();
  const add = (k: string, a: string) => net.set(k, (net.get(k) ?? 0n) + BigInt(a));
  for (const l of result.lines.filter((l) => l.event_id === "ev_001")) add(`${l.party}/${l.bucket}`, l.amount);
  for (const p of result.pool_lines.filter((l) => l.event_id === "ev_001")) add(`pool/${p.bucket}`, p.amount);
  for (const rv of priors) {
    for (const l of rv.lines) add(`${l.party}/${l.bucket}`, l.amount);
    for (const p of rv.pool_lines) add(`pool/${p.bucket}`, p.amount);
  }
  assert.ok([...net.values()].every((v) => v === 0n), JSON.stringify([...net].map(([k, v]) => [k, v.toString()])));
  const over = reverse({ original: result, policy, eventId: "ev_001", refund: refund("1", "rf_x"), priors, runId: "run_x" });
  assert.deepEqual(codes(over), ["REV_EXCEEDS_REMAINING"]);
});

test("a fraud-held event reverses its holding (003-fraud-hold)", () => {
  const { result, policy } = original("003-fraud-hold");
  const held = result.holdings[0]!;
  const r = reverse({ original: result, policy, eventId: held.event_id, refund: refund(
    result.pool_lines.filter((p) => p.event_id === held.event_id).reduce((a, p) => a + BigInt(p.amount), 0n).toString(), "rf_f", "FRAUD",
  ), priors: [], runId: "run_f" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value.holdings, [{ ...held, amount: `-${held.amount}` }]);
  assert.equal(r.value.refund.reason, "FRAUD");
});

test("input errors are reported with their codes", () => {
  const { result, policy } = original();
  const base = { original: result, policy, eventId: "ev_001", refund: refund("100"), priors: [] as ReversalResult[], runId: "run_e" };
  assert.deepEqual(codes(reverse({ ...base, eventId: "ev_999" })), ["REV_UNKNOWN_EVENT"]);
  assert.deepEqual(codes(reverse({ ...base, refund: refund("0") })), ["REV_AMOUNT"]);
  assert.deepEqual(codes(reverse({ ...base, refund: refund("-5") })), ["REV_AMOUNT"]);
  assert.deepEqual(codes(reverse({ ...base, refund: refund("10001") })), ["REV_EXCEEDS_REMAINING"]);
  assert.deepEqual(codes(reverse({ ...base, refund: { ...refund("1"), reason: "OOPS" as never } })), ["CORE_ENUM_UNKNOWN"]);
  const tampered = { ...result, lines: result.lines.map((l, i) => (i === 0 ? { ...l, amount: "3151" } : l)) };
  assert.deepEqual(codes(reverse({ ...base, original: tampered })), ["REV_ORIGINAL_DIGEST"]);
  const resealed = { ...tampered, result_digest: digestOf({ ...tampered, trace: undefined, result_digest: undefined }) };
  assert.deepEqual(codes(reverse({ ...base, original: resealed })), ["REV_ORIGINAL_INCONSISTENT"]);
  const otherPolicy = { ...policy, version: "2" };
  assert.deepEqual(codes(reverse({ ...base, policy: otherPolicy })), ["CORE_DIGEST_MISMATCH"]);
  assert.deepEqual(codes(reverse({ ...base, original: { ...result, format: "x" } as never })), ["CORE_TYPE_ERROR", "REV_ORIGINAL_DIGEST"]);
});

test("a prior that does not re-derive breaks the chain", () => {
  const { result, policy } = original();
  const first = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100"), priors: [], runId: "run_1" });
  assert.ok(first.ok);
  const forged = { ...first.value, lines: first.value.lines.map((l, i) => (i === 0 ? { ...l, amount: "-1" } : l)) };
  const r1 = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100", "rf_2"), priors: [forged], runId: "run_2" });
  assert.deepEqual(codes(r1), ["REV_CHAIN_BROKEN"]);
  const other = reverse({ original: result, policy, eventId: "ev_002", refund: refund("100"), priors: [], runId: "run_1" });
  assert.ok(other.ok);
  const r2 = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100", "rf_2"), priors: [other.value], runId: "run_2" });
  assert.deepEqual(codes(r2), ["REV_CHAIN_BROKEN"]);
  const ok2 = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100", "rf_2"), priors: [first.value], runId: "run_2" });
  assert.ok(ok2.ok);
  assert.equal(ok2.value.previous_digest, first.value.result_digest);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/allocation/reverse.test.ts`
Expected: FAIL (`Cannot find module '../../src/allocation/reverse.ts'`).

- [ ] **Step 4: 구현**

`src/allocation/reverse.ts`:
```ts
import { digestOf } from "../core/digest.ts";
import { isEnumValue, type EnumValue } from "../core/enums.ts";
import { attempt, describe, diag, err, fail, underPath, type Diagnostic, type Result } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { ratio } from "../core/ratio.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";
import { splitLrm } from "./lrm.ts";
import {
  ALLOCATION_RESULT_FORMAT, type AllocationDocument, type AllocationLine, type AllocationResult, type Holding, type PoolLine,
} from "./types.ts";
import { validateAllocation } from "./validate.ts";

/** 역분개 결과 형식 태그. result_digest 계산에 포함된다. */
export const REVERSAL_RESULT_FORMAT = "mdrl-reversal-result/1" as const;
/** 남은 금액 비례 순차 계층 LRM(설계 결정 3). */
export const REVERSAL_METHOD = "REVERSAL_REMAINING_LRM_V1" as const;

export type ReversalReason = EnumValue<"reversal_reason">;
export type Refund = { id: string; reason: ReversalReason; amount: string };
export type ReversalLine = AllocationLine & { reverses_line_seq: string };
export type ReversalResult = {
  format: typeof REVERSAL_RESULT_FORMAT;
  run_id: string;
  original_run_id: string;
  original_result_digest: string;
  policy_digest: string;
  event_id: string;
  refund: Refund;
  sequence: string;
  cumulative: string;
  original_amount: string;
  previous_digest?: string;
  method: typeof REVERSAL_METHOD;
  pool_lines: PoolLine[];
  lines: ReversalLine[];
  holdings: Holding[];
  result_digest: string;
};
export type ReversalInput = {
  original: AllocationResult;
  policy: AllocationDocument;
  eventId: string;
  refund: Refund;
  priors: readonly ReversalResult[];
  runId: string;
};

const AMOUNT_RE = /^(0|[1-9]\d*)$/;
const POSITIVE_RE = /^[1-9]\d*$/;
const REFUND_KEYS = ["id", "reason", "amount"] as const;

type Pool = { key: string; row: PoolLine; remaining: bigint };
type Child = { key: string; group: string; remaining: bigint; line?: AllocationLine; holding?: Holding };
type State = { original: AllocationResult; eventId: string; rights: string; total: bigint; pools: Pool[]; children: Child[] };

function amountOf(v: unknown, path: string): bigint {
  if (typeof v !== "string" || !AMOUNT_RE.test(v)) fail("CORE_TYPE_ERROR", path, describe(v));
  return BigInt(v);
}

function rowsOf(original: AllocationResult, name: "pool_lines" | "lines" | "holdings"): Record<string, unknown>[] {
  const v: unknown = (original as unknown as Record<string, unknown>)[name];
  if (!Array.isArray(v)) fail("CORE_TYPE_ERROR", `$.original.${name}`, "must be an array");
  return v.map((row: unknown, i: number) => {
    if (!isPlainObject(row)) fail("CORE_TYPE_ERROR", `$.original.${name}[${i}]`, "must be an object");
    return row;
  });
}

/** 되돌릴 이벤트의 풀 라인·라인·보류와 남은 금액(처음에는 원 금액). */
function buildState(original: AllocationResult, rights: string, eventId: string): State {
  const pools: Pool[] = [];
  rowsOf(original, "pool_lines").forEach((p, i) => {
    if (p.event_id !== eventId) return;
    pools.push({ key: String(p.bucket), row: p as unknown as PoolLine, remaining: amountOf(p.amount, `$.original.pool_lines[${i}].amount`) });
  });
  if (pools.length === 0) fail("REV_UNKNOWN_EVENT", "$.event_id", eventId);
  const children: Child[] = [];
  rowsOf(original, "lines").forEach((l, i) => {
    if (l.event_id !== eventId) return;
    const line = l as unknown as AllocationLine;
    children.push({ key: `line:${line.party}`, group: line.bucket, line, remaining: amountOf(l.amount, `$.original.lines[${i}].amount`) });
  });
  rowsOf(original, "holdings").forEach((h, i) => {
    if (h.event_id !== eventId) return;
    const holding = h as unknown as Holding;
    children.push({ key: `hold:${holding.reason}`, group: holding.bucket, holding, remaining: amountOf(h.amount, `$.original.holdings[${i}].amount`) });
  });
  const rightsPool = pools.find((p) => p.key === rights);
  const childSum = children.reduce((a, c) => a + c.remaining, 0n);
  if (rightsPool === undefined || rightsPool.remaining !== childSum) {
    fail("REV_ORIGINAL_INCONSISTENT", "$.original", `event ${eventId}: rights pool ${rightsPool?.remaining ?? "missing"} vs lines+holdings ${childSum}`);
  }
  return { original, eventId, rights, total: pools.reduce((a, p) => a + p.remaining, 0n), pools, children };
}

/** total을 남은 금액 비례로 LRM 분배한다. 남은 금액 0인 항목은 제외하고, 결과는 입력 순서다. */
function distribute(total: bigint, items: readonly { key: string; remaining: bigint }[], path: string): bigint[] {
  const out = items.map(() => 0n);
  if (total === 0n) return out;
  const idx = items.flatMap((it, i) => (it.remaining > 0n ? [i] : []));
  const avail = idx.reduce((a, i) => a + items[i]!.remaining, 0n);
  if (total > avail) fail("ALLOC_ROUNDING_INVARIANT", path, "increment exceeds remaining");
  const parts = splitLrm(total, idx.map((i) => ({ key: items[i]!.key, weight: ratio(items[i]!.remaining, avail) })), path);
  parts.forEach((p, j) => {
    const i = idx[j]!;
    if (p.amount > items[i]!.remaining) fail("ALLOC_ROUNDING_INVARIANT", path, "increment exceeds remaining");
    out[i] = p.amount;
  });
  return out;
}

/** seq번째 역분개 하나를 계산하고 state의 남은 금액을 줄인다. */
function step(s: State, seq: number, refund: Refund, runId: string, previous: string | undefined, before: bigint): ReversalResult {
  const amount = BigInt(refund.amount);
  if (amount > s.total - before) fail("REV_EXCEEDS_REMAINING", "$.refund.amount", `${amount} > remaining ${s.total - before}`);
  const path = `$.reversal[${seq}]`;
  const poolInc = distribute(amount, s.pools, `${path}.tier1`);
  const rightsInc = poolInc[s.pools.findIndex((p) => p.key === s.rights)]!;
  const groups = [...new Set(s.children.map((c) => c.group))];
  const groupInc = distribute(rightsInc, groups.map((g) => ({
    key: g, remaining: s.children.filter((c) => c.group === g).reduce((a, c) => a + c.remaining, 0n),
  })), `${path}.tier2`);
  const childInc = s.children.map(() => 0n);
  groups.forEach((g, gi) => {
    const idx = s.children.flatMap((c, i) => (c.group === g ? [i] : []));
    const inc = distribute(groupInc[gi]!, idx.map((i) => s.children[i]!), `${path}.bucket:${g}`);
    idx.forEach((i, j) => { childInc[i] = inc[j]!; });
  });
  s.pools.forEach((p, i) => { p.remaining -= poolInc[i]!; });
  s.children.forEach((c, i) => { c.remaining -= childInc[i]!; });

  const neg = (v: bigint) => (-v).toString();
  const lineSeq = String(seq + 1);
  const body: Omit<ReversalResult, "result_digest"> = {
    format: REVERSAL_RESULT_FORMAT,
    run_id: runId,
    original_run_id: s.original.run_id,
    original_result_digest: s.original.result_digest,
    policy_digest: s.original.policy_digest,
    event_id: s.eventId,
    refund: { id: refund.id, reason: refund.reason, amount: refund.amount },
    sequence: String(seq),
    cumulative: (before + amount).toString(),
    original_amount: s.total.toString(),
    ...(previous !== undefined && { previous_digest: previous }),
    method: REVERSAL_METHOD,
    pool_lines: s.pools.flatMap((p, i) => (poolInc[i] === 0n ? [] : [{ event_id: s.eventId, bucket: p.row.bucket, amount: neg(poolInc[i]!) }])),
    lines: s.children.flatMap((c, i) => (c.line === undefined || childInc[i] === 0n ? [] : [{
      event_id: s.eventId, party: c.line.party, role: c.line.role, bucket: c.line.bucket,
      line_seq: lineSeq, reverses_line_seq: c.line.line_seq, amount: neg(childInc[i]!),
    }])),
    holdings: s.children.flatMap((c, i) => (c.holding === undefined || childInc[i] === 0n ? [] : [{
      event_id: s.eventId, bucket: c.holding.bucket, reason: c.holding.reason, amount: neg(childInc[i]!),
    }])),
  };
  return { ...body, result_digest: digestOf(body) };
}

function checkRefund(r: unknown, path: string): Diagnostic[] {
  if (!isPlainObject(r)) return [diag("CORE_TYPE_ERROR", path, "must be an object")];
  const out = rejectUnknownKeys(r, REFUND_KEYS, path);
  if (!isId(r.id)) out.push(diag("CORE_TYPE_ERROR", `${path}.id`, describe(r.id)));
  if (!isEnumValue("reversal_reason", r.reason)) out.push(diag("CORE_ENUM_UNKNOWN", `${path}.reason`, describe(r.reason)));
  if (typeof r.amount !== "string" || !POSITIVE_RE.test(r.amount)) out.push(diag("REV_AMOUNT", `${path}.amount`, describe(r.amount)));
  return out;
}

/** 원 안분 결과의 한 이벤트를 refund만큼 역분개한다(설계 결정 1~6). 같은 입력은 같은 result_digest를 낸다. */
export function reverse(input: ReversalInput): Result<ReversalResult> {
  const { original, policy, eventId, refund, priors, runId } = input;
  if (!isPlainObject(original)) return err([diag("CORE_TYPE_ERROR", "$.original", "must be an object")]);
  const errors: Diagnostic[] = [];
  if (original.format !== ALLOCATION_RESULT_FORMAT) errors.push(diag("CORE_TYPE_ERROR", "$.original.format", describe(original.format)));
  const own = attempt(() => digestOf({ ...original, trace: undefined, result_digest: undefined }));
  if (!own.ok) errors.push(...underPath("$.original", own.errors));
  else if (own.value !== original.result_digest) errors.push(diag("REV_ORIGINAL_DIGEST", "$.original.result_digest"));
  const policyErrors = validateAllocation(policy);
  if (policyErrors.length > 0) errors.push(...underPath("$.policy", policyErrors));
  else if (digestOf(policy) !== original.policy_digest) errors.push(diag("CORE_DIGEST_MISMATCH", "$.policy", "not the policy the original was evaluated with"));
  if (!isId(eventId)) errors.push(diag("CORE_TYPE_ERROR", "$.event_id", describe(eventId)));
  if (!isId(runId)) errors.push(diag("CORE_TYPE_ERROR", "$.run_id", describe(runId)));
  errors.push(...checkRefund(refund, "$.refund"));
  if (!Array.isArray(priors)) errors.push(diag("CORE_TYPE_ERROR", "$.priors", "must be an array"));
  if (errors.length > 0) return err(errors);

  return attempt(() => {
    const s = buildState(original, policy.body.tier1.rights, eventId);
    let previous: string | undefined;
    let before = 0n;
    (priors as readonly unknown[]).forEach((p, k) => {
      const path = `$.priors[${k}]`;
      if (!isPlainObject(p) || checkRefund(p.refund, `${path}.refund`).length > 0 || !isId(p.run_id) || p.event_id !== eventId) {
        fail("REV_CHAIN_BROKEN", path, "not a reversal of this event");
      }
      const prior = p as unknown as ReversalResult;
      const expected = attempt(() => step(s, k + 1, prior.refund, prior.run_id, previous, before));
      const self = attempt(() => digestOf({ ...prior, result_digest: undefined }));
      if (!expected.ok || !self.ok || expected.value.result_digest !== prior.result_digest || self.value !== prior.result_digest) {
        fail("REV_CHAIN_BROKEN", path, "does not re-derive from the original and the earlier reversals");
      }
      previous = prior.result_digest;
      before += BigInt(prior.refund.amount);
    });
    return step(s, priors.length + 1, refund, runId, previous, before);
  });
}
```

`src/allocation/index.ts`에 추가:
```ts
export * from "./reverse.ts";
```

- [ ] **Step 5: 통과 확인**

Run: `node --test test/allocation/reverse.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: reverse 5 PASS, 전체 fail 0, `TSC_OK`.
손 계산 테스트(첫 번째)가 다르면: 30% 환불은 모든 층에서 나누어떨어지므로 LRM 끝수가 없다. 값이 다르면 구현(`distribute`·그룹 순서)이 틀린 것이다 — 기대값을 고치지 않는다. `CORE_TYPE_ERROR`+`REV_ORIGINAL_DIGEST` 조합 테스트는 `format`을 바꾸면 digest도 달라지므로 둘 다 나오는 것이 맞다(순서는 코드 정렬 없이 발생 순서 — 다르면 `.sort()`로 비교하도록 테스트만 고치고 보고한다).

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl"
git add src/core/enums.ts src/core/errors.ts spec/error-codes.md src/allocation/reverse.ts src/allocation/index.ts test/allocation/reverse.test.ts
git commit -m "feat(mdrl): 역분개 reverse(남은 금액 비례 계층 LRM, 체인 재도출)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `verifyReversal`과 속성 테스트

**Files:**
- Modify: `src/allocation/reverse.ts`
- Test: `test/allocation/reverse.test.ts`(추가), `test/allocation/reverse.property.test.ts`

**Interfaces:**
- Consumes: Task 1 전부, `test/prop.ts`의 `rng`, `int`.
- Produces: `export type ReversalVerificationInput = Omit<ReversalInput, "eventId" | "refund" | "runId">; export function verifyReversal(input: ReversalVerificationInput, given: unknown): Diagnostic[];`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/allocation/reverse.test.ts` 끝에 추가(import 줄의 `reverse` 옆에 `verifyReversal`을 추가):
```ts
test("verifyReversal accepts an honest result and rejects forgeries, including re-sealed ones", () => {
  const { result, policy } = original();
  const r = reverse({ original: result, policy, eventId: "ev_001", refund: refund("1234"), priors: [], runId: "run_v" });
  assert.ok(r.ok);
  const input = { original: result, policy, priors: [] };
  assert.deepEqual(verifyReversal(input, r.value), []);
  assert.deepEqual(verifyReversal(input, "x").map((d) => d.code), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(verifyReversal(input, { ...r.value, format: "mdrl-reversal-result/2" }).map((d) => d.path), ["$.result.format"]);
  const moved = r.value.lines.map((l, i) => (i === 0 ? { ...l, amount: String(BigInt(l.amount) - 1n) } : i === 1 ? { ...l, amount: String(BigInt(l.amount) + 1n) } : l));
  const { result_digest: _d, ...rest } = { ...r.value, lines: moved };
  const resealed = { ...rest, result_digest: digestOf(rest) };
  assert.deepEqual(verifyReversal(input, resealed).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);
  assert.deepEqual(verifyReversal(input, { ...r.value, refund: { ...r.value.refund, amount: "99999" } }).map((d) => d.code), ["REV_EXCEEDS_REMAINING"]);
});
```

`test/allocation/reverse.property.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/allocation/evaluate.ts";
import { reverse, type ReversalResult } from "../../src/allocation/reverse.ts";
import { evaluationInput, loadAllocationCase } from "../helpers.ts";
import { int, rng } from "../prop.ts";

/** 원 금액 total을 1~maxParts개의 양의 정수로 나눈다. */
function parts(r: () => number, total: bigint, maxParts: number): bigint[] {
  const n = Math.min(int(r, 1, maxParts), Number(total));
  const cuts = new Set<bigint>();
  while (cuts.size < n - 1) cuts.add(BigInt(int(r, 1, Number(total) - 1)));
  const bounds = [0n, ...[...cuts].sort((a, b) => (a < b ? -1 : 1)), total];
  return bounds.slice(1).map((b, i) => b - bounds[i]!);
}

for (const name of ["001-basic", "002-disputed-master", "003-fraud-hold"]) {
  test(`property: random refund sequences on ${name} keep every invariant and end at zero`, () => {
    const r = rng(20260929 + name.length);
    for (let trial = 0; trial < 60; trial++) {
      const c = loadAllocationCase(name);
      const amount = String(int(r, 1, 5_000_000));
      const events = c.events.map((e, i) => (i === 0 ? { ...e, amount } : e));
      const ev = evaluate(evaluationInput({ ...c, events }));
      assert.ok(ev.ok, JSON.stringify(ev));
      const original = ev.value;
      const eventId = events[0]!.id;
      const total = original.pool_lines.filter((p) => p.event_id === eventId).reduce((a, p) => a + BigInt(p.amount), 0n);
      const remaining = new Map<string, bigint>();
      const key = (o: { bucket: string; party?: string; reason?: string }, kind: string) => `${kind}/${o.bucket}/${o.party ?? o.reason ?? ""}`;
      for (const p of original.pool_lines.filter((x) => x.event_id === eventId)) remaining.set(key(p, "pool"), BigInt(p.amount));
      for (const l of original.lines.filter((x) => x.event_id === eventId)) remaining.set(key(l, "line"), BigInt(l.amount));
      for (const h of original.holdings.filter((x) => x.event_id === eventId)) remaining.set(key(h, "hold"), BigInt(h.amount));
      const priors: ReversalResult[] = [];
      for (const [k, a] of parts(r, total, 5).entries()) {
        const rv = reverse({ original, policy: c.policy, eventId, refund: { id: `rf_${k}`, reason: "REFUND", amount: a.toString() }, priors, runId: `run_${k}` });
        assert.ok(rv.ok, JSON.stringify(rv));
        const v = rv.value;
        const rightsInc = -BigInt(v.pool_lines.find((p) => p.bucket === c.policy.body.tier1.rights)?.amount ?? "0");
        const childInc = [...v.lines, ...v.holdings].reduce((acc, x) => acc - BigInt(x.amount), 0n);
        assert.equal(rightsInc, childInc, "rights pool increment = lines + holdings increment");
        assert.equal(v.pool_lines.reduce((acc, p) => acc - BigInt(p.amount), 0n), a, "pool increments sum to the refund");
        for (const [kind, rows] of [["pool", v.pool_lines], ["line", v.lines], ["hold", v.holdings]] as const) {
          for (const x of rows as readonly { bucket: string; party?: string; reason?: string; amount: string }[]) {
            const inc = -BigInt(x.amount);
            assert.ok(inc > 0n, "only positive increments are emitted");
            const kk = key(x, kind);
            const left = remaining.get(kk)! - inc;
            assert.ok(left >= 0n, `never exceeds remaining: ${kk}`);
            remaining.set(kk, left);
          }
        }
        priors.push(v);
      }
      assert.ok([...remaining.values()].every((x) => x === 0n), "full refund nets every item to zero");
    }
  });
}
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/allocation/reverse.test.ts test/allocation/reverse.property.test.ts`
Expected: `verifyReversal` import 실패로 reverse.test.ts FAIL. 속성 테스트는 Task 1 구현으로 이미 통과할 수 있다 — 통과하면 그대로 두고 보고서에 "속성 테스트는 Task 1 구현을 검증"이라고 적는다.

- [ ] **Step 3: 구현**

`src/allocation/reverse.ts` 끝에 추가:
```ts
export type ReversalVerificationInput = Omit<ReversalInput, "eventId" | "refund" | "runId">;

/** 제공된 역분개 결과를 신뢰하지 않고 원 결과·이전 역분개로 다시 계산해 대조한다(설계 결정 7). */
export function verifyReversal(input: ReversalVerificationInput, given: unknown): Diagnostic[] {
  if (!isPlainObject(given)) return [diag("CORE_TYPE_ERROR", "$.result", "must be an object")];
  if (given.format !== REVERSAL_RESULT_FORMAT) return [diag("CORE_TYPE_ERROR", "$.result.format", describe(given.format))];
  const r = reverse({ ...input, eventId: given.event_id as string, refund: given.refund as Refund, runId: given.run_id as string });
  if (!r.ok) return r.errors;
  const self = attempt(() => digestOf({ ...given, result_digest: undefined }));
  if (!self.ok) return underPath("$.result", self.errors);
  if (r.value.result_digest !== given.result_digest || self.value !== given.result_digest) return [diag("CORE_DIGEST_MISMATCH", "$.result")];
  return [];
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/allocation/reverse.test.ts test/allocation/reverse.property.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: 모두 통과, `TSC_OK`. 속성 테스트가 실패하면 실패한 trial의 금액·분할을 보고서에 적고 구현을 고친다(불변식을 느슨하게 하지 않는다).

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl"
git add src/allocation/reverse.ts test/allocation/reverse.test.ts test/allocation/reverse.property.test.ts
git commit -m "feat(mdrl): verifyReversal과 역분개 속성 테스트

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 섀도 리포트

**Files:**
- Modify: `src/core/errors.ts`, `spec/error-codes.md`(SHADOW 코드 2개), `src/allocation/index.ts`
- Create: `src/allocation/shadow.ts`
- Test: `test/allocation/shadow.test.ts`

**Interfaces:**
- Consumes: `evaluate`, `EvaluationInput` (`evaluate.ts`), `AllocationResult`, `digestOf`, `underPath`, `diag`, `err`, `ok`, `isPlainObject`, `attempt`, `describe`.
- Produces (`mdrl/allocation`으로 export):
```ts
export const SHADOW_REPORT_FORMAT = "mdrl-shadow-report/1";
export type ShadowPair = { baseline: EvaluationInput; candidate: EvaluationInput };
export type Comparison = { baseline: string; candidate: string; delta: string };
export type ShadowReport = { format; pairs: { events_digest; baseline_policy_digest; candidate_policy_digest; baseline_result_digest; candidate_result_digest }[];
  parties: ({ party: string; role: ClaimantRole } & Comparison)[]; buckets: ({ level: "tier1" | "tier2"; bucket: string } & Comparison)[];
  holdings: ({ reason: string } & Comparison)[]; totals: { events: string; amount: string }; report_digest: string };
export function shadowReport(pairs: readonly ShadowPair[]): Result<ShadowReport>;
export function verifyShadowReport(pairs: readonly ShadowPair[], given: unknown): Diagnostic[];
```

- [ ] **Step 1: 오류 코드 등록**

`src/core/errors.ts`의 `REV_AMOUNT` 줄 아래에 추가:
```ts
  SHADOW_EVENTS_MISMATCH: "섀도 비교 쌍의 두 평가가 서로 다른 이벤트를 쓴다",
  SHADOW_DUPLICATE_EVENT: "같은 이벤트가 섀도 비교의 여러 쌍에 나온다",
```
`spec/error-codes.md`의 `REV_AMOUNT` 행 아래에 추가:
```markdown
| `SHADOW_EVENTS_MISMATCH` | 섀도 비교 쌍의 이벤트 불일치 | `shadowReport` |
| `SHADOW_DUPLICATE_EVENT` | 같은 이벤트가 여러 쌍에 나옴 | `shadowReport` |
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/allocation/shadow.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvaluationInput } from "../../src/allocation/evaluate.ts";
import { shadowReport, verifyShadowReport } from "../../src/allocation/shadow.ts";
import type { AllocationDocument } from "../../src/allocation/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import { evaluationInput, loadAllocationCase } from "../helpers.ts";

const base = (): EvaluationInput => evaluationInput(loadAllocationCase("001-basic"));
/** master 버킷과 performer 버킷의 bps를 서로 옮긴 후보 정책(합 10000 유지). */
function shifted(policy: AllocationDocument, delta: number): AllocationDocument {
  const split = policy.body.tier2.split.map((b) => {
    if (b.name === "master") return { ...b, bps: String(Number(b.bps) - delta) };
    if (b.name === "performer") return { ...b, bps: String(Number(b.bps) + delta) };
    return b;
  });
  return { ...policy, version: "2", body: { ...policy.body, tier2: { split } } };
}
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));

test("comparing a policy with itself yields all-zero deltas", () => {
  const b = base();
  const r = shadowReport([{ baseline: b, candidate: b }]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.format, "mdrl-shadow-report/1");
  assert.ok([...r.value.parties, ...r.value.buckets, ...r.value.holdings].every((x) => x.delta === "0"));
  assert.deepEqual(r.value.totals, { events: "2", amount: "11001" });
  const { report_digest, ...body } = r.value;
  assert.equal(report_digest, digestOf(body));
});

test("moving 5% from master to performer shows opposite deltas that sum to zero", () => {
  const b = base();
  const c = { ...b, policy: shifted(b.policy, 500) };
  const r = shadowReport([{ baseline: b, candidate: c }]);
  assert.ok(r.ok, JSON.stringify(r));
  const bucket = (level: string, name: string) => r.value.buckets.find((x) => x.level === level && x.bucket === name)!;
  assert.ok(BigInt(bucket("tier2", "master").delta) < 0n);
  assert.ok(BigInt(bucket("tier2", "performer").delta) > 0n);
  assert.equal(bucket("tier1", "rights").delta, "0");
  assert.equal(r.value.parties.reduce((a, p) => a + BigInt(p.delta), 0n), 0n);
  const label = r.value.parties.find((p) => p.party === "pty_label_x")!;
  assert.equal(BigInt(label.candidate) - BigInt(label.baseline), BigInt(label.delta));
  assert.ok(r.value.parties.every((p, i, xs) => i === 0 || xs[i - 1]!.party < p.party || (xs[i - 1]!.party === p.party && xs[i - 1]!.role < p.role)));
});

test("mismatched events, duplicate events, empty pairs and evaluation errors are rejected", () => {
  const b = base();
  const other = { ...b, events: b.events.map((e) => ({ ...e, amount: String(Number(e.amount) + 1) })) };
  assert.deepEqual(codes(shadowReport([{ baseline: b, candidate: other }])), ["SHADOW_EVENTS_MISMATCH"]);
  assert.deepEqual(codes(shadowReport([{ baseline: b, candidate: b }, { baseline: b, candidate: b }])), ["SHADOW_DUPLICATE_EVENT", "SHADOW_DUPLICATE_EVENT"]);
  assert.deepEqual(codes(shadowReport([])), ["CORE_TYPE_ERROR"]);
  const broken = shadowReport([{ baseline: b, candidate: { ...b, runId: "bad id" } }]);
  assert.equal(broken.ok, false);
  assert.ok(!broken.ok && broken.errors.every((e) => e.path.startsWith("$.pairs[0].candidate")), JSON.stringify(broken));
});

test("verifyShadowReport accepts an honest report and rejects a re-sealed forgery", () => {
  const b = base();
  const pairs = [{ baseline: b, candidate: { ...b, policy: shifted(b.policy, 500) } }];
  const r = shadowReport(pairs);
  assert.ok(r.ok);
  assert.deepEqual(verifyShadowReport(pairs, r.value), []);
  assert.deepEqual(verifyShadowReport(pairs, 1).map((d) => d.code), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(verifyShadowReport(pairs, { ...r.value, format: "x" }).map((d) => d.path), ["$.result.format"]);
  const { report_digest: _d, ...rest } = { ...r.value, totals: { ...r.value.totals, amount: "1" } };
  assert.deepEqual(verifyShadowReport(pairs, { ...rest, report_digest: digestOf(rest) }).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/allocation/shadow.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 4: 구현**

`src/allocation/shadow.ts`:
```ts
import { digestOf } from "../core/digest.ts";
import { attempt, describe, diag, err, ok, underPath, type Diagnostic, type Result } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import type { ClaimantRole } from "../facts/types.ts";
import { evaluate, type EvaluationInput } from "./evaluate.ts";
import type { AllocationResult } from "./types.ts";

/** 섀도 리포트 형식 태그. report_digest 계산에 포함된다. */
export const SHADOW_REPORT_FORMAT = "mdrl-shadow-report/1" as const;

export type ShadowPair = { baseline: EvaluationInput; candidate: EvaluationInput };
export type Comparison = { baseline: string; candidate: string; delta: string };
export type ShadowReport = {
  format: typeof SHADOW_REPORT_FORMAT;
  pairs: {
    events_digest: string; baseline_policy_digest: string; candidate_policy_digest: string;
    baseline_result_digest: string; candidate_result_digest: string;
  }[];
  parties: ({ party: string; role: ClaimantRole } & Comparison)[];
  buckets: ({ level: "tier1" | "tier2"; bucket: string } & Comparison)[];
  holdings: ({ reason: string } & Comparison)[];
  totals: { events: string; amount: string };
  report_digest: string;
};

/** 키 성분 구분자. 가장 작은 코드 유닛이라 결합 키의 정렬이 성분별 정렬과 같다. */
const SEP = "\u0000";
type Tally = Map<string, [bigint, bigint]>;

function add(t: Tally, key: string, side: 0 | 1, amount: string): void {
  const cur = t.get(key) ?? [0n, 0n];
  cur[side] += BigInt(amount);
  t.set(key, cur);
}

function rows<T>(t: Tally, build: (parts: string[], c: Comparison) => T): T[] {
  return [...t.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => {
    const [b, c] = t.get(k)!;
    return build(k.split(SEP), { baseline: b.toString(), candidate: c.toString(), delta: (c - b).toString() });
  });
}

/** 같은 이벤트를 두 입력으로 평가해 당사자·버킷·보류별 차액을 집계한다(설계 결정 8·9). */
export function shadowReport(pairs: readonly ShadowPair[]): Result<ShadowReport> {
  if (!Array.isArray(pairs) || pairs.length === 0) return err([diag("CORE_TYPE_ERROR", "$.pairs", "non-empty array required")]);
  const errors: Diagnostic[] = [];
  const results: [AllocationResult, AllocationResult][] = [];
  const seen = new Set<string>();
  pairs.forEach((pair: unknown, i: number) => {
    const p = `$.pairs[${i}]`;
    if (!isPlainObject(pair) || !isPlainObject(pair.baseline) || !isPlainObject(pair.candidate)) {
      errors.push(diag("CORE_TYPE_ERROR", p, "baseline and candidate evaluation inputs required"));
      return;
    }
    const b = evaluate(pair.baseline as unknown as EvaluationInput);
    const c = evaluate(pair.candidate as unknown as EvaluationInput);
    if (!b.ok) errors.push(...underPath(`${p}.baseline`, b.errors));
    if (!c.ok) errors.push(...underPath(`${p}.candidate`, c.errors));
    if (!b.ok || !c.ok) return;
    if (b.value.events_digest !== c.value.events_digest) {
      errors.push(diag("SHADOW_EVENTS_MISMATCH", p));
      return;
    }
    for (const id of new Set(b.value.pool_lines.map((l) => l.event_id))) {
      if (seen.has(id)) errors.push(diag("SHADOW_DUPLICATE_EVENT", p, id));
      seen.add(id);
    }
    results.push([b.value, c.value]);
  });
  if (errors.length > 0) return err(errors);

  const parties: Tally = new Map();
  const buckets: Tally = new Map();
  const holdings: Tally = new Map();
  let amount = 0n;
  for (const pair of results) {
    pair.forEach((r, side) => {
      const s = side as 0 | 1;
      for (const l of r.pool_lines) {
        add(buckets, ["tier1", l.bucket].join(SEP), s, l.amount);
        if (s === 0) amount += BigInt(l.amount);
      }
      for (const l of r.lines) {
        add(parties, [l.party, l.role].join(SEP), s, l.amount);
        add(buckets, ["tier2", l.bucket].join(SEP), s, l.amount);
      }
      for (const h of r.holdings) add(holdings, h.reason, s, h.amount);
    });
  }
  const report: Omit<ShadowReport, "report_digest"> = {
    format: SHADOW_REPORT_FORMAT,
    pairs: results.map(([b, c]) => ({
      events_digest: b.events_digest, baseline_policy_digest: b.policy_digest, candidate_policy_digest: c.policy_digest,
      baseline_result_digest: b.result_digest, candidate_result_digest: c.result_digest,
    })),
    parties: rows(parties, ([party, role], c) => ({ party: party!, role: role as ClaimantRole, ...c })),
    buckets: rows(buckets, ([level, bucket], c) => ({ level: level as "tier1" | "tier2", bucket: bucket!, ...c })),
    holdings: rows(holdings, ([reason], c) => ({ reason: reason!, ...c })),
    totals: { events: String(seen.size), amount: amount.toString() },
  };
  return ok({ ...report, report_digest: digestOf(report) });
}

/** 제공된 섀도 리포트를 신뢰하지 않고 다시 계산해 대조한다. */
export function verifyShadowReport(pairs: readonly ShadowPair[], given: unknown): Diagnostic[] {
  if (!isPlainObject(given)) return [diag("CORE_TYPE_ERROR", "$.result", "must be an object")];
  if (given.format !== SHADOW_REPORT_FORMAT) return [diag("CORE_TYPE_ERROR", "$.result.format", describe(given.format))];
  const r = shadowReport(pairs);
  if (!r.ok) return r.errors;
  const self = attempt(() => digestOf({ ...given, report_digest: undefined }));
  if (!self.ok) return underPath("$.result", self.errors);
  if (r.value.report_digest !== given.report_digest || self.value !== given.report_digest) return [diag("CORE_DIGEST_MISMATCH", "$.result")];
  return [];
}
```

`src/allocation/index.ts`에 추가:
```ts
export * from "./shadow.ts";
```

- [ ] **Step 5: 통과 확인**

Run: `node --test test/allocation/shadow.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: shadow 4 PASS, 전체 fail 0(`error-catalog`가 SHADOW 코드를 찾음), `TSC_OK`.
`totals.amount`의 기대값 `"11001"`은 001-basic의 이벤트 금액 합(10000+1001)이다. `shifted`의 5% 이동이 `ALLOC_*` 검증 오류를 내면(예: cap 조건) 이동량을 100으로 줄이고 보고한다.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl"
git add src/core/errors.ts spec/error-codes.md src/allocation/shadow.ts src/allocation/index.ts test/allocation/shadow.test.ts
git commit -m "feat(mdrl): 섀도 리포트 shadowReport·verifyShadowReport

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 스키마·적합성·스펙 문서

**Files:**
- Create: `spec/schema/reversal.result.schema.json`, `spec/schema/shadow.report.schema.json`, `conformance/reversal/001-partial-then-full/{input,expected}.json`, `conformance/reversal/002-fraud-hold-full/{input,expected}.json`
- Modify: `test/schema.test.ts`, `test/conformance.test.ts`, `02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md`, `02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md`

**Interfaces:**
- Consumes: Task 1~3 전부.
- Produces: 설치된 패키지에서 `mdrl/spec/schema/reversal.result.schema.json`, `mdrl/spec/schema/shadow.report.schema.json`(기존 `./spec/*` export로 자동 노출).

- [ ] **Step 1: 스키마 작성**

`spec/schema/reversal.result.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mdrl.invalid/1.0/reversal.result.schema.json",
  "title": "MDRL reversal result (mdrl-reversal-result/1)",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "format", "run_id", "original_run_id", "original_result_digest", "policy_digest", "event_id", "refund", "sequence",
    "cumulative", "original_amount", "method", "pool_lines", "lines", "holdings", "result_digest"
  ],
  "properties": {
    "format": { "const": "mdrl-reversal-result/1" },
    "run_id": { "$ref": "#/$defs/id" },
    "original_run_id": { "$ref": "#/$defs/id" },
    "original_result_digest": { "$ref": "#/$defs/digest" },
    "policy_digest": { "$ref": "#/$defs/digest" },
    "event_id": { "$ref": "#/$defs/id" },
    "refund": {
      "type": "object", "additionalProperties": false, "required": ["id", "reason", "amount"],
      "properties": {
        "id": { "$ref": "#/$defs/id" },
        "reason": { "enum": ["REFUND", "CORRECTION", "FRAUD"] },
        "amount": { "$ref": "#/$defs/positive" }
      }
    },
    "sequence": { "$ref": "#/$defs/positive" },
    "cumulative": { "$ref": "#/$defs/positive" },
    "original_amount": { "$ref": "#/$defs/positive" },
    "previous_digest": { "$ref": "#/$defs/digest" },
    "method": { "const": "REVERSAL_REMAINING_LRM_V1" },
    "pool_lines": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["event_id", "bucket", "amount"],
        "properties": { "event_id": { "$ref": "#/$defs/id" }, "bucket": { "$ref": "#/$defs/name" }, "amount": { "$ref": "#/$defs/negative" } }
      }
    },
    "lines": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["event_id", "party", "role", "bucket", "line_seq", "reverses_line_seq", "amount"],
        "properties": {
          "event_id": { "$ref": "#/$defs/id" },
          "party": { "$ref": "#/$defs/id" },
          "role": { "$ref": "#/$defs/claimantRole" },
          "bucket": { "$ref": "#/$defs/name" },
          "line_seq": { "$ref": "#/$defs/positive" },
          "reverses_line_seq": { "$ref": "#/$defs/positive" },
          "amount": { "$ref": "#/$defs/negative" }
        }
      }
    },
    "holdings": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["event_id", "bucket", "reason", "amount"],
        "properties": {
          "event_id": { "$ref": "#/$defs/id" },
          "bucket": { "$ref": "#/$defs/name" },
          "reason": { "enum": ["RIGHTS_DISPUTE", "FRAUD_REVIEW"] },
          "amount": { "$ref": "#/$defs/negative" }
        }
      }
    },
    "result_digest": { "$ref": "#/$defs/digest" }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$", "not": { "const": "__proto__" } },
    "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
    "digest": { "type": "string", "pattern": "^mdrl:sha256:[0-9a-f]{64}$" },
    "positive": { "type": "string", "pattern": "^[1-9]\\d*$" },
    "negative": { "type": "string", "pattern": "^-[1-9]\\d*$" },
    "claimantRole": {
      "enum": ["MASTER_OWNER", "WORK_AUTHOR", "CMO", "PERFORMER_FEATURED", "PERFORMER_NON_FEATURED", "AGENCY", "AI_PROVIDER", "RECORDING_CONTRIBUTOR"]
    }
  }
}
```

`spec/schema/shadow.report.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mdrl.invalid/1.0/shadow.report.schema.json",
  "title": "MDRL shadow report (mdrl-shadow-report/1)",
  "type": "object",
  "additionalProperties": false,
  "required": ["format", "pairs", "parties", "buckets", "holdings", "totals", "report_digest"],
  "properties": {
    "format": { "const": "mdrl-shadow-report/1" },
    "pairs": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["events_digest", "baseline_policy_digest", "candidate_policy_digest", "baseline_result_digest", "candidate_result_digest"],
        "properties": {
          "events_digest": { "$ref": "#/$defs/digest" },
          "baseline_policy_digest": { "$ref": "#/$defs/digest" },
          "candidate_policy_digest": { "$ref": "#/$defs/digest" },
          "baseline_result_digest": { "$ref": "#/$defs/digest" },
          "candidate_result_digest": { "$ref": "#/$defs/digest" }
        }
      }
    },
    "parties": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["party", "role", "baseline", "candidate", "delta"],
        "properties": {
          "party": { "$ref": "#/$defs/id" }, "role": { "$ref": "#/$defs/claimantRole" },
          "baseline": { "$ref": "#/$defs/amount" }, "candidate": { "$ref": "#/$defs/amount" }, "delta": { "$ref": "#/$defs/signed" }
        }
      }
    },
    "buckets": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["level", "bucket", "baseline", "candidate", "delta"],
        "properties": {
          "level": { "enum": ["tier1", "tier2"] }, "bucket": { "$ref": "#/$defs/name" },
          "baseline": { "$ref": "#/$defs/amount" }, "candidate": { "$ref": "#/$defs/amount" }, "delta": { "$ref": "#/$defs/signed" }
        }
      }
    },
    "holdings": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["reason", "baseline", "candidate", "delta"],
        "properties": {
          "reason": { "enum": ["RIGHTS_DISPUTE", "FRAUD_REVIEW"] },
          "baseline": { "$ref": "#/$defs/amount" }, "candidate": { "$ref": "#/$defs/amount" }, "delta": { "$ref": "#/$defs/signed" }
        }
      }
    },
    "totals": {
      "type": "object", "additionalProperties": false, "required": ["events", "amount"],
      "properties": { "events": { "$ref": "#/$defs/amount" }, "amount": { "$ref": "#/$defs/amount" } }
    },
    "report_digest": { "$ref": "#/$defs/digest" }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$", "not": { "const": "__proto__" } },
    "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
    "digest": { "type": "string", "pattern": "^mdrl:sha256:[0-9a-f]{64}$" },
    "amount": { "type": "string", "pattern": "^(0|[1-9]\\d*)$" },
    "signed": { "type": "string", "pattern": "^(0|-?[1-9]\\d*)$" },
    "claimantRole": {
      "enum": ["MASTER_OWNER", "WORK_AUTHOR", "CMO", "PERFORMER_FEATURED", "PERFORMER_NON_FEATURED", "AGENCY", "AI_PROVIDER", "RECORDING_CONTRIBUTOR"]
    }
  }
}
```

- [ ] **Step 2: 적합성 케이스 작성**

형식: `input.json` = `{ "allocation_case": "<conformance/allocation 케이스 이름>", "event_id": "...", "steps": [{ "run_id": "...", "refund": { "id", "reason", "amount" } }, ...] }`. `expected.json` = `{ "steps": [ { "sequence", "cumulative", "pool_lines", "lines", "holdings", "result_digest" } 또는 { "errors": ["CODE"] } ] }` — 앞 단계부터 순서대로 적용하며, 오류 단계는 체인에 넣지 않는다.

`conformance/reversal/001-partial-then-full/input.json`:
```json
{
  "allocation_case": "001-basic",
  "event_id": "ev_001",
  "steps": [
    { "run_id": "run_rev_1", "refund": { "id": "rf_1", "reason": "REFUND", "amount": "3000" } },
    { "run_id": "run_rev_2", "refund": { "id": "rf_2", "reason": "REFUND", "amount": "3333" } },
    { "run_id": "run_rev_x", "refund": { "id": "rf_x", "reason": "REFUND", "amount": "3668" } },
    { "run_id": "run_rev_3", "refund": { "id": "rf_3", "reason": "CORRECTION", "amount": "3667" } }
  ]
}
```
(3000+3333+3667 = 10000. 세 번째 단계 3668은 남은 3667을 넘어 `REV_EXCEEDS_REMAINING`.)

`conformance/reversal/002-fraud-hold-full/input.json`: `003-fraud-hold` 케이스에서 `holdings`가 있는(FLAGGED) 이벤트의 id와 그 이벤트의 전체 금액(풀 라인 합)으로 `reason: "FRAUD"` 단계 하나를 만든다. id와 금액은 `conformance/allocation/003-fraud-hold/input.json`·`expected.json`에서 읽어 적는다.

`expected.json`은 다음 순서로 만든다: (1) 첫 단계 기대값(001의 30% 환불)은 Task 1 손 계산 테스트의 값을 그대로 적는다. (2) 나머지 단계 값은 구현으로 계산해 적되, 적기 전에 각 단계에서 `-Σpool_lines = refund.amount`, 권리 풀 증분 = 라인·보류 증분 합, 마지막 단계 후 모든 항목 순합 0을 직접 확인하고 보고서에 그 확인 결과를 적는다. (3) 002의 기대값은 보류 한 줄이 원 보류 금액의 음수이고 권리 풀 증분과 같아야 한다.

- [ ] **Step 3: 적합성·스키마 테스트 확장**

`test/conformance.test.ts` 끝에 추가(상단 import에 `import { reverse, type ReversalResult } from "../src/allocation/reverse.ts";`와 `loadAllocationCase`를 `./helpers.ts` import에 추가):
```ts
const reversalRoot = new URL("../conformance/reversal/", import.meta.url);
const reversalCases = readdirSync(reversalRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

for (const name of reversalCases) {
  test(`conformance reversal/${name}`, () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`${name}/${f}`, reversalRoot), "utf8"));
    const input = read("input.json");
    const expected = read("expected.json");
    const c = loadAllocationCase(input.allocation_case);
    const ev = evaluate(evaluationInput(c));
    assert.ok(ev.ok);
    const priors: ReversalResult[] = [];
    input.steps.forEach((s: { run_id: string; refund: ReversalResult["refund"] }, i: number) => {
      const want = expected.steps[i];
      const r = reverse({ original: ev.value, policy: c.policy, eventId: input.event_id, refund: s.refund, priors, runId: s.run_id });
      if (want.errors !== undefined) {
        assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.code).sort(), want.errors, `step ${i}`);
        return;
      }
      assert.ok(r.ok, `step ${i}: ${JSON.stringify(r)}`);
      assert.equal(r.value.sequence, want.sequence);
      assert.equal(r.value.cumulative, want.cumulative);
      assert.deepEqual(r.value.pool_lines, want.pool_lines);
      assert.deepEqual(r.value.lines, want.lines);
      assert.deepEqual(r.value.holdings, want.holdings);
      assert.equal(r.value.result_digest, want.result_digest);
      priors.push(r.value);
    });
  });
}
```

`test/schema.test.ts` 끝에 추가(상단 import에 `reverse`·`shadowReport` 추가, 필요한 타입 import):
```ts
const reversalSchema = ajv.compile(load("reversal.result.schema.json"));
const shadowSchema = ajv.compile(load("shadow.report.schema.json"));

test("reversal results and shadow reports match their schemas", () => {
  const c = loadAllocationCase();
  const input = evaluationInput(c);
  const ev = evaluate(input);
  assert.ok(ev.ok);
  const first = reverse({ original: ev.value, policy: c.policy, eventId: "ev_001", refund: { id: "rf_1", reason: "REFUND", amount: "3000" }, priors: [], runId: "run_1" });
  assert.ok(first.ok);
  const second = reverse({ original: ev.value, policy: c.policy, eventId: "ev_001", refund: { id: "rf_2", reason: "REFUND", amount: "7000" }, priors: [first.value], runId: "run_2" });
  assert.ok(second.ok);
  for (const r of [first.value, second.value]) assert.equal(reversalSchema(r), true, JSON.stringify(reversalSchema.errors));
  assert.equal(reversalSchema({ ...first.value, lines: [{ ...first.value.lines[0], amount: "945" }] }), false);
  const shadow = shadowReport([{ baseline: input, candidate: input }]);
  assert.ok(shadow.ok);
  assert.equal(shadowSchema(shadow.value), true, JSON.stringify(shadowSchema.errors));
  assert.equal(shadowSchema({ ...shadow.value, extra: "x" }), false);
});
```

- [ ] **Step 4: 통과 확인**

Run: `npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK && npm run smoke 2>&1 | tail -1`
Expected: fail 0, `TSC_OK`, `smoke OK mdrl:sha256:5dc63e54…`(기존 digest 그대로).

- [ ] **Step 5: 스펙 문서 반영**

`02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md`:
- 12절 끝(52번 뒤)에 다음 항목을 추가한다(이 계획의 "설계 결정" 1~9를 옮긴다):
```markdown
53. **역분개 (계획 1-E)**: `reverse({original, policy, eventId, refund, priors, runId})`는 정책·facts를 다시 평가하지 않고 봉인된 원 안분 결과만으로 한 이벤트를 `refund.amount`만큼 되돌린다. `refund.reason`은 Enum `reversal_reason`(`REFUND`·`CORRECTION`·`FRAUD`). `policy`는 원 결과의 `policy_digest`와 같아야 하며(아니면 `CORE_DIGEST_MISMATCH`) 권리 풀 이름을 얻는 데만 쓴다. 원 결과의 digest가 틀리면 `REV_ORIGINAL_DIGEST`, 이벤트가 없으면 `REV_UNKNOWN_EVENT`, 권리 풀 ≠ 라인·보류 합이면 `REV_ORIGINAL_INCONSISTENT`, 금액이 양의 정수 문자열이 아니면 `REV_AMOUNT`, 누적이 원 금액을 넘으면 `REV_EXCEEDS_REMAINING`.
54. **`REVERSAL_REMAINING_LRM_V1`**: 항목의 남은 금액(원 금액 − 이전 역분개) 비례로 (1) tier1 풀, (2) 권리 풀 증분을 라인·보류의 버킷 그룹(첫 등장 순), (3) 그룹 증분을 그룹 안 항목에 `splitLrm`한다. 남은 금액 0인 항목은 제외하고, LRM 키는 버킷 이름·`line:<party>`·`hold:<reason>`. 증분은 0 이상이고 남은 금액을 넘지 않으며 층별 합이 보존되고, 누적이 원 금액에 이르면 모든 항목이 정확히 0이 된다. 누적 목표 방식(원 금액 × 누적/원 금액의 LRM)은 최대 잔여법의 비단조성(앨라배마 역설) 때문에 음수 증분이 생길 수 있어 채택하지 않았다. 환불을 나누는 방식에 따라 항목별 분배가 최소 단위만큼 달라질 수 있다.
55. **역분개 결과 IR `mdrl-reversal-result/1`과 체인**: 필드는 `format, run_id, original_run_id, original_result_digest, policy_digest, event_id, refund, sequence, cumulative, original_amount, previous_digest?(sequence > 1), method, pool_lines, lines, holdings, result_digest`. 금액은 음수 문자열, 증분 0인 항목은 뺀다. 라인은 원 키에 `line_seq = sequence + 1`, `reverses_line_seq = 원 line_seq`. `result_digest = digestOf(result_digest를 뺀 전체)`. `priors[k]`는 원 결과에 `priors[0..k-1]`을 적용한 상태에서 다시 계산한 결과와 digest가 같아야 한다(아니면 `REV_CHAIN_BROKEN`). `verifyReversal({original, policy, priors}, given)`은 재계산 대조(규칙은 12.50과 같다).
56. **섀도 리포트 `mdrl-shadow-report/1`**: `shadowReport(pairs)`는 쌍마다 `baseline`·`candidate` 평가 입력을 `evaluate`해 당사자(party·role)·버킷(`tier1` 풀, `tier2` 라인 버킷)·보류 사유별 `{baseline, candidate, delta = candidate − baseline}`를 집계한다. 두 쪽 이벤트가 다르면 `SHADOW_EVENTS_MISMATCH`, 같은 이벤트가 여러 쌍에 나오면 `SHADOW_DUPLICATE_EVENT`, 평가 오류는 `$.pairs[i].baseline`/`.candidate` 접두로 돌려준다. 정렬은 키 성분별 코드 유닛 순, `report_digest = digestOf(report_digest를 뺀 전체)`. `verifyShadowReport(pairs, given)`은 재계산 대조.
57. **스키마·적합성 (1-E)**: `spec/schema/reversal.result.schema.json`, `spec/schema/shadow.report.schema.json`. 적합성 `conformance/reversal/`(부분 환불 두 번 뒤 한도 초과 거부, 잔액 전액으로 순합 0; 부정 보류 전액 역분개). CLI 명령은 추가하지 않았다.
```
- 12.24의 "`line_seq`는 `"1"`이며 역분개(REVERSAL)는 후속 계획에서 다룬다."를 "`line_seq`는 평가 결과에서 `"1"`이고, 역분개 결과에서 k번째 역분개는 `k+1`이다(12.55)."로 바꾼다.
- 12.30의 "역분개(`REVERSAL`)," 와 "섀도 시뮬레이션 리포트는" 부분을 지우고 끝에 "역분개와 섀도 리포트는 1-E(12.53~12.57)에서 구현했다."를 붙인다(문장이 자연스럽도록 다듬는다).
- 11.2 표에서 `역분개(REVERSAL)와 line_seq 증가` 행과 `섀도 시뮬레이션 리포트` 행의 과제명을 `~~…~~ **완료(1-E, 12.53~12.57)**`로 바꾼다.
- 11절 상태 기준 문장의 "(계획 1-A·1-B·1-C·1-D 반영)"을 "(계획 1-A~1-E 반영)"으로 바꾼다.

`02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md`:
- 2.3의 `reverse(runId: string, eventId: string, amount: bigint)` 줄을 `reverse(runId: string, eventId: string, refund: { id: string; reason: "REFUND" | "CORRECTION" | "FRAUD"; amount: bigint }): Promise<Result<ReversalRun>>  // 원 결과·이전 역분개 봉인을 읽어 mdrl reverse 호출(코어 규격 12.53~12.55)`로 바꾼다.
- 5.7 첫 항목을 "인터페이스: `engine-bridge.reverse`는 원 run의 결과 봉인과 같은 이벤트의 이전 역분개 봉인들을 읽어 mdrl `reverse`를 호출하고, 결과(`mdrl-reversal-result/1`)를 봉인해 `allocation_line(line_kind=REVERSAL, line_seq=k+1, reversal_of_line_id=원 라인)`·음수 `pool_line`·음수 `unallocated_holding`으로 기록한다. 부분 환불은 누적 상한까지(엔진이 `REV_EXCEEDS_REMAINING`으로 강제)."로 바꾸고, "엔진 지원 전 임시 처리" 문장과 "따라서 정산 MVP(I-2) 시작 전에 엔진 역분개를 구현한다." 문장을 "엔진 역분개는 1-E에서 구현했다."로 바꾼다.
- 5.1 3번의 "(엔진 섀도 리포트 전까지는 `evaluate` 2회 호출로 차액 계산)"을 "(mdrl `shadowReport`, 코어 규격 12.56)"으로 바꾼다.
- 7.3 로드맵 표의 "엔진 선행" 행 내용 끝에 " — 완료(1-E)"를 붙인다.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl"
git add spec/schema/reversal.result.schema.json spec/schema/shadow.report.schema.json conformance/reversal test/conformance.test.ts test/schema.test.ts
git commit -m "feat(mdrl): 역분개·섀도 IR 스키마와 역분개 적합성 케이스

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd "/Users/changkyuneun/Vocal Combination"
git add "02_MDRL_언어규격/02_구현계획/MDRL_아키텍처_코어규격_설계_v1.0.md" "02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md"
git commit -m "docs(mdrl): 코어 규격 12.53~12.57 역분개·섀도, 통합 설계 5.7·2.3 갱신

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
