# VCRL 1-D: 결과 IR 형식 태그 · 결과 스키마 · 결과 검증 API · 배포용 빌드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **정정 (최종 리뷰 반영, 2026-09-29):** 안분 결과 형식 태그는 `vcrl-allocation-result/1`로 바뀌었고 `trace`는 봉인(`result_digest`) 밖으로 옮겨졌다. 이 계획서의 `vcrl-alloc-result/1`과 봉인 범위 기술은 설계문서 12.48~12.52가 대체한다.

**Goal:** 투영 IR과 안분 결과에 digest로 봉인된 형식 태그를 붙이고, 두 결과 IR의 JSON Schema와 라이브러리 결과 검증 함수 `verifyAllocationResult`를 추가한 뒤, 다른 Node 서비스가 설치해 쓸 수 있도록 `dist/`로 빌드하고 tarball 스모크 테스트로 확인한다.

**Architecture:** 형식 상수는 생성하는 모듈에 둔다(`PROJECTION_FORMAT`은 `src/facts/result.ts`, `ALLOCATION_RESULT_FORMAT`은 `src/allocation/types.ts`). 결과 검증은 새 파일 `src/allocation/verify.ts`에 두고 CLI `verify`가 이를 호출한다. 빌드는 기존 `tsc`로 `tsconfig.build.json`(src·bin만, `rewriteRelativeImportExtensions`)을 실행해 `dist/`에 JS·`.d.ts`를 내며, 개발·테스트는 계속 `src/*.ts`를 직접 실행한다.

**Tech Stack:** Node.js ≥ 24 (네이티브 TypeScript), TypeScript 5.9, `node:test`, devDependency `ajv`(스키마 테스트), `npm pack`. 런타임 의존성 없음.

**상위 스펙:** `02_MDRL_언어규격/02_구현계획/VCRL_아키텍처_코어규격_설계_v1.0.md` 12.48~12.52. 사용자 결정(2026-09-29): 사용 방식은 Node 라이브러리 + CLI, 형식 태그는 digest 계산에 포함.

## Global Constraints

- 런타임 의존성 0. `dependencies` 필드를 만들지 않는다. 새 devDependency도 추가하지 않는다.
- TypeScript는 erasable syntax만 사용: `enum`, `namespace`, 생성자 parameter property 금지. 상대 import는 `.ts` 확장자를 붙인다. 타입 전용 import는 `import type`.
- 라이브러리 코드에서 부동소수 금지. IR에는 JSON number를 쓰지 않는다.
- 오류 코드는 `src/core/errors.ts`의 `ERROR_CODES`에만 정의한다. 이 계획은 새 오류 코드를 만들지 않는다(`CORE_TYPE_ERROR`, `CORE_DIGEST_MISMATCH`만 쓴다).
- 적합성 기대값(`conformance/**/expected.json`)에서 바꿔도 되는 것은 `digest`·`result_digest` 값과 새 `format` 필드뿐이다. 금액·라인·보류·벡터·경로는 한 글자도 바꾸지 않는다.
- 작업 디렉터리: `/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl` (git 루트 `/Users/changkyuneun/Vocal Combination`). 저장소에는 무관한 커밋 안 된 변경이 많다. `git add`는 태스크에 나열된 파일만 한다. `git stash`, `git reset`, `git checkout -- <path>`는 쓰지 않는다. 임시·재현용 파일은 남기지 않는다(스모크 테스트의 임시 디렉터리는 OS 임시 폴더에 만들고 지운다).
- 커밋 메시지: 제목, 빈 줄, 마지막 줄에 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 각 태스크 끝에서 `npm test`와 `npx tsc -p tsconfig.json`이 모두 통과해야 한다.

## File Structure

```
04_구현_소스코드/mdrl/
  .gitignore                                  (Modify: dist/, *.tgz)
  package.json                                (Modify: exports→dist, bin, files, scripts)
  tsconfig.build.json                         (Create: 배포 빌드 설정)
  src/facts/result.ts                         (Modify: PROJECTION_FORMAT, format 필드)
  src/allocation/types.ts                     (Modify: ALLOCATION_RESULT_FORMAT, format 필드)
  src/allocation/evaluate.ts                  (Modify: 결과에 format, 투영 format 검사)
  src/allocation/verify.ts                    (Create: verifyAllocationResult)
  src/allocation/index.ts                     (Modify: verify.ts 재수출)
  src/cli/main.ts                             (Modify: verify가 verifyAllocationResult 사용)
  spec/schema/projection.ir.schema.json       (Create)
  spec/schema/allocation.result.schema.json   (Create)
  scripts/print-allocation.ts                 (Modify: format 출력)
  scripts/smoke-pack.ts                       (Create: tarball 스모크 테스트)
  conformance/facts/{001,002,004}*/expected.json      (Modify: format, digest)
  conformance/allocation/{001,002,003}*/expected.json (Modify: format, result_digest)
  test/conformance.test.ts                    (Modify: format 대조)
  test/facts/result.test.ts                   (Modify)
  test/allocation/evaluate.test.ts            (Modify)
  test/allocation/verify.test.ts              (Create)
  test/schema.test.ts                         (Create)
  test/package.test.ts                        (Create)
  test/cli.test.ts                            (Modify)
02_MDRL_언어규격/02_구현계획/VCRL_아키텍처_코어규격_설계_v1.0.md  (Modify: 11절 상태)
```

---

### Task 1: 결과 IR 형식 태그 (digest에 포함)

**Files:**
- Modify: `src/facts/result.ts`
- Modify: `src/allocation/types.ts`
- Modify: `src/allocation/evaluate.ts`
- Modify: `scripts/print-allocation.ts`
- Modify: `conformance/facts/001-basic/expected.json`, `conformance/facts/002-disputed-master/expected.json`, `conformance/facts/004-competing-dispute/expected.json`
- Modify: `conformance/allocation/001-basic/expected.json`, `conformance/allocation/002-disputed-master/expected.json`, `conformance/allocation/003-fraud-hold/expected.json`
- Test: `test/facts/result.test.ts`, `test/allocation/evaluate.test.ts`, `test/conformance.test.ts`

**Interfaces:**
- Produces: `export const PROJECTION_FORMAT = "vcrl-projection/1"` (`src/facts/result.ts`), `ProjectionIr.format: typeof PROJECTION_FORMAT`.
- Produces: `export const ALLOCATION_RESULT_FORMAT = "vcrl-alloc-result/1"` (`src/allocation/types.ts`), `AllocationResult.format: typeof ALLOCATION_RESULT_FORMAT`.
- Produces: `evaluate`는 `projection.format !== PROJECTION_FORMAT`이면 `CORE_TYPE_ERROR`(경로 `$.projection.format`)를 낸다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/facts/result.test.ts` 끝에 추가:

```ts
test("projection IR carries its format tag inside the digest (spec 12.48)", () => {
  const a = build();
  assert.equal(a.format, "vcrl-projection/1");
  assert.equal(a.digest, digestOf({ ...a, digest: undefined }));
  assert.notEqual(a.digest, digestOf({ ...a, format: undefined, digest: undefined }));
});
```

`test/allocation/evaluate.test.ts` 끝에 추가(이 파일은 이미 `evaluate`, `EvaluationInput`, `digestOf`, `evaluationInput`, `loadAllocationCase`를 import한다. `ProjectionIr` 타입 import를 파일 상단에 추가: `import type { ProjectionIr } from "../../src/facts/result.ts";`):

```ts
test("allocation result carries its format tag inside result_digest (spec 12.48)", () => {
  const r = run(basic());
  assert.equal(r.format, "vcrl-alloc-result/1");
  assert.equal(r.result_digest, digestOf({ ...r, result_digest: undefined }));
  assert.notEqual(r.result_digest, digestOf({ ...r, format: undefined, result_digest: undefined }));
});

test("evaluate rejects a projection with another format tag", () => {
  const input = basic();
  const projection = { ...input.projection, format: "vcrl-projection/2" } as unknown as ProjectionIr;
  const r = evaluate({ ...input, projection });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.code === "CORE_TYPE_ERROR" && e.path === "$.projection.format"), JSON.stringify(r));
});
```

`test/conformance.test.ts`의 facts 루프에서 `assert.equal(ir.digest, expected.digest);` 바로 위에 `assert.equal(ir.format, expected.format);`를, allocation 루프에서 `assert.equal(r.value.result_digest, expected.result_digest);` 바로 위에 `assert.equal(r.value.format, expected.format);`를 추가한다.

- [ ] **Step 2: 실패 확인**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: 새 테스트 3개와 적합성 6건이 FAIL(`format`이 `undefined`).

- [ ] **Step 3: 구현**

`src/facts/result.ts`:
- `export type ProjectionIr = {` 바로 위에 추가:

```ts
/** 투영 IR 형식 태그(스펙 12.48). digest 계산에 포함된다. */
export const PROJECTION_FORMAT = "vcrl-projection/1";
```

- `ProjectionIr` 타입의 첫 필드로 `format: typeof PROJECTION_FORMAT;`를 추가한다.
- `toProjectionIr`의 `const body = { facts_digest: ...` 를 `const body = { format: PROJECTION_FORMAT, facts_digest: ...` 로 바꾼다(나머지 필드 그대로).

`src/allocation/types.ts`:
- `export type AllocationResult = {` 바로 위에 추가:

```ts
/** 안분 결과 형식 태그(스펙 12.48). result_digest 계산에 포함된다. */
export const ALLOCATION_RESULT_FORMAT = "vcrl-alloc-result/1";
```

- `AllocationResult`의 첫 필드로 `format: typeof ALLOCATION_RESULT_FORMAT;`를 추가한다.

`src/allocation/evaluate.ts`:
- import 수정: `import type { ProjectionIr } from "../facts/result.ts";` → `import { PROJECTION_FORMAT, type ProjectionIr } from "../facts/result.ts";`
- `./types.ts` import 목록에 값 import `ALLOCATION_RESULT_FORMAT`을 추가한다. 현재 `import type { ... } from "./types.ts";` 형태이므로 별도 줄 `import { ALLOCATION_RESULT_FORMAT } from "./types.ts";`를 추가한다.
- `checkInputShapes`에서 `for (const [k, valid] of PROJECTION_FIELDS) {` 루프 바로 위에 추가:

```ts
  if (projection.format !== PROJECTION_FORMAT) {
    out.push(diag("CORE_TYPE_ERROR", "$.projection.format", `unsupported projection format: ${String(projection.format)}`));
  }
```

- `evaluate`의 `const result = {` 첫 줄에 `format: ALLOCATION_RESULT_FORMAT,`를 추가한다.

`scripts/print-allocation.ts`: 성공 출력 객체를 `{ format: r.value.format, pool_lines: ..., lines: ..., holdings: ..., result_digest: ... }`로 바꾼다.

- [ ] **Step 4: 새 테스트 통과, 적합성만 digest 불일치로 실패하는지 확인**

Run: `npm test 2>&1 | grep -E "^not ok|^ℹ (pass|fail)"`
Expected: 실패는 `conformance facts/001-basic`, `facts/002-disputed-master`, `facts/004-competing-dispute`, `allocation/001-basic`, `allocation/002-disputed-master`, `allocation/003-fraud-hold` 6건뿐(원인은 `format` 필드 없음 또는 digest 변경).

- [ ] **Step 5: 기대값 갱신 (digest와 format만)**

아래 명령은 각 케이스를 다시 계산해 **벡터·경로·금액·라인·보류가 기존 기대값과 같은지 먼저 단언**한 다음, 파일의 digest 문자열만 바꾸고 `format` 줄을 맨 앞에 넣는다. 단언이 실패하면 멈추고 보고한다(기대값을 손으로 고치지 않는다).

```bash
python3 - <<'EOF'
import json, re, subprocess
def run(*args): return json.loads(subprocess.check_output(["node", *args]))
def patch(path, key, fmt, new_digest):
    text = open(path, encoding="utf-8").read()
    assert text.startswith("{\n") and '"format"' not in text, path
    text, n = re.subn(r'"%s": "vcrl:sha256:[0-9a-f]{64}"' % key, '"%s": "%s"' % (key, new_digest), text)
    assert n == 1, (path, n)
    text = '{\n  "format": "%s",\n' % fmt + text[2:]
    open(path, "w", encoding="utf-8").write(text)
for c in ["001-basic", "002-disputed-master", "004-competing-dispute"]:
    p = f"conformance/facts/{c}/expected.json"; e = json.load(open(p))
    ir = run("scripts/print-projection.ts", f"conformance/facts/{c}/input.json")
    assert ir["vectors"] == e["vectors"] and ir["paths"] == e["paths"], c
    patch(p, "digest", ir["format"], ir["digest"])
for c in ["001-basic", "002-disputed-master", "003-fraud-hold"]:
    p = f"conformance/allocation/{c}/expected.json"; e = json.load(open(p))
    r = run("scripts/print-allocation.ts", f"conformance/allocation/{c}")
    assert all(r[k] == e[k] for k in ["pool_lines", "lines", "holdings"]), c
    patch(p, "result_digest", r["format"], r["result_digest"])
print("patched")
EOF
git diff --stat -- conformance
```

Expected: `patched`, 6개 파일 각각 2줄 정도 변경(`format` 추가 1줄, digest 1줄). `git diff -- conformance`로 digest와 format 외의 변경이 없는지 눈으로 확인한다.

- [ ] **Step 6: 전체 통과 확인**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: fail 0, `TSC_OK`. (`test/cli.test.ts`는 기대 digest를 적합성 파일에서 읽으므로 그대로 통과한다.)

- [ ] **Step 7: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl"
git add src/facts/result.ts src/allocation/types.ts src/allocation/evaluate.ts scripts/print-allocation.ts \
  conformance/facts/001-basic/expected.json conformance/facts/002-disputed-master/expected.json conformance/facts/004-competing-dispute/expected.json \
  conformance/allocation/001-basic/expected.json conformance/allocation/002-disputed-master/expected.json conformance/allocation/003-fraud-hold/expected.json \
  test/facts/result.test.ts test/allocation/evaluate.test.ts test/conformance.test.ts
git commit -m "feat(vcrl): 투영·안분 결과 IR에 digest로 봉인된 형식 태그

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 결과 IR JSON Schema

**Files:**
- Create: `spec/schema/projection.ir.schema.json`
- Create: `spec/schema/allocation.result.schema.json`
- Test: `test/schema.test.ts`

**Interfaces:**
- Consumes: Task 1의 `format` 필드 값 `"vcrl-projection/1"`, `"vcrl-alloc-result/1"`.
- Produces: 두 스키마 파일(Task 4의 스모크 테스트가 tarball에 들어 있는지 확인한다).

- [ ] **Step 1: 실패하는 테스트 작성**

`test/schema.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { evaluate } from "../src/allocation/evaluate.ts";
import { projectToIr } from "../src/facts/result.ts";
import { evaluationInput, loadAllocationCase, loadFactsCase } from "./helpers.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
const load = (f: string) => JSON.parse(readFileSync(new URL(`../spec/schema/${f}`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
const projectionSchema = ajv.compile(load("projection.ir.schema.json"));
const resultSchema = ajv.compile(load("allocation.result.schema.json"));

const caseNames = (dir: string) =>
  readdirSync(new URL(`../conformance/${dir}/`, import.meta.url), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

function projection(name = "001-basic") {
  const f = loadFactsCase(name);
  return projectToIr(f.facts, f.usage, f.as_of, f.known_at);
}

test("every successful conformance projection matches the projection schema (spec 12.49)", () => {
  let n = 0;
  for (const name of caseNames("facts")) {
    const r = projection(name);
    if (!r.ok) continue;
    n++;
    assert.equal(projectionSchema(r.value), true, `${name}: ${JSON.stringify(projectionSchema.errors)}`);
  }
  assert.equal(n, 3);
});

test("every conformance allocation result matches the result schema (spec 12.49)", () => {
  let n = 0;
  for (const name of caseNames("allocation")) {
    const r = evaluate(evaluationInput(loadAllocationCase(name)));
    assert.ok(r.ok, name);
    n++;
    assert.equal(resultSchema(r.value), true, `${name}: ${JSON.stringify(resultSchema.errors)}`);
  }
  assert.equal(n, 3);
});

test("result schemas reject another format, unknown fields, JSON numbers and unknown roles", () => {
  const p = projection();
  assert.ok(p.ok);
  const path0 = p.value.paths[0]!;
  for (const bad of [
    { ...p.value, format: "vcrl-projection/2" },
    { ...p.value, extra: "x" },
    { ...p.value, paths: [{ ...path0, weight: 1 }] },
    { ...p.value, vectors: { NOBODY: {} } },
  ]) assert.equal(projectionSchema(bad), false, JSON.stringify(bad).slice(0, 80));

  const r = evaluate(evaluationInput(loadAllocationCase()));
  assert.ok(r.ok);
  const line0 = r.value.lines[0]!;
  for (const bad of [
    { ...r.value, format: "vcrl-alloc-result/2" },
    { ...r.value, extra: "x" },
    { ...r.value, lines: [{ ...line0, amount: 3150 }] },
    { ...r.value, lines: [{ ...line0, role: "NOBODY" }] },
    { ...r.value, holdings: [{ event_id: "ev_001", bucket: "rights", reason: "WHATEVER", amount: "1" }] },
  ]) assert.equal(resultSchema(bad), false, JSON.stringify(bad).slice(0, 80));
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/schema.test.ts`
Expected: FAIL (`ENOENT ... projection.ir.schema.json`).

- [ ] **Step 3: 스키마 작성**

`spec/schema/projection.ir.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://vcrl.invalid/1.0/projection.ir.schema.json",
  "title": "VCRL projection IR (vcrl-projection/1)",
  "type": "object",
  "additionalProperties": false,
  "required": ["format", "facts_digest", "as_of", "known_at", "u_digest", "vectors", "paths", "digest"],
  "properties": {
    "format": { "const": "vcrl-projection/1" },
    "facts_digest": { "$ref": "#/$defs/digest" },
    "as_of": { "$ref": "#/$defs/instant" },
    "known_at": { "$ref": "#/$defs/instant" },
    "u_digest": { "$ref": "#/$defs/digest" },
    "vectors": {
      "type": "object",
      "propertyNames": { "$ref": "#/$defs/claimantRole" },
      "additionalProperties": {
        "type": "object",
        "propertyNames": { "$ref": "#/$defs/partyKey" },
        "additionalProperties": { "$ref": "#/$defs/ratio" }
      }
    },
    "paths": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["stem", "role", "party", "weight", "claims"],
        "properties": {
          "stem": { "$ref": "#/$defs/id" },
          "role": { "$ref": "#/$defs/claimantRole" },
          "party": { "$ref": "#/$defs/partyKey" },
          "weight": { "$ref": "#/$defs/ratio" },
          "claims": { "type": "array", "items": { "$ref": "#/$defs/id" } }
        }
      }
    },
    "digest": { "$ref": "#/$defs/digest" }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$", "not": { "const": "__proto__" } },
    "partyKey": { "type": "string", "pattern": "^(@hold|[A-Za-z0-9._-]+)$", "not": { "const": "__proto__" } },
    "digest": { "type": "string", "pattern": "^vcrl:sha256:[0-9a-f]{64}$" },
    "instant": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" },
    "ratio": { "type": "string", "pattern": "^(0|[1-9]\\d*)/[1-9]\\d*$" },
    "claimantRole": {
      "enum": ["MASTER_OWNER", "WORK_AUTHOR", "CMO", "PERFORMER_FEATURED", "PERFORMER_NON_FEATURED", "AGENCY", "AI_PROVIDER", "RECORDING_CONTRIBUTOR"]
    }
  }
}
```

`spec/schema/allocation.result.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://vcrl.invalid/1.0/allocation.result.schema.json",
  "title": "VCRL allocation result (vcrl-alloc-result/1)",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "format", "run_id", "policy_digest", "projection_digest", "snapshot_digest", "events_digest", "bind_time",
    "pool_lines", "lines", "holdings", "trace", "result_digest"
  ],
  "properties": {
    "format": { "const": "vcrl-alloc-result/1" },
    "run_id": { "$ref": "#/$defs/id" },
    "policy_digest": { "$ref": "#/$defs/digest" },
    "projection_digest": { "$ref": "#/$defs/digest" },
    "snapshot_digest": { "$ref": "#/$defs/digest" },
    "events_digest": { "$ref": "#/$defs/digest" },
    "bind_time": { "enum": ["ISSUE_TIME", "USAGE_TIME", "SALE_TIME", "REPORT_PERIOD"] },
    "pool_lines": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["event_id", "bucket", "amount"],
        "properties": { "event_id": { "$ref": "#/$defs/id" }, "bucket": { "$ref": "#/$defs/name" }, "amount": { "$ref": "#/$defs/amount" } }
      }
    },
    "lines": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["event_id", "party", "role", "bucket", "line_seq", "amount"],
        "properties": {
          "event_id": { "$ref": "#/$defs/id" },
          "party": { "$ref": "#/$defs/id" },
          "role": { "$ref": "#/$defs/claimantRole" },
          "bucket": { "$ref": "#/$defs/name" },
          "line_seq": { "type": "string", "pattern": "^[1-9]\\d*$" },
          "amount": { "$ref": "#/$defs/amount" }
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
          "amount": { "$ref": "#/$defs/amount" }
        }
      }
    },
    "trace": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["event_id", "level", "total", "parts"],
        "properties": {
          "event_id": { "$ref": "#/$defs/id" },
          "level": { "type": "string", "pattern": "^(tier1|tier2|bucket:[a-z][a-z0-9_]*)$" },
          "total": { "$ref": "#/$defs/amount" },
          "parts": {
            "type": "array",
            "items": {
              "type": "object", "additionalProperties": false, "required": ["key", "weight", "amount"],
              "properties": {
                "key": { "type": "string", "pattern": "^(@hold|[A-Za-z0-9._-]+)$" },
                "weight": { "$ref": "#/$defs/ratio" },
                "amount": { "$ref": "#/$defs/amount" }
              }
            }
          }
        }
      }
    },
    "result_digest": { "$ref": "#/$defs/digest" }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$", "not": { "const": "__proto__" } },
    "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
    "digest": { "type": "string", "pattern": "^vcrl:sha256:[0-9a-f]{64}$" },
    "amount": { "type": "string", "pattern": "^(0|[1-9]\\d*)$" },
    "ratio": { "type": "string", "pattern": "^(0|[1-9]\\d*)/[1-9]\\d*$" },
    "claimantRole": {
      "enum": ["MASTER_OWNER", "WORK_AUTHOR", "CMO", "PERFORMER_FEATURED", "PERFORMER_NON_FEATURED", "AGENCY", "AI_PROVIDER", "RECORDING_CONTRIBUTOR"]
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/schema.test.ts && npm test 2>&1 | grep -E "^ℹ (pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: 3개 PASS, 전체 fail 0, `TSC_OK`. 적합성 결과가 스키마에 걸리면 스키마 패턴이 실제 값(예: 비율 `"3/5"`, trace level `"bucket:work"`)과 맞는지 먼저 확인한다. 평가기 출력을 스키마에 맞추려고 바꾸지 않는다.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl"
git add spec/schema/projection.ir.schema.json spec/schema/allocation.result.schema.json test/schema.test.ts
git commit -m "feat(vcrl): 투영·안분 결과 IR JSON Schema와 적합성 대조 테스트

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 결과 검증 API `verifyAllocationResult`와 CLI `verify`

**Files:**
- Create: `src/allocation/verify.ts`
- Modify: `src/allocation/index.ts`
- Modify: `src/cli/main.ts`
- Test: `test/allocation/verify.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `ALLOCATION_RESULT_FORMAT`(Task 1), `evaluate`, `EvaluationInput`, `projectToIr`, `Usage`.
- Produces:

```ts
export type VerificationInput = Omit<EvaluationInput, "projection"> & { usage: Usage; asOf: Instant; knownAt: Instant };
export function verifyAllocationResult(input: VerificationInput, given: unknown): Diagnostic[];
```

검사 순서(스펙 12.50): `given`이 객체가 아니면 `[CORE_TYPE_ERROR $.result]`만, `format`이 다르면 `[CORE_TYPE_ERROR $.result.format]`만 돌려준다. 그다음 투영과 평가를 입력으로 다시 계산하고 오류가 있으면 그 오류를 돌려준다. 끝으로 `projection_digest`(`$.result.projection_digest`), `result_digest`(`$.result.result_digest`), 내용 digest(`$.result`) 불일치를 모두 `CORE_DIGEST_MISMATCH`로 모은다. 내용 digest 계산이 실패하면(예: JSON number) 그 진단을 `$.result` 접두로 돌려준다. 예외를 던지지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/allocation/verify.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/allocation/evaluate.ts";
import type { AllocationResult } from "../../src/allocation/types.ts";
import { verifyAllocationResult, type VerificationInput } from "../../src/allocation/verify.ts";
import { digestOf } from "../../src/core/digest.ts";
import { evaluationInput, loadAllocationCase, loadFactsCase } from "../helpers.ts";

function setup(): { input: VerificationInput; result: AllocationResult } {
  const c = loadAllocationCase();
  const f = loadFactsCase(c.facts_case);
  const input: VerificationInput = {
    policy: c.policy, facts: f.facts, usage: f.usage, asOf: f.as_of, knownAt: f.known_at,
    snapshot: c.snapshot, events: c.events, runId: c.run_id,
  };
  const r = evaluate(evaluationInput(c));
  assert.ok(r.ok);
  return { input, result: JSON.parse(JSON.stringify(r.value)) };
}

const at = (ds: { code: string; path: string }[]) => ds.map((d) => `${d.code} ${d.path}`).sort();

test("a genuine result verifies (spec 12.50)", () => {
  const { input, result } = setup();
  assert.deepEqual(verifyAllocationResult(input, result), []);
});

test("a non-object result is a type error", () => {
  const { input } = setup();
  for (const bad of [null, [], "x", 1]) assert.deepEqual(at(verifyAllocationResult(input, bad)), ["CORE_TYPE_ERROR $.result"]);
});

test("another format tag is reported before any recomputation", () => {
  const { input, result } = setup();
  assert.deepEqual(at(verifyAllocationResult(input, { ...result, format: "vcrl-alloc-result/2" })), ["CORE_TYPE_ERROR $.result.format"]);
  const { format: _omit, ...untagged } = result;
  assert.deepEqual(at(verifyAllocationResult(input, untagged)), ["CORE_TYPE_ERROR $.result.format"]);
});

test("tampered content is caught even when result_digest is re-sealed", () => {
  const { input, result } = setup();
  const forged = structuredClone(result);
  forged.lines[0]!.amount = "1";
  forged.result_digest = digestOf({ ...forged, result_digest: undefined });
  assert.deepEqual(at(verifyAllocationResult(input, forged)), ["CORE_DIGEST_MISMATCH $.result", "CORE_DIGEST_MISMATCH $.result.result_digest"]);
});

test("a different projection digest is reported", () => {
  const { input, result } = setup();
  const other = { ...result, projection_digest: `vcrl:sha256:${"0".repeat(64)}` };
  assert.ok(at(verifyAllocationResult(input, other)).includes("CORE_DIGEST_MISMATCH $.result.projection_digest"));
});

test("a JSON number inside the given result is diagnosed under $.result, not thrown", () => {
  const { input, result } = setup();
  const numeric = structuredClone(result) as unknown as { lines: { amount: unknown }[] };
  numeric.lines[0]!.amount = 3150;
  const ds = verifyAllocationResult(input, numeric);
  assert.ok(ds.length > 0);
  assert.ok(ds.every((d) => d.path.startsWith("$.result")), JSON.stringify(ds));
});

test("invalid inputs are reported as input diagnostics", () => {
  const { input, result } = setup();
  const ds = verifyAllocationResult({ ...input, usage: null as never }, result);
  assert.ok(ds.some((d) => d.code === "FACTS_USAGE_INVALID"), JSON.stringify(ds));
});
```

`test/cli.test.ts`의 `test("evaluate and verify accept a JSON policy (not just .vcrl text)", ...)` 뒤에 추가:

```ts
test("verify rejects a result with another format tag", () => {
  const r = cli(["evaluate", ...EVAL]);
  assert.equal(r.code, 0, r.err);
  const files = fixture();
  files.set("other.json", JSON.stringify({ ...JSON.parse(r.out), format: "vcrl-alloc-result/2" }));
  const v = cli(["verify", "--result", "other.json", ...EVAL], files);
  assert.equal(v.code, 1);
  assert.match(v.err, /^CORE_TYPE_ERROR \$\.result\.format /m);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/allocation/verify.test.ts test/cli.test.ts 2>&1 | grep -E "^not ok|^ℹ (pass|fail)"`
Expected: verify.test.ts는 모듈 없음으로 FAIL, CLI 새 테스트는 FAIL(현재 CLI는 format을 보지 않고 `CORE_DIGEST_MISMATCH`를 낸다).

- [ ] **Step 3: 구현**

`src/allocation/verify.ts`:

```ts
import { digestOf } from "../core/digest.ts";
import { attempt, diag, underPath, type Diagnostic } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import type { Instant } from "../core/time.ts";
import type { Usage } from "../facts/project.ts";
import { projectToIr } from "../facts/result.ts";
import { evaluate, type EvaluationInput } from "./evaluate.ts";
import { ALLOCATION_RESULT_FORMAT } from "./types.ts";

/** 결과 검증 입력: 투영은 받지 않고 facts·usage·시점으로 다시 계산한다. */
export type VerificationInput = Omit<EvaluationInput, "projection"> & { usage: Usage; asOf: Instant; knownAt: Instant };

/**
 * 제공된 안분 결과를 신뢰하지 않고 입력으로 투영과 평가를 다시 계산해 대조한다(스펙 12.50).
 * 일치하면 빈 배열을 돌려주고, 예외를 던지지 않는다.
 */
export function verifyAllocationResult(input: VerificationInput, given: unknown): Diagnostic[] {
  if (!isPlainObject(given)) return [diag("CORE_TYPE_ERROR", "$.result", "must be an object")];
  if (given.format !== ALLOCATION_RESULT_FORMAT) {
    return [diag("CORE_TYPE_ERROR", "$.result.format", `unsupported result format: ${String(given.format)}`)];
  }
  const { usage, asOf, knownAt, ...rest } = input;
  const projection = projectToIr(rest.facts, usage, asOf, knownAt);
  if (!projection.ok) return projection.errors;
  const recomputed = evaluate({ ...rest, projection: projection.value });
  if (!recomputed.ok) return recomputed.errors;

  const out: Diagnostic[] = [];
  const expected = recomputed.value.result_digest;
  if (given.projection_digest !== projection.value.digest) {
    out.push(diag("CORE_DIGEST_MISMATCH", "$.result.projection_digest", String(given.projection_digest)));
  }
  if (given.result_digest !== expected) out.push(diag("CORE_DIGEST_MISMATCH", "$.result.result_digest", String(given.result_digest)));
  const content = attempt(() => digestOf({ ...given, result_digest: undefined }));
  if (!content.ok) out.push(...underPath("$.result", content.errors));
  else if (content.value !== expected) out.push(diag("CORE_DIGEST_MISMATCH", "$.result", "result content does not match the recomputed result"));
  return out;
}
```

`src/allocation/index.ts` 끝에 `export * from "./verify.ts";`를 추가한다.

`src/cli/main.ts`:
- import 추가: `import { verifyAllocationResult, type VerificationInput } from "../allocation/verify.ts";`
- `case "verify": { ... }` 블록 전체를 다음으로 바꾼다:

```ts
    case "verify": {
      const given = readJson(io, need(o, "result"));
      throwIf(verifyAllocationResult(verificationInput(io, o), given));
      io.out(`OK ${(given as { result_digest: string }).result_digest}\n`);
      return 0;
    }
```

- `case "evaluate"`의 `printJson(io, evaluateFromFiles(io, o).result);` 를 `printJson(io, evaluateFromFiles(io, o));` 로 바꾼다.
- 기존 `evaluateFromFiles` 함수 전체를 다음 두 함수로 바꾼다:

```ts
/** evaluate·verify 공통 입력. 투영은 파일로 받지 않고 facts·usage·시점으로 계산한다. */
function verificationInput(io: Io, o: Opts): VerificationInput {
  return {
    policy: loadPolicy(io, need(o, "policy")),
    facts: readJson(io, need(o, "facts")) as FactsDocument,
    usage: readJson(io, need(o, "usage")) as Usage,
    asOf: need(o, "as-of"),
    knownAt: need(o, "known-at"),
    snapshot: readJson(io, need(o, "snapshot")) as Snapshot,
    events: readJson(io, need(o, "events")) as RevenueEvent[],
    runId: need(o, "run-id"),
  };
}

function evaluateFromFiles(io: Io, o: Opts): AllocationResult {
  const { usage, asOf, knownAt, ...rest } = verificationInput(io, o);
  const projection = projectToIr(rest.facts, usage, asOf, knownAt);
  if (!projection.ok) throw new VcrlError(projection.errors);
  const r = evaluate({ ...rest, projection: projection.value });
  if (!r.ok) throw new VcrlError(r.errors);
  return r.value;
}
```

- 사용하지 않게 된 import가 있으면(`ProjectionIr` 타입, `diag`, `Diagnostic`, `isPlainObject`, `digestOf` 중 다른 곳에서 안 쓰는 것) 제거한다. `tsc`가 안 쓰는 import를 오류로 보지 않더라도 지운다. `check` 명령은 `digestOf`를, `fmt`는 `isPlainObject`를 계속 쓴다.

- [ ] **Step 4: 통과 확인**

Run: `npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: fail 0, `TSC_OK`. 기존 CLI 테스트("evaluate from text reproduces ...", "evaluate and verify accept a JSON policy ...")도 그대로 통과해야 한다.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl"
git add src/allocation/verify.ts src/allocation/index.ts src/cli/main.ts test/allocation/verify.test.ts test/cli.test.ts
git commit -m "feat(vcrl): 라이브러리 결과 검증 verifyAllocationResult, CLI verify가 이를 사용

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 배포용 빌드와 tarball 스모크 테스트

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `scripts/smoke-pack.ts`
- Test: `test/package.test.ts`
- Modify: `/Users/changkyuneun/Vocal Combination/02_MDRL_언어규격/02_구현계획/VCRL_아키텍처_코어규격_설계_v1.0.md` (11절 상태)

**Interfaces:**
- Consumes: Task 1~3의 공개 API(`PROJECTION_FORMAT`, `ALLOCATION_RESULT_FORMAT`, `verifyAllocationResult`, `VerificationInput`)와 두 스키마 파일.
- Produces: `npm run build` → `dist/src/{core,facts,allocation,text}/index.{js,d.ts}`, `dist/bin/vcrl.js`. `npm run smoke` → 성공 시 마지막 줄 `smoke OK vcrl:sha256:…`.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/package.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const MODULES = ["core", "facts", "allocation", "text"];

test("exports point at built files that mirror src (spec 12.51)", () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), MODULES.map((m) => `./${m}`).sort());
  for (const m of MODULES) {
    assert.deepEqual(pkg.exports[`./${m}`], { types: `./dist/src/${m}/index.d.ts`, default: `./dist/src/${m}/index.js` });
    assert.ok(existsSync(new URL(`../src/${m}/index.ts`, import.meta.url)), m);
  }
  assert.deepEqual(pkg.bin, { vcrl: "./dist/bin/vcrl.js" });
  assert.ok(existsSync(new URL("../bin/vcrl.ts", import.meta.url)));
});

test("package metadata keeps it private, dependency-free and ships only dist and spec", () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(pkg.files, ["dist", "spec"]);
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.equal(pkg.scripts.smoke, "node scripts/smoke-pack.ts");
});

test("build config compiles only src and bin into dist with rewritten extensions", () => {
  const cfg = JSON.parse(readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8"));
  assert.equal(cfg.extends, "./tsconfig.json");
  assert.deepEqual(cfg.include, ["src", "bin"]);
  assert.equal(cfg.compilerOptions.outDir, "dist");
  assert.equal(cfg.compilerOptions.noEmit, false);
  assert.equal(cfg.compilerOptions.rewriteRelativeImportExtensions, true);
  assert.equal(cfg.compilerOptions.declaration, true);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/package.test.ts`
Expected: FAIL (exports가 아직 `./src/...ts`를 가리킴, `tsconfig.build.json` 없음).

- [ ] **Step 3: 빌드 설정 구현**

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rewriteRelativeImportExtensions": true,
    "declaration": true,
    "sourceMap": true,
    "inlineSources": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src", "bin"]
}
```

`package.json`을 다음으로 바꾼다(`devDependencies`는 기존 값 그대로 유지):

```json
{
  "name": "vcrl",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "vcrl": "./dist/bin/vcrl.js" },
  "exports": {
    "./core": { "types": "./dist/src/core/index.d.ts", "default": "./dist/src/core/index.js" },
    "./facts": { "types": "./dist/src/facts/index.d.ts", "default": "./dist/src/facts/index.js" },
    "./allocation": { "types": "./dist/src/allocation/index.d.ts", "default": "./dist/src/allocation/index.js" },
    "./text": { "types": "./dist/src/text/index.d.ts", "default": "./dist/src/text/index.js" }
  },
  "files": ["dist", "spec"],
  "scripts": {
    "test": "node --test \"test/**/*.test.ts\"",
    "typecheck": "tsc -p tsconfig.json",
    "clean": "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\"",
    "build": "npm run clean && tsc -p tsconfig.build.json",
    "prepack": "npm run build",
    "smoke": "node scripts/smoke-pack.ts"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "ajv": "^8.17.1",
    "typescript": "^5.9.0"
  }
}
```

`.gitignore`를 다음 세 줄로 만든다:

```
node_modules/
dist/
*.tgz
```

- [ ] **Step 4: 단위 테스트 통과와 빌드 확인**

Run: `node --test test/package.test.ts && npm run build && ls dist/src/core/index.js dist/src/core/index.d.ts dist/bin/vcrl.js && head -1 dist/bin/vcrl.js; grep -c '\.ts"' dist/src/allocation/evaluate.js; node dist/bin/vcrl.js help | head -1`
Expected: 3개 PASS. 파일 세 개 존재. 첫 줄 `#!/usr/bin/env node`. `.ts"` import 개수 `0`. 마지막 줄 `사용법: vcrl <명령> [옵션]`.

- [ ] **Step 5: 스모크 스크립트 작성**

`scripts/smoke-pack.ts`:

```ts
// tarball 스모크 테스트(스펙 12.52): npm pack → 임시 디렉터리에 설치 → 라이브러리·CLI·타입 선언 확인.
// 네트워크 없이 돈다(런타임 의존성이 없으므로 --offline 설치). 실행: npm run smoke
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "vcrl-smoke-"));
const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: "utf8" });
const read = (rel: string) => readFileSync(join(pkg, rel), "utf8");

try {
  // prepack의 빌드 출력이 --json 출력에 섞이지 않도록 빌드를 먼저 따로 돌리고 pack은 스크립트 없이 실행한다.
  sh("npm", ["run", "build"], pkg);
  const packed = JSON.parse(sh("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], pkg)) as { filename: string; files: { path: string }[] }[];
  const shipped = packed[0]!.files.map((f) => f.path);
  for (const must of [
    "dist/src/core/index.js", "dist/src/core/index.d.ts", "dist/src/facts/index.js", "dist/src/allocation/index.js",
    "dist/src/allocation/verify.d.ts", "dist/src/text/index.js", "dist/bin/vcrl.js",
    "spec/schema/projection.ir.schema.json", "spec/schema/allocation.result.schema.json", "spec/grammar/allocation.ebnf",
  ]) assert.ok(shipped.includes(must), `tarball is missing ${must}`);
  const leaked = shipped.filter((f) => /^(src|test|conformance|scripts|samples)\//.test(f));
  assert.deepEqual(leaked, [], "tarball must ship only dist and spec");

  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "vcrl-smoke-app", private: true, type: "module" }));
  sh("npm", ["install", "--offline", "--no-audit", "--no-fund", join(tmp, packed[0]!.filename)], app);

  const alloc = JSON.parse(read("conformance/allocation/001-basic/input.json"));
  const facts = JSON.parse(read(`conformance/facts/${alloc.facts_case}/input.json`));
  const expected = JSON.parse(read("conformance/allocation/001-basic/expected.json"));
  const put = (name: string, v: unknown) => writeFileSync(join(app, name), typeof v === "string" ? v : JSON.stringify(v));
  put("policy.vcrl", read("conformance/text/001-basic.vcrl"));
  put("facts.json", facts.facts);
  put("usage.json", facts.usage);
  put("snapshot.json", alloc.snapshot);
  put("events.json", alloc.events);

  // 1) 라이브러리: 네 진입점을 import해 컴파일 → 투영 → 평가 → 검증.
  const args = { asOf: facts.as_of, knownAt: facts.known_at, runId: alloc.run_id };
  put("check.mjs", `
import { readFileSync } from "node:fs";
import { digestOf } from "vcrl/core";
import { projectToIr } from "vcrl/facts";
import { evaluate, verifyAllocationResult } from "vcrl/allocation";
import { compileAllocation } from "vcrl/text";
const j = (f) => JSON.parse(readFileSync(f, "utf8"));
const { asOf, knownAt, runId } = ${JSON.stringify(args)};
const policy = compileAllocation(readFileSync("policy.vcrl", "utf8"));
if (!policy.ok) throw new Error(JSON.stringify(policy.errors));
const facts = j("facts.json"), usage = j("usage.json"), snapshot = j("snapshot.json"), events = j("events.json");
const p = projectToIr(facts, usage, asOf, knownAt);
if (!p.ok) throw new Error(JSON.stringify(p.errors));
const r = evaluate({ policy: policy.value, facts, projection: p.value, snapshot, events, runId });
if (!r.ok) throw new Error(JSON.stringify(r.errors));
const v = verifyAllocationResult({ policy: policy.value, facts, usage, asOf, knownAt, snapshot, events, runId }, r.value);
if (v.length > 0) throw new Error(JSON.stringify(v));
if (!digestOf({}).startsWith("vcrl:sha256:")) throw new Error("digestOf");
console.log(r.value.result_digest);
`);
  assert.equal(sh(process.execPath, ["check.mjs"], app).trim(), expected.result_digest, "library result digest");

  // 2) 설치된 CLI.
  const vcrl = join(app, "node_modules", ".bin", "vcrl");
  assert.deepEqual(JSON.parse(sh(vcrl, ["compile", "policy.vcrl"], app)), alloc.policy, "vcrl compile");
  const result = JSON.parse(sh(vcrl, [
    "evaluate", "--policy", "policy.vcrl", "--facts", "facts.json", "--usage", "usage.json",
    "--as-of", facts.as_of, "--known-at", facts.known_at, "--snapshot", "snapshot.json", "--events", "events.json", "--run-id", alloc.run_id,
  ], app));
  assert.equal(result.result_digest, expected.result_digest, "vcrl evaluate");

  // 3) 타입 선언 소비.
  put("types.ts", `
import { ALLOCATION_RESULT_FORMAT, evaluate, verifyAllocationResult, type AllocationResult, type VerificationInput } from "vcrl/allocation";
import { digestOf, type Diagnostic } from "vcrl/core";
import { PROJECTION_FORMAT, projectToIr, type ProjectionIr } from "vcrl/facts";
import { compileAllocation } from "vcrl/text";
export const formats: ["vcrl-alloc-result/1", "vcrl-projection/1"] = [ALLOCATION_RESULT_FORMAT, PROJECTION_FORMAT];
export const check = (input: VerificationInput, r: AllocationResult): Diagnostic[] => verifyAllocationResult(input, r);
export const fns = [evaluate, projectToIr, compileAllocation, digestOf] as const;
export type Fmt = ProjectionIr["format"];
// @ts-expect-error result_digest는 문자열이다
export const bad: AllocationResult["result_digest"] = 1;
`);
  put("tsconfig.json", {
    compilerOptions: {
      target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false,
      types: ["node"], typeRoots: [join(pkg, "node_modules", "@types")],
    },
    files: ["types.ts"],
  });
  sh(process.execPath, [join(pkg, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], app);

  console.log(`smoke OK ${expected.result_digest}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 6: 스모크 실행**

Run: `npm run smoke 2>&1 | tail -3`
Expected: 마지막 줄 `smoke OK vcrl:sha256:<conformance/allocation/001-basic/expected.json의 result_digest>`. 실패하면 원인(누락 파일, 타입 오류, digest 불일치)을 고친다. 스크립트의 단언을 느슨하게 만들어 통과시키지 않는다.

그 뒤 확인: `git status --short -- .` 에 `dist/`나 `*.tgz`가 나오지 않아야 한다(무시됨). 패키지 디렉터리에 tarball이 생기지 않았는지 `ls *.tgz 2>/dev/null | wc -l` → `0`.

- [ ] **Step 7: 설계문서 11절 상태 갱신**

`/Users/changkyuneun/Vocal Combination/02_MDRL_언어규격/02_구현계획/VCRL_아키텍처_코어규격_설계_v1.0.md`에서:
- 11절 머리의 `> 상태 기준일: 2026-09-29 (계획 1-A·1-B·1-C를 \`master\`에 머지한 시점).` 을 `> 상태 기준일: 2026-09-29 (계획 1-A·1-B·1-C·1-D 반영).` 로 바꾼다.
- 11.1.1 표의 "IR JSON 스키마" 행을 `| IR JSON 스키마 | \`spec/schema/\` envelope·facts IR·allocation IR, 투영 IR·안분 결과(형식 태그 포함, 12.48~12.49) | constraint·grant·approval IR 스키마 |` 로 바꾼다.
- 11.2 표의 첫 행(설치형 배포 빌드)을 `| ~~설치형 배포를 위한 빌드 단계~~ **완료(1-D, 12.51~12.52)** | 12.44 | 배포 채널(사설 레지스트리·git·tarball)은 시스템 통합에서 결정 |` 로 바꾼다.
- 11.2 표의 둘째 행(결과 IR 스키마)을 `| ~~평가 결과 IR의 JSON Schema·버전 태그~~ **완료(1-D, 12.48~12.49)** | 12.44 | |` 로 바꾼다.

- [ ] **Step 8: 최종 확인과 커밋**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK && git status --short -- . | grep -v '^??' ; git status --short -- . | grep '^??'`
Expected: fail 0, `TSC_OK`. 추적되지 않은 파일은 이번 태스크에서 만든 `tsconfig.build.json`, `scripts/smoke-pack.ts`, `test/package.test.ts`뿐이다.

```bash
cd "/Users/changkyuneun/Vocal Combination/04_구현_소스코드/mdrl"
git add tsconfig.build.json package.json .gitignore scripts/smoke-pack.ts test/package.test.ts \
  "/Users/changkyuneun/Vocal Combination/02_MDRL_언어규격/02_구현계획/VCRL_아키텍처_코어규격_설계_v1.0.md"
git commit -m "build(vcrl): dist 배포 빌드, exports·bin을 dist로, tarball 스모크 테스트

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
