# VCRL 1-C: 텍스트 문법 · 파서 · 포매터 · CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사람이 작성하는 안분 정책 텍스트(VCRL allocation 문법)를 IR로 컴파일하는 렉서·파서, IR을 정규 텍스트로 되돌리는 포매터(allocation 왕복, facts는 읽기 전용 표시), `vcrl` CLI(`compile`·`fmt`·`check`·`project`·`evaluate`·`verify`·`activate`)를 만들고, 투영 재검증·공개본 검증 보강·오류 코드 목록 테스트로 엔진을 마무리한다.

**Architecture:** `src/text/`에 렉서(`lexer.ts`), 역할 추론(`roles.ts`), 파서(`parse-allocation.ts`), 포매터(`format-allocation.ts`, `format-facts.ts`)를 두고 `vcrl/text`로 노출한다. 파서는 문법 오류를 `PARSE_*` 진단(경로 `@줄:열`)으로 돌려주고, 파싱 결과는 항상 `validateAllocation`을 거친다. CLI는 입출력을 주입받는 순수 함수 `run(argv, io)`(`src/cli/main.ts`)와 얇은 실행 파일(`bin/vcrl.ts`)로 나눈다.

**Tech Stack:** Node.js ≥ 24 (네이티브 TypeScript), TypeScript 5.9 (`erasableSyntaxOnly`, 타입검사 전용), `node:test`, `node:util.parseArgs`. 런타임 의존성 없음.

**상위 스펙:** `02_설계문서/VCRL_보컬조합권리언어/VCRL_아키텍처_코어규격_설계_v1.0.md` 5.2(문법 예시), 10.2(CLI), 12장(1~36). 사용자 결정(2026-09-28): allocation만 텍스트 입력, facts는 텍스트 출력만. 버킷 역할은 자동 추론하고 필요할 때만 `as ROLE`. legacy-v1 변환기는 연기.

## Global Constraints

- 런타임 의존성 0. `dependencies` 필드를 만들지 않는다.
- TypeScript는 erasable syntax만 사용: `enum`, `namespace`, 생성자 parameter property 금지. 상대 import는 `.ts` 확장자를 붙인다. 타입 전용 import는 `import type`.
- 라이브러리 코드에서 부동소수 금지(비율 표시도 정수 연산으로 만든다). IR에는 JSON number를 쓰지 않는다.
- 오류 코드는 `src/core/errors.ts`의 `ERROR_CODES`에만 정의하고 `spec/error-codes.md`와 항상 일치시킨다(테스트가 강제). Enum 값은 `src/core/enums.ts`에만 정의한다.
- 식별자 조회는 소유 속성만 본다(`Object.hasOwn`). `__proto__`는 유효한 id가 아니다.
- `JSON.stringify`로 `Ratio`/BigInt가 든 값을 직렬화할 때는 BigInt-safe replacer를 쓴다.
- 작업 디렉터리: `/Users/changkyuneun/Vocal Combination/03_구현문서_코드/vcrl` (git 루트 `/Users/changkyuneun/Vocal Combination`). 저장소에는 무관한 커밋 안 된 변경이 많다. `git add`는 태스크에 나열된 파일만 한다. 임시·재현용 파일은 남기지 않는다.
- 커밋 메시지: 제목, 빈 줄, 마지막 줄에 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
03_구현문서_코드/vcrl/
  package.json            (Modify: "./text" export, "bin")
  tsconfig.json           (Modify: include "bin")
  spec/error-codes.md     (Modify: PARSE_*)
  spec/grammar/allocation.ebnf   (Create: 텍스트 문법 정본)
  src/core/errors.ts      (Modify: PARSE_SYNTAX, PARSE_ROLE_REQUIRED, PARSE_UNSUPPORTED)
  src/text/
    lexer.ts              tokenize, Token, at
    roles.ts              inferRole
    parse-allocation.ts   parseAllocation, compileAllocation
    format-allocation.ts  formatAllocation, formatPercent
    format-facts.ts       formatFacts
    index.ts
  src/facts/result.ts     (Modify: verifyProjection)
  src/facts/validate.ts   (Modify: 공개본 검증 보강)
  src/cli/main.ts         run(argv, io)
  bin/vcrl.ts
  samples/VC-ALLOC-DEFAULT-V1.vcrl, samples/VC-ALLOC-HYBRID-V2.vcrl
  conformance/text/001-basic.vcrl
  test/text/*.test.ts, test/cli.test.ts, test/error-catalog.test.ts, test/facts/*.test.ts (Modify)
```

---

### Task 1: 파서 오류 코드 · 렉서

**Files:**
- Modify: `src/core/errors.ts`, `spec/error-codes.md`
- Create: `src/text/lexer.ts`
- Test: `test/text/lexer.test.ts`

**Interfaces:**
- Consumes: `fail` (errors.ts)
- Produces: 오류 코드 `PARSE_SYNTAX`, `PARSE_ROLE_REQUIRED`, `PARSE_UNSUPPORTED`; `type TokenKind = "ident" | "string" | "number" | "punct" | "eof"`, `type Token = { kind: TokenKind; text: string; line: number; col: number }`, `at(pos: { line: number; col: number }): string` (→ `"@줄:열"`), `tokenize(src: string): Token[]` (실패 시 `VcrlError`)

**어휘 규칙:** 공백·줄바꿈 무시, `//`부터 줄 끝까지 주석. 문자열은 `"…"` 한 줄, 이스케이프는 `\"`와 `\\`만. 숫자는 `\d+(\.\d+)?` 뒤에 선택적 `%` 또는 `bps`, 바로 뒤에 식별자 문자가 오면 오류. 식별자는 `[A-Za-z_][A-Za-z0-9_]*`에 `.`·`-` 뒤 영숫자가 이어지는 형태(`-`로 끝날 수 없음). 구두점은 `|>`, `->`, `==`, `{ } ( ) [ ] ; : , = @`. 숫자로 시작하는 id(예: `10`)는 따옴표로 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/text/lexer.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { at, tokenize } from "../../src/text/lexer.ts";
import { VcrlError } from "../../src/core/errors.ts";

const kinds = (src: string) => tokenize(src).map((t) => [t.kind, t.text]);
const failsAt = (src: string, code: string, path: string) =>
  assert.throws(() => tokenize(src), (e: unknown) =>
    e instanceof VcrlError && e.diagnostics[0]?.code === code && e.diagnostics[0]?.path === path);

test("tokens: idents, strings, numbers with units, punctuation, comments", () => {
  assert.deepEqual(kinds('master = graph(MASTER_OWNER) : 45%; // 주석\nops = 500bps;'), [
    ["ident", "master"], ["punct", "="], ["ident", "graph"], ["punct", "("], ["ident", "MASTER_OWNER"], ["punct", ")"],
    ["punct", ":"], ["number", "45%"], ["punct", ";"],
    ["ident", "ops"], ["punct", "="], ["number", "500bps"], ["punct", ";"], ["eof", ""],
  ]);
  assert.deepEqual(kinds('uses facts "nova-debut-01"@1 x |> y -> z == 12.5%'), [
    ["ident", "uses"], ["ident", "facts"], ["string", "nova-debut-01"], ["punct", "@"], ["number", "1"],
    ["ident", "x"], ["punct", "|>"], ["ident", "y"], ["punct", "->"], ["ident", "z"], ["punct", "=="], ["number", "12.5%"], ["eof", ""],
  ]);
});

test("idents may contain . and - between alphanumerics but not end with -", () => {
  assert.deepEqual(kinds("pak_nova.v-2 DISPUTED->hold"), [
    ["ident", "pak_nova.v-2"], ["ident", "DISPUTED"], ["punct", "->"], ["ident", "hold"], ["eof", ""],
  ]);
});

test("string escapes", () => {
  assert.deepEqual(kinds('"a\\"b\\\\c"'), [["string", 'a"b\\c'], ["eof", ""]]);
});

test("positions are 1-based line:col", () => {
  const t = tokenize("a\n  bb");
  assert.deepEqual(t.map((x) => [x.text, x.line, x.col]), [["a", 1, 1], ["bb", 2, 3], ["", 2, 5]]);
  assert.equal(at({ line: 3, col: 7 }), "@3:7");
});

test("lexical errors", () => {
  failsAt('"open', "PARSE_SYNTAX", "@1:1");
  failsAt('x "a\\nb"', "PARSE_SYNTAX", "@1:3");
  failsAt("10abc", "PARSE_SYNTAX", "@1:1");
  failsAt("a # b", "PARSE_SYNTAX", "@1:3");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/text/lexer.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/text/lexer.ts`).

- [ ] **Step 3: 구현**

`src/core/errors.ts` — `ERROR_CODES`의 `ALLOC_ROUNDING_INVARIANT` 줄 뒤에 추가:
```ts
  PARSE_SYNTAX: "텍스트 문법 오류",
  PARSE_ROLE_REQUIRED: "버킷 역할을 추론할 수 없어 `as <ROLE>` 표기가 필요하다",
  PARSE_UNSUPPORTED: "엔진의 고정 의미와 다른 guard·exceptions 문장은 지원하지 않는다",
```

`spec/error-codes.md` — 첫 표의 `ALLOC_ROUNDING_INVARIANT` 행 뒤에 추가:
```markdown
| `PARSE_SYNTAX` | 텍스트 문법 오류(경로 `@줄:열`) | `tokenize`, `parseAllocation` |
| `PARSE_ROLE_REQUIRED` | 버킷 역할 추론 불가, `as <ROLE>` 필요 | `parseAllocation` |
| `PARSE_UNSUPPORTED` | 고정 의미와 다른 guard·exceptions 문장 | `parseAllocation` |
```

`src/text/lexer.ts`:
```ts
import { fail } from "../core/errors.ts";

export type TokenKind = "ident" | "string" | "number" | "punct" | "eof";
export type Token = { kind: TokenKind; text: string; line: number; col: number };

const PUNCT2 = ["|>", "->", "=="];
const PUNCT1 = "{}()[];:,=@";
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)*/y;
const NUMBER_RE = /\d+(?:\.\d+)?(?:%|bps)?/y;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/** 진단 경로 표기: `@줄:열`(1부터). */
export function at(pos: { line: number; col: number }): string {
  return `@${pos.line}:${pos.col}`;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance(1);
      continue;
    }
    if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") advance(1);
      continue;
    }
    const pos = { line, col };
    if (c === '"') {
      let j = i + 1;
      let text = "";
      for (;;) {
        const ch = src[j];
        if (ch === undefined || ch === "\n") fail("PARSE_SYNTAX", at(pos), "unterminated string");
        if (ch === '"') break;
        if (ch === "\\") {
          const nx = src[j + 1];
          if (nx !== '"' && nx !== "\\") fail("PARSE_SYNTAX", at(pos), "only \\\" and \\\\ escapes are supported");
          text += nx;
          j += 2;
          continue;
        }
        text += ch;
        j++;
      }
      out.push({ kind: "string", text, ...pos });
      advance(j + 1 - i);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      out.push({ kind: "punct", text: two, ...pos });
      advance(2);
      continue;
    }
    if (PUNCT1.includes(c)) {
      out.push({ kind: "punct", text: c, ...pos });
      advance(1);
      continue;
    }
    if (c >= "0" && c <= "9") {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src)!;
      const after = src[i + m[0].length];
      if (after !== undefined && IDENT_CHAR.test(after)) fail("PARSE_SYNTAX", at(pos), "invalid number (quote ids that start with a digit)");
      out.push({ kind: "number", text: m[0], ...pos });
      advance(m[0].length);
      continue;
    }
    IDENT_RE.lastIndex = i;
    const id = IDENT_RE.exec(src);
    if (id) {
      out.push({ kind: "ident", text: id[0], ...pos });
      advance(id[0].length);
      continue;
    }
    fail("PARSE_SYNTAX", at(pos), `unexpected character ${JSON.stringify(c)}`);
  }
  out.push({ kind: "eof", text: "", line, col });
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/text/lexer.test.ts && npm test && npx tsc -p tsconfig.json`
Expected: 전부 PASS(오류 코드 문서 동기화 포함).

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 03_구현문서_코드/vcrl/src/core/errors.ts 03_구현문서_코드/vcrl/spec/error-codes.md 03_구현문서_코드/vcrl/src/text/lexer.ts 03_구현문서_코드/vcrl/test/text/lexer.test.ts && git commit -m "$(printf 'feat(vcrl): 텍스트 렉서와 파서 오류 코드\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 2: allocation 파서 · 역할 추론 · 문법 정본

**Files:**
- Create: `src/text/roles.ts`, `src/text/parse-allocation.ts`, `spec/grammar/allocation.ebnf`, `conformance/text/001-basic.vcrl`
- Test: `test/text/parse.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `at`, `Token` (T1); `attempt`, `fail`, `ok`, `err`, `Result`; `parseBps`, `percentToBps`; `validateAllocation`; allocation 타입; `ClaimantRole`
- Produces: `inferRole(v: VectorExpr): ClaimantRole | undefined`, `parseAllocation(src: string): Result<AllocationDocument>`(문법만), `compileAllocation(src: string): Result<AllocationDocument>`(문법 + `validateAllocation`)

**문법 (`spec/grammar/allocation.ebnf`에 그대로 기록):**
```ebnf
(* VCRL allocation 텍스트 문법 v1.0 — IR은 스펙 12.21. 공백·줄바꿈 무시, // 주석. *)
program     = "allocation" string "version" int "{" { block } "}" EOF ;
block       = uses | visibility | scope | bind | tier1 | tier2 | guard | exceptions | rounding ;
(* scope·bind·tier1·tier2·rounding은 정확히 한 번, visibility·guard·exceptions는 최대 한 번, uses는 0회 이상. 블록 순서는 자유. *)
uses        = "uses" "facts" string "@" int "digest" string ";" ;
visibility  = "visibility" ident ";" ;                         (* 생략 시 PARTIES *)
scope       = "scope" "{" "pack" ":" id ";" "events" ":" "[" ident { "," ident } "]" ";" "currency" ":" ident ";" "}" ;
bind        = "bind" "{" "time" ":" ident ";" "}" ;
tier1       = "tier1" "{" { ident "=" ratio ";" } "}" ;
tier2       = "tier2" ident "{" "split" "{" { bucket } "}" "}" ;  (* tier2 뒤 이름 = 권리자 풀이 되는 tier1 버킷 *)
bucket      = ident "=" vector ":" ratio [ "as" ident ] ";" ;
vector      = primary { "|>" ( "cap" "(" ratio ")" | "floor_guarantee" "(" ratio ")" ) } ;
primary     = "graph" "(" ident ")" [ "via" "mandate" ]
            | "contract" "(" id ")"
            | "member_pct" "(" ")"
            | "performance_pool" "(" ident { "," ident ":" ratio } ")"
            | "mix" "(" ratio ":" vector { "," ratio ":" vector } ")" ;
guard       = "guard" "{" { "require" ( "covered" "(" "all_claimants" ")" | "sum" "(" "split" ")" "==" ratio ) ";" } "}" ;
exceptions  = "exceptions" "{" { "on" ident "->" "hold" "(" ident ")" ";" } "}" ;
rounding    = "rounding" "{" "method" ":" ident ";" "tie" ":" ident ";" "}" ;
id          = ident | string ;
ratio       = number-with-% (소수 둘째 자리까지) | number-with-bps (정수) ;
int         = 양의 정수(단위 없음) ;
(* guard는 require covered(all_claimants)와 require sum(split) == 100%(=10000bps)만,
   exceptions는 on DISPUTED -> hold(DISPUTED_SHARE)와 on FRAUD_FLAG -> hold(RIGHTS_POOL)만 허용(엔진 고정 의미, IR에 남지 않음).
   그 밖의 문장은 PARSE_UNSUPPORTED. 역할 생략 시 inferRole로 추론, 추론 불가면 PARSE_ROLE_REQUIRED. *)
```

**역할 추론:** 벡터 식의 잎을 모은다. `graph(r)` → r, `performance_pool`·`member_pct` → 실연 부류, `contract` → 없음, `mix`·`cap`·`floor_guarantee` → 자식. 잎이 없으면 추론 불가. 모든 잎이 실연 부류이거나 실연 graph이면: 실연 graph 하나만 있고 풀·멤버 비율이 없을 때 그 역할, 아니면 `PERFORMER_FEATURED`. 그렇지 않고 잎이 정확히 한 역할이면 그 역할. 그 밖은 추론 불가.

- [ ] **Step 1: 적합성 텍스트 작성**

`conformance/text/001-basic.vcrl` (컴파일 결과가 `conformance/allocation/001-basic/input.json`의 `policy`와 같아야 한다):
```
// conformance/allocation/001-basic의 정책을 텍스트로 쓴 것. 컴파일 결과는 그 IR과 같아야 한다.
allocation "VC-ALLOC-NOVA-02" version 1 {
  uses facts "nova-debut-01"@1 digest "vcrl:sha256:4c8fc5573e79e0da0e23eee13566d4af8c5aa5fd319319f7b2684a78077ca6f4";
  scope { pack: pak_nova_summer_02; events: [PRIMARY, RESALE]; currency: KRW; }
  bind { time: ISSUE_TIME; }
  tier1 {
    platform = 25%;
    ops = 500bps;
    rights = 70%;
  }
  tier2 rights {
    split {
      master = graph(MASTER_OWNER) : 45%;
      performer = performance_pool(HYBRID, fixed: 40%, usage: 60%, featured_weight: 70%) : 45%;
      work = graph(WORK_AUTHOR) via mandate : 10%;
    }
  }
  guard { require covered(all_claimants); require sum(split) == 100%; }
  exceptions { on DISPUTED -> hold(DISPUTED_SHARE); on FRAUD_FLAG -> hold(RIGHTS_POOL); }
  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/text/parse.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileAllocation, parseAllocation } from "../../src/text/parse-allocation.ts";
import { inferRole } from "../../src/text/roles.ts";
import type { VectorExpr } from "../../src/allocation/types.ts";
import { loadAllocationCase } from "../helpers.ts";

const basicText = () => readFileSync(new URL("../../conformance/text/001-basic.vcrl", import.meta.url), "utf8");
const errs = (src: string) => {
  const r = compileAllocation(src);
  return r.ok ? [] : r.errors.map((e) => [e.code, e.path]);
};
/** 기본 텍스트의 split 블록 안쪽을 바꿔 끼운다. */
const withSplit = (body: string) => basicText().replace(/split \{[\s\S]*?\n    \}/, `split {\n${body}\n    }`);

test("the conformance text compiles to exactly the conformance IR", () => {
  const r = compileAllocation(basicText());
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value, loadAllocationCase().policy);
});

test("role inference", () => {
  const g = (role: string, via?: boolean): VectorExpr => ({ fn: "graph", role, ...(via ? { via_mandate: true } : {}) } as VectorExpr);
  const pool: VectorExpr = { fn: "performance_pool", mode: "FIXED" };
  const contract: VectorExpr = { fn: "contract", party: "pty_x" };
  assert.equal(inferRole(g("WORK_AUTHOR", true)), "WORK_AUTHOR");
  assert.equal(inferRole(pool), "PERFORMER_FEATURED");
  assert.equal(inferRole({ fn: "member_pct" }), "PERFORMER_FEATURED");
  assert.equal(inferRole(g("PERFORMER_NON_FEATURED")), "PERFORMER_NON_FEATURED");
  assert.equal(inferRole({ fn: "mix", parts: [{ weight: "5000", of: g("PERFORMER_NON_FEATURED") }, { weight: "5000", of: pool }] }), "PERFORMER_FEATURED");
  assert.equal(inferRole({ fn: "mix", parts: [{ weight: "5000", of: g("MASTER_OWNER") }, { weight: "5000", of: contract }] }), "MASTER_OWNER");
  assert.equal(inferRole({ fn: "cap", max: "5000", of: pool }), "PERFORMER_FEATURED");
  assert.equal(inferRole(contract), undefined);
  assert.equal(inferRole({ fn: "mix", parts: [{ weight: "5000", of: g("MASTER_OWNER") }, { weight: "5000", of: g("WORK_AUTHOR") }] }), undefined);
});

test("pipes, mix, quoted ids, explicit roles and visibility map to IR", () => {
  const src = withSplit([
    '      master = mix(50%: graph(MASTER_OWNER), 50%: contract("10")) |> cap(60%) |> floor_guarantee(0.05%) : 45%;',
    "      performer = member_pct() : 45%;",
    "      agency = contract(pty_agency_s) : 10% as AGENCY;",
  ].join("\n")).replace("  bind", "  visibility PUBLIC;\n  bind");
  const r = parseAllocation(src);
  assert.ok(r.ok, JSON.stringify(r));
  const split = r.value.body.tier2.split;
  assert.equal(r.value.visibility_default, "PUBLIC");
  assert.deepEqual(split[0], {
    name: "master", bps: "4500", role: "MASTER_OWNER",
    vector: {
      fn: "floor_guarantee", min: "5",
      of: { fn: "cap", max: "6000", of: { fn: "mix", parts: [
        { weight: "5000", of: { fn: "graph", role: "MASTER_OWNER" } },
        { weight: "5000", of: { fn: "contract", party: "10" } },
      ] } },
    },
  });
  assert.deepEqual(split[1], { name: "performer", bps: "4500", role: "PERFORMER_FEATURED", vector: { fn: "member_pct" } });
  assert.deepEqual(split[2], { name: "agency", bps: "1000", role: "AGENCY", vector: { fn: "contract", party: "pty_agency_s" } });
});

test("role required when it cannot be inferred", () => {
  const src = withSplit([
    "      master = graph(MASTER_OWNER) : 45%;",
    "      performer = member_pct() : 45%;",
    "      agency = contract(pty_agency_s) : 10%;",
  ].join("\n"));
  const e = errs(src);
  assert.equal(e.length, 1);
  assert.equal(e[0]![0], "PARSE_ROLE_REQUIRED");
  assert.match(String(e[0]![1]), /^@\d+:7$/);
});

test("syntax errors carry positions", () => {
  assert.deepEqual(errs('allocation "x" version 1 { scope { pack p; } }'), [["PARSE_SYNTAX", "@1:41"]]);
  assert.deepEqual(errs('allocation "x" version 0 { }'), [["PARSE_SYNTAX", "@1:24"]]);
  const dup = basicText().replace("  bind { time: ISSUE_TIME; }", "  bind { time: ISSUE_TIME; }\n  bind { time: ISSUE_TIME; }");
  assert.equal(errs(dup)[0]![0], "PARSE_SYNTAX");
  const missing = basicText().replace("  bind { time: ISSUE_TIME; }\n", "");
  assert.equal(errs(missing)[0]![0], "PARSE_SYNTAX");
  assert.equal(errs(basicText() + "\nextra")[0]![0], "PARSE_SYNTAX");
  assert.equal(errs(basicText().replace("45%;\n      performer", "45.123%;\n      performer"))[0]![0], "CORE_TYPE_ERROR");
  assert.equal(errs(basicText().replace("500bps", "5.5bps"))[0]![0], "PARSE_SYNTAX");
});

test("guard and exceptions accept only the engine's fixed semantics", () => {
  assert.equal(errs(basicText().replace("sum(split) == 100%", "sum(split) == 90%"))[0]![0], "PARSE_UNSUPPORTED");
  assert.equal(errs(basicText().replace("require covered(all_claimants)", "require covered(some)"))[0]![0], "PARSE_UNSUPPORTED");
  assert.equal(errs(basicText().replace("hold(DISPUTED_SHARE)", "hold(AFFECTED_BUCKET)"))[0]![0], "PARSE_UNSUPPORTED");
});

test("compile runs the IR validator after parsing", () => {
  const e = errs(basicText().replace("rights = 70%", "rights = 60%"));
  assert.deepEqual(e.map((x) => x[0]), ["ALLOC_SUM_MISMATCH"]);
  assert.equal(parseAllocation(basicText().replace("rights = 70%", "rights = 60%")).ok, true);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/text/parse.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: 구현**

`src/text/roles.ts`:
```ts
import type { VectorExpr } from "../allocation/types.ts";
import type { ClaimantRole } from "../facts/types.ts";

const PERFORMER_ROLES: ReadonlySet<string> = new Set(["PERFORMER_FEATURED", "PERFORMER_NON_FEATURED"]);
const POOL = "@pool";

/** 텍스트에서 `as ROLE`을 생략한 버킷의 역할을 벡터 식에서 추론한다(스펙 12.38). 추론할 수 없으면 undefined. */
export function inferRole(v: VectorExpr): ClaimantRole | undefined {
  const leaves = new Set<string>();
  const walk = (e: VectorExpr): void => {
    switch (e.fn) {
      case "graph":
        leaves.add(e.role);
        break;
      case "performance_pool":
      case "member_pct":
        leaves.add(POOL);
        break;
      case "mix":
        for (const p of e.parts) walk(p.of);
        break;
      case "cap":
      case "floor_guarantee":
        walk(e.of);
        break;
      case "contract":
        break;
    }
  };
  walk(v);
  if (leaves.size === 0) return undefined;
  const all = [...leaves];
  if (all.every((r) => r === POOL || PERFORMER_ROLES.has(r))) {
    const graphs = all.filter((r) => r !== POOL);
    return graphs.length === 1 && !leaves.has(POOL) ? (graphs[0] as ClaimantRole) : "PERFORMER_FEATURED";
  }
  return all.length === 1 ? (all[0] as ClaimantRole) : undefined;
}
```

`src/text/parse-allocation.ts`:
```ts
import { parseBps, percentToBps } from "../core/bps.ts";
import { attempt, err, fail, ok, type Result } from "../core/errors.ts";
import type { EnumValue } from "../core/enums.ts";
import type { Dependency } from "../core/envelope.ts";
import { validateAllocation } from "../allocation/validate.ts";
import type { AllocationBody, AllocationDocument, SplitBucket, Tier1Bucket, VectorExpr } from "../allocation/types.ts";
import type { ClaimantRole } from "../facts/types.ts";
import { at, tokenize, type Token } from "./lexer.ts";
import { inferRole } from "./roles.ts";

const REQUIRED_BLOCKS = ["scope", "bind", "tier1", "tier2", "rounding"] as const;
const FIXED_EXCEPTIONS: Readonly<Record<string, string>> = { DISPUTED: "DISPUTED_SHARE", FRAUD_FLAG: "RIGHTS_POOL" };

/** 텍스트를 IR로 파싱만 한다(IR 검증 없음). 문법 오류는 PARSE_* 진단으로 돌려준다. */
export function parseAllocation(src: string): Result<AllocationDocument> {
  return attempt(() => parseProgram(tokenize(src)));
}

/** 파싱 후 validateAllocation까지 통과해야 성공이다. */
export function compileAllocation(src: string): Result<AllocationDocument> {
  const parsed = parseAllocation(src);
  if (!parsed.ok) return parsed;
  const errors = validateAllocation(parsed.value);
  return errors.length > 0 ? err(errors) : ok(parsed.value);
}

function parseProgram(toks: readonly Token[]): AllocationDocument {
  let k = 0;
  const peek = () => toks[k]!;
  const next = () => toks[k++]!;
  const describe = (t: Token) => (t.kind === "eof" ? "end of input" : `${t.kind} ${JSON.stringify(t.text)}`);
  const isP = (t: Token, s: string) => t.kind === "punct" && t.text === s;
  const isW = (t: Token, s: string) => t.kind === "ident" && t.text === s;
  const expectP = (s: string): Token => {
    const t = next();
    if (!isP(t, s)) fail("PARSE_SYNTAX", at(t), `expected "${s}", found ${describe(t)}`);
    return t;
  };
  const expectW = (s: string): Token => {
    const t = next();
    if (!isW(t, s)) fail("PARSE_SYNTAX", at(t), `expected ${s}, found ${describe(t)}`);
    return t;
  };
  const ident = (what: string): string => {
    const t = next();
    if (t.kind !== "ident") fail("PARSE_SYNTAX", at(t), `expected ${what}, found ${describe(t)}`);
    return t.text;
  };
  const str = (what: string): string => {
    const t = next();
    if (t.kind !== "string") fail("PARSE_SYNTAX", at(t), `expected ${what} (quoted string), found ${describe(t)}`);
    return t.text;
  };
  const id = (what: string): string => {
    const t = next();
    if (t.kind !== "ident" && t.kind !== "string") fail("PARSE_SYNTAX", at(t), `expected ${what}, found ${describe(t)}`);
    return t.text;
  };
  const int = (what: string): string => {
    const t = next();
    if (t.kind !== "number" || !/^[1-9]\d*$/.test(t.text)) fail("PARSE_SYNTAX", at(t), `expected ${what} (positive integer), found ${describe(t)}`);
    return t.text;
  };
  const ratio = (): string => {
    const t = next();
    if (t.kind === "number" && t.text.endsWith("bps")) {
      const raw = t.text.slice(0, -3);
      if (!/^\d+$/.test(raw)) fail("PARSE_SYNTAX", at(t), "bps must be an integer");
      return String(parseBps(raw, at(t)));
    }
    if (t.kind === "number" && t.text.endsWith("%")) return String(percentToBps(t.text.slice(0, -1), at(t)));
    return fail("PARSE_SYNTAX", at(t), `expected a ratio like 45% or 4500bps, found ${describe(t)}`);
  };
  const list = <T>(item: () => T): T[] => {
    const out = [item()];
    while (isP(peek(), ",")) {
      next();
      out.push(item());
    }
    return out;
  };

  const primary = (): VectorExpr => {
    const t = next();
    if (t.kind !== "ident") fail("PARSE_SYNTAX", at(t), `expected a vector expression, found ${describe(t)}`);
    switch (t.text) {
      case "graph": {
        expectP("(");
        const role = ident("claimant role") as ClaimantRole;
        expectP(")");
        if (isW(peek(), "via")) {
          next();
          expectW("mandate");
          return { fn: "graph", role, via_mandate: true };
        }
        return { fn: "graph", role };
      }
      case "contract": {
        expectP("(");
        const party = id("party id");
        expectP(")");
        return { fn: "contract", party };
      }
      case "member_pct":
        expectP("(");
        expectP(")");
        return { fn: "member_pct" };
      case "performance_pool": {
        expectP("(");
        const e: Record<string, string> = { fn: "performance_pool", mode: ident("pool mode") };
        while (isP(peek(), ",")) {
          next();
          const key = next();
          if (key.kind !== "ident") fail("PARSE_SYNTAX", at(key), `expected an argument name, found ${describe(key)}`);
          if (Object.hasOwn(e, key.text)) fail("PARSE_SYNTAX", at(key), `duplicate argument ${key.text}`);
          expectP(":");
          e[key.text] = ratio();
        }
        expectP(")");
        return e as unknown as VectorExpr;
      }
      case "mix": {
        expectP("(");
        const parts = list(() => {
          const weight = ratio();
          expectP(":");
          return { weight, of: vector() };
        });
        expectP(")");
        return { fn: "mix", parts };
      }
      default:
        return fail("PARSE_SYNTAX", at(t), `unknown vector function ${t.text}`);
    }
  };
  const vector = (): VectorExpr => {
    let v = primary();
    while (isP(peek(), "|>")) {
      next();
      const t = next();
      if (isW(t, "cap")) {
        expectP("(");
        const max = ratio();
        expectP(")");
        v = { fn: "cap", max, of: v };
      } else if (isW(t, "floor_guarantee")) {
        expectP("(");
        const min = ratio();
        expectP(")");
        v = { fn: "floor_guarantee", min, of: v };
      } else {
        fail("PARSE_SYNTAX", at(t), `expected cap or floor_guarantee after |>, found ${describe(t)}`);
      }
    }
    return v;
  };

  const tier1Buckets = (): Tier1Bucket[] => {
    expectP("{");
    const out: Tier1Bucket[] = [];
    while (!isP(peek(), "}")) {
      const name = ident("bucket name");
      expectP("=");
      out.push({ name, bps: ratio() });
      expectP(";");
    }
    expectP("}");
    return out;
  };
  const splitBuckets = (): SplitBucket[] => {
    expectP("{");
    const out: SplitBucket[] = [];
    while (!isP(peek(), "}")) {
      const start = peek();
      const name = ident("bucket name");
      expectP("=");
      const vec = vector();
      expectP(":");
      const bps = ratio();
      let role: string | undefined;
      if (isW(peek(), "as")) {
        next();
        role = ident("claimant role");
      } else {
        role = inferRole(vec);
      }
      if (role === undefined) fail("PARSE_ROLE_REQUIRED", at(start), `bucket ${name}: add "as <ROLE>"`);
      expectP(";");
      out.push({ name, bps, role: role as ClaimantRole, vector: vec });
    }
    expectP("}");
    return out;
  };
  const guard = (): void => {
    expectP("{");
    while (!isP(peek(), "}")) {
      expectW("require");
      const t = next();
      if (isW(t, "covered")) {
        expectP("(");
        const what = next();
        if (!isW(what, "all_claimants")) fail("PARSE_UNSUPPORTED", at(what), "only covered(all_claimants) is supported");
        expectP(")");
      } else if (isW(t, "sum")) {
        expectP("(");
        expectW("split");
        expectP(")");
        expectP("==");
        const total = peek();
        if (ratio() !== "10000") fail("PARSE_UNSUPPORTED", at(total), "sum(split) must be 100%");
      } else {
        fail("PARSE_UNSUPPORTED", at(t), `unsupported guard ${describe(t)}`);
      }
      expectP(";");
    }
    expectP("}");
  };
  const exceptions = (): void => {
    expectP("{");
    while (!isP(peek(), "}")) {
      expectW("on");
      const on = next();
      expectP("->");
      expectW("hold");
      expectP("(");
      const target = next();
      expectP(")");
      expectP(";");
      if (on.kind !== "ident" || !Object.hasOwn(FIXED_EXCEPTIONS, on.text) || FIXED_EXCEPTIONS[on.text] !== target.text) {
        fail("PARSE_UNSUPPORTED", at(on), "exceptions are fixed: on DISPUTED -> hold(DISPUTED_SHARE); on FRAUD_FLAG -> hold(RIGHTS_POOL)");
      }
    }
    expectP("}");
  };

  expectW("allocation");
  const docId = str("policy id");
  expectW("version");
  const version = int("version");
  expectP("{");
  const seen = new Set<string>();
  const once = (t: Token) => {
    if (seen.has(t.text)) fail("PARSE_SYNTAX", at(t), `duplicate ${t.text} block`);
    seen.add(t.text);
  };
  const dependsOn: Dependency[] = [];
  let visibility = "PARTIES";
  let scope: AllocationBody["scope"] | undefined;
  let bind: AllocationBody["bind"] | undefined;
  let tier1: Tier1Bucket[] = [];
  let rightsName = "";
  let split: SplitBucket[] = [];
  let rounding: AllocationBody["rounding"] | undefined;

  while (!isP(peek(), "}")) {
    const t = next();
    if (t.kind !== "ident") fail("PARSE_SYNTAX", at(t), `expected a block keyword, found ${describe(t)}`);
    switch (t.text) {
      case "uses": {
        expectW("facts");
        const factsId = str("facts id");
        expectP("@");
        const factsVersion = int("facts version");
        expectW("digest");
        const digest = str("digest");
        expectP(";");
        dependsOn.push({ ref: `vc:facts/${factsId}@${factsVersion}`, digest });
        break;
      }
      case "visibility":
        once(t);
        visibility = ident("visibility");
        expectP(";");
        break;
      case "scope": {
        once(t);
        expectP("{");
        expectW("pack");
        expectP(":");
        const pack = id("pack id");
        expectP(";");
        expectW("events");
        expectP(":");
        expectP("[");
        const events = list(() => ident("event type")) as EnumValue<"event_type">[];
        expectP("]");
        expectP(";");
        expectW("currency");
        expectP(":");
        const currency = ident("currency");
        expectP(";");
        expectP("}");
        scope = { pack, events, currency };
        break;
      }
      case "bind": {
        once(t);
        expectP("{");
        expectW("time");
        expectP(":");
        const time = ident("binding time") as EnumValue<"binding_time">;
        expectP(";");
        expectP("}");
        bind = { time };
        break;
      }
      case "tier1":
        once(t);
        tier1 = tier1Buckets();
        break;
      case "tier2":
        once(t);
        rightsName = ident("rights bucket name");
        expectP("{");
        expectW("split");
        split = splitBuckets();
        expectP("}");
        break;
      case "guard":
        once(t);
        guard();
        break;
      case "exceptions":
        once(t);
        exceptions();
        break;
      case "rounding": {
        once(t);
        expectP("{");
        expectW("method");
        expectP(":");
        const method = ident("rounding method") as EnumValue<"rounding_method">;
        expectP(";");
        expectW("tie");
        expectP(":");
        const tie = ident("tie rule") as "party_id_asc";
        expectP(";");
        expectP("}");
        rounding = { method, tie };
        break;
      }
      default:
        fail("PARSE_SYNTAX", at(t), `unknown block ${t.text}`);
    }
  }
  const close = expectP("}");
  const end = next();
  if (end.kind !== "eof") fail("PARSE_SYNTAX", at(end), `unexpected ${describe(end)} after the policy`);
  for (const b of REQUIRED_BLOCKS) if (!seen.has(b)) fail("PARSE_SYNTAX", at(close), `missing ${b} block`);

  return {
    vcrl: "1.0",
    module: "allocation",
    id: docId,
    version,
    depends_on: dependsOn,
    visibility_default: visibility as EnumValue<"visibility">,
    body: {
      scope: scope!,
      bind: bind!,
      tier1: { buckets: tier1, rights: rightsName },
      tier2: { split },
      rounding: rounding!,
    },
  };
}
```

`spec/grammar/allocation.ebnf`에는 위 "문법" 블록을 그대로 저장한다.

- [ ] **Step 5: 통과 확인**

Run: `node --test test/text/parse.test.ts && npm test && npx tsc -p tsconfig.json`
Expected: PASS. 위치를 단언하는 테스트(`@1:41`, `@1:24`)가 다르면, 입력 문자열의 열을 직접 세어 확인한다(`@1:41`은 `pack` 뒤 `p`, `@1:24`는 `0`). 기대값이 맞는데 다르면 코드를 고친다.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 03_구현문서_코드/vcrl/src/text/roles.ts 03_구현문서_코드/vcrl/src/text/parse-allocation.ts 03_구현문서_코드/vcrl/spec/grammar/allocation.ebnf 03_구현문서_코드/vcrl/conformance/text/001-basic.vcrl 03_구현문서_코드/vcrl/test/text/parse.test.ts && git commit -m "$(printf 'feat(vcrl): allocation 텍스트 파서, 역할 추론, 문법 정본\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 3: allocation 포매터(왕복) · 예제 정책

**Files:**
- Create: `src/text/format-allocation.ts`, `samples/VC-ALLOC-DEFAULT-V1.vcrl`, `samples/VC-ALLOC-HYBRID-V2.vcrl`
- Test: `test/text/format-allocation.test.ts`

**Interfaces:**
- Consumes: `compileAllocation`, `parseAllocation` (T2), `inferRole` (T2), `parseRef`, `fail`, allocation 타입, `evaluate`, `evaluationInput`·`loadAllocationCase` (helpers)
- Produces: `formatPercent(bps: string): string`, `formatAllocation(doc: AllocationDocument): string`, `quoteText(s: string): string`, `idText(s: string): string`

**규칙:** 정규 텍스트는 2칸 들여쓰기, 블록 순서 `uses` → `visibility`(PARTIES가 아닐 때만) → `scope` → `bind` → `tier1` → `tier2` → `rounding`. guard·exceptions는 출력하지 않는다(고정 의미). 비율은 `%`로, 정수 연산으로 소수 둘째 자리까지(`1250` → `12.5%`, `1` → `0.01%`, `105` → `1.05%`). id는 식별자 형태면 그대로, 아니면 따옴표. `as ROLE`은 추론 결과가 IR 역할과 다를 때만 쓴다. facts 이외의 의존성은 텍스트로 쓸 수 없다(`CORE_TYPE_ERROR`). 성질: 유효한 IR에 대해 `parseAllocation(formatAllocation(ir))`의 결과는 `ir`과 같다.

- [ ] **Step 1: 예제 정책 작성**

`samples/VC-ALLOC-DEFAULT-V1.vcrl`:
```
// 설계문서의 VC-DSL v1 예제 1(VC-ALLOC-DEFAULT-V1)을 VCRL 텍스트로 다시 쓴 것. 모든 비율은 예시 값이다.
// v1에는 Tier 1이 없어서 platform·ops·rights를 예시 값으로 채웠다.
allocation "VC-ALLOC-DEFAULT-V1" version 1 {
  uses facts "nova-debut-01"@1 digest "vcrl:sha256:4c8fc5573e79e0da0e23eee13566d4af8c5aa5fd319319f7b2684a78077ca6f4";
  scope { pack: pak_nova_debut_01; events: [PRIMARY]; currency: KRW; }
  bind { time: ISSUE_TIME; }
  tier1 {
    platform = 25%;
    ops = 5%;
    rights = 70%;
  }
  tier2 rights {
    split {
      master = graph(MASTER_OWNER) : 40%;
      performer = member_pct() : 50%;
      copyright = graph(WORK_AUTHOR) via mandate : 10%;
    }
  }
  guard { require covered(all_claimants); require sum(split) == 100%; }
  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
```

`samples/VC-ALLOC-HYBRID-V2.vcrl`:
```
// 설계문서의 VC-DSL v1 예제 2(VC-ALLOC-HYBRID-V2)를 VCRL 텍스트로 다시 쓴 것. 모든 비율은 예시 값이다.
// 독식 방지 상한 50%를 실연 풀에 적용하고, 기획사 계약 몫을 별도 버킷으로 둔다.
allocation "VC-ALLOC-HYBRID-V2" version 2 {
  uses facts "nova-debut-01"@1 digest "vcrl:sha256:4c8fc5573e79e0da0e23eee13566d4af8c5aa5fd319319f7b2684a78077ca6f4";
  scope { pack: pak_nova_summer_02; events: [PRIMARY]; currency: KRW; }
  bind { time: ISSUE_TIME; }
  tier1 {
    platform = 25%;
    ops = 5%;
    rights = 70%;
  }
  tier2 rights {
    split {
      master = graph(MASTER_OWNER) : 40%;
      performer = performance_pool(HYBRID, fixed: 40%, usage: 60%, featured_weight: 70%) |> cap(50%) : 40%;
      work = graph(WORK_AUTHOR) via mandate : 10%;
      agency = contract(pty_agency_s) : 10% as AGENCY;
    }
  }
  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/text/format-allocation.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatAllocation, formatPercent } from "../../src/text/format-allocation.ts";
import { compileAllocation, parseAllocation } from "../../src/text/parse-allocation.ts";
import { evaluate } from "../../src/allocation/evaluate.ts";
import type { AllocationDocument } from "../../src/allocation/types.ts";
import { VcrlError } from "../../src/core/errors.ts";
import { evaluationInput, loadAllocationCase } from "../helpers.ts";

const sample = (name: string) => readFileSync(new URL(`../../samples/${name}.vcrl`, import.meta.url), "utf8");
function roundTrip(doc: AllocationDocument) {
  const text = formatAllocation(doc);
  const back = parseAllocation(text);
  assert.ok(back.ok, `${text}\n${JSON.stringify(back)}`);
  assert.deepEqual(back.value, doc);
  return text;
}

test("formatPercent uses integer arithmetic", () => {
  assert.deepEqual(["4500", "1250", "1", "5", "50", "105", "10000", "0"].map(formatPercent), [
    "45%", "12.5%", "0.01%", "0.05%", "0.5%", "1.05%", "100%", "0%",
  ]);
});

test("conformance policy formats to canonical text and round-trips", () => {
  const text = roundTrip(loadAllocationCase().policy);
  assert.match(text, /^allocation "VC-ALLOC-NOVA-02" version 1 \{\n/);
  assert.match(text, /\n      work = graph\(WORK_AUTHOR\) via mandate : 10%;\n/);
  assert.match(text, /\n    ops = 5%;\n/);
  assert.doesNotMatch(text, /visibility|guard|exceptions| as /);
});

test("explicit roles, quoted ids, pipes and visibility round-trip", () => {
  const doc = loadAllocationCase().policy;
  doc.visibility_default = "PUBLIC";
  doc.body.tier2.split = [
    { name: "master", bps: "4500", role: "MASTER_OWNER", vector: { fn: "floor_guarantee", min: "5", of: { fn: "cap", max: "6000", of: {
      fn: "mix", parts: [{ weight: "5000", of: { fn: "graph", role: "MASTER_OWNER" } }, { weight: "5000", of: { fn: "contract", party: "10" } }],
    } } } },
    { name: "performer", bps: "4500", role: "PERFORMER_NON_FEATURED", vector: { fn: "performance_pool", mode: "FIXED" } },
    { name: "agency", bps: "1000", role: "AGENCY", vector: { fn: "contract", party: "pty_agency_s" } },
  ];
  const text = roundTrip(doc);
  assert.match(text, /contract\("10"\)/);
  assert.match(text, / : 45% as PERFORMER_NON_FEATURED;/);
  assert.match(text, / : 10% as AGENCY;/);
  assert.match(text, /\n  visibility PUBLIC;\n/);
});

test("non-facts dependencies cannot be written as text", () => {
  const doc = loadAllocationCase().policy;
  doc.depends_on = [{ ref: "vc:grant/g1@1", digest: doc.depends_on[0]!.digest }];
  assert.throws(() => formatAllocation(doc), (e: unknown) => e instanceof VcrlError && e.diagnostics[0]?.code === "CORE_TYPE_ERROR");
});

test("samples compile, round-trip and evaluate against the basic facts", () => {
  for (const name of ["VC-ALLOC-DEFAULT-V1", "VC-ALLOC-HYBRID-V2"]) {
    const compiled = compileAllocation(sample(name));
    assert.ok(compiled.ok, `${name}: ${JSON.stringify(compiled)}`);
    roundTrip(compiled.value);
    const c = loadAllocationCase();
    c.policy = compiled.value;
    const r = evaluate(evaluationInput(c));
    assert.ok(r.ok, `${name}: ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    for (const ev of c.events) {
      const rights = BigInt(r.value.pool_lines.find((l) => l.event_id === ev.id && l.bucket === "rights")!.amount);
      const paid = [...r.value.lines, ...r.value.holdings].filter((l) => l.event_id === ev.id).reduce((a, l) => a + BigInt(l.amount), 0n);
      assert.equal(paid, rights, `${name} ${ev.id}`);
    }
  }
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --test test/text/format-allocation.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: 구현**

`src/text/format-allocation.ts`:
```ts
import { fail } from "../core/errors.ts";
import { parseRef } from "../core/ref.ts";
import type { AllocationDocument, VectorExpr } from "../allocation/types.ts";
import { inferRole } from "./roles.ts";

const BARE_ID = /^[A-Za-z_][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)*$/;

export function quoteText(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 식별자 형태면 그대로, 아니면 따옴표 문자열로 쓴다. */
export function idText(s: string): string {
  return BARE_ID.test(s) ? s : quoteText(s);
}

/** bps 문자열을 `%` 표기로 바꾼다(정수 연산, 소수 둘째 자리까지). */
export function formatPercent(bps: string): string {
  const n = BigInt(bps);
  const whole = n / 100n;
  const frac = n % 100n;
  return frac === 0n ? `${whole}%` : `${whole}.${frac.toString().padStart(2, "0").replace(/0$/, "")}%`;
}

const POOL_ARGS = ["fixed", "usage", "featured_weight"] as const;

function vectorText(e: VectorExpr): string {
  switch (e.fn) {
    case "graph":
      return `graph(${e.role})${e.via_mandate === true ? " via mandate" : ""}`;
    case "contract":
      return `contract(${idText(e.party)})`;
    case "member_pct":
      return "member_pct()";
    case "performance_pool":
      return `performance_pool(${e.mode}${POOL_ARGS.filter((k) => e[k] !== undefined).map((k) => `, ${k}: ${formatPercent(e[k]!)}`).join("")})`;
    case "mix":
      return `mix(${e.parts.map((p) => `${formatPercent(p.weight)}: ${vectorText(p.of)}`).join(", ")})`;
    case "cap":
      return `${vectorText(e.of)} |> cap(${formatPercent(e.max)})`;
    case "floor_guarantee":
      return `${vectorText(e.of)} |> floor_guarantee(${formatPercent(e.min)})`;
  }
}

/** 안분 정책 IR을 정규 텍스트로 쓴다. parseAllocation(formatAllocation(ir))은 ir과 같다. */
export function formatAllocation(doc: AllocationDocument): string {
  const b = doc.body;
  const lines: string[] = [`allocation ${quoteText(doc.id)} version ${doc.version} {`];
  doc.depends_on.forEach((dep, i) => {
    const ref = parseRef(dep.ref, `$.depends_on[${i}].ref`);
    if (ref.kind !== "facts") fail("CORE_TYPE_ERROR", `$.depends_on[${i}].ref`, "only facts dependencies can be written as text");
    lines.push(`  uses facts ${quoteText(ref.id)}@${ref.version} digest ${quoteText(dep.digest)};`);
  });
  if (doc.visibility_default !== "PARTIES") lines.push(`  visibility ${doc.visibility_default};`);
  lines.push(`  scope { pack: ${idText(b.scope.pack)}; events: [${b.scope.events.join(", ")}]; currency: ${b.scope.currency}; }`);
  lines.push(`  bind { time: ${b.bind.time}; }`);
  lines.push("  tier1 {");
  for (const t of b.tier1.buckets) lines.push(`    ${t.name} = ${formatPercent(t.bps)};`);
  lines.push("  }");
  lines.push(`  tier2 ${b.tier1.rights} {`);
  lines.push("    split {");
  for (const s of b.tier2.split) {
    const role = inferRole(s.vector) === s.role ? "" : ` as ${s.role}`;
    lines.push(`      ${s.name} = ${vectorText(s.vector)} : ${formatPercent(s.bps)}${role};`);
  }
  lines.push("    }");
  lines.push("  }");
  lines.push(`  rounding { method: ${b.rounding.method}; tie: ${b.rounding.tie}; }`);
  lines.push("}");
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --test test/text/format-allocation.test.ts && npm test && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 03_구현문서_코드/vcrl/src/text/format-allocation.ts 03_구현문서_코드/vcrl/samples 03_구현문서_코드/vcrl/test/text/format-allocation.test.ts && git commit -m "$(printf 'feat(vcrl): allocation 정규 텍스트 포매터와 예제 정책\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 4: facts 읽기 전용 텍스트 출력

**Files:**
- Create: `src/text/format-facts.ts`
- Test: `test/text/format-facts.test.ts`

**Interfaces:**
- Consumes: `formatPercent`, `idText`, `quoteText` (T3); `FactsDocument`, `Claim`, `Mandate`, `Interval`
- Produces: `formatFacts(doc: FactsDocument): string` (원문 facts만, 사람이 검토하는 표시용이며 파싱하지 않는다)

**형식(스펙 4.1 스타일):**
```
facts "<id>" version <n> {
  party <id> { kind: <KIND>;[ ids: { <k>: "<v>", ... };][ visibility: <V>;] }
  work <id> {[ ids: {...};] }
  recording <id> { of: <work>;[ ids: {...};] }
  voice <id> { kind: <KIND>; }
  stem <id> { of: <recording>; slot: <slot>; rights_bearing: <true|false>; }
  claim <id>: <source> <EDGE> <target> share <pct>[ role <PR>][ detail "<d>"] status <S> valid [<from>, <to>) recorded <t>[ superseded <t>][ evidence "<e>"][ visibility <V>];
  mandate <id>: <from> -> <to> right <R> share <pct> status <S> valid [<from>, <to>) recorded <t>[ superseded <t>][ visibility <V>];
}
```
(`ids` 키는 코드 유닛 오름차순, `to`가 없으면 빈칸.)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/text/format-facts.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFacts } from "../../src/text/format-facts.ts";
import { loadBasic } from "../helpers.ts";

const T0 = "2026-01-01T00:00:00.000Z";

test("basic facts render in the spec 4.1 style", () => {
  const lines = formatFacts(loadBasic().facts).split("\n");
  assert.equal(lines[0], 'facts "nova-debut-01" version 1 {');
  assert.ok(lines.includes('  party pty_label_x { kind: LABEL; ids: { isni: "0000000123456789" }; }'));
  assert.ok(lines.includes("  party pty_agency_s { kind: AGENCY; }"));
  assert.ok(lines.includes('  work wrk_01 { ids: { iswc: "T-123.456.789-0" }; }'));
  assert.ok(lines.includes('  recording rcd_01 { of: wrk_01; ids: { isrc: "KRA012600001" }; }'));
  assert.ok(lines.includes("  voice vo_a { kind: HUMAN; }"));
  assert.ok(lines.includes("  stem stm_v1 { of: rcd_01; slot: slt_v1; rights_bearing: true; }"));
  assert.ok(lines.includes(`  claim c1: stm_v1 PERFORMED_BY vo_a share 100% role FEATURED status VERIFIED valid [${T0}, ) recorded ${T0};`));
  assert.ok(lines.includes(`  claim c6: wrk_01 WRITTEN_BY pty_author_b share 60% detail "LYRICS" status VERIFIED valid [${T0}, ) recorded ${T0};`));
  assert.ok(lines.some((l) => l.startsWith("  claim c5: rcd_01 CONTROLLED_BY pty_label_x share 100%") && l.includes(' evidence "vcrl:sha256:')));
  assert.ok(lines.includes(`  mandate m1: pty_author_b -> pty_komca right WORK share 100% status VERIFIED valid [${T0}, ) recorded ${T0};`));
  assert.equal(lines.at(-2), "}");
  assert.equal(lines.at(-1), "");
});

test("optional fields render when present", () => {
  const i = loadBasic();
  const c = i.facts.body.claims[4]!;
  c.valid = { from: T0, to: "2031-01-01T00:00:00.000Z" };
  c.superseded_at = "2026-03-01T00:00:00.000Z";
  c.visibility = "PUBLIC";
  i.facts.body.parties[0]!.visibility = "PRIVATE";
  const text = formatFacts(i.facts);
  assert.match(text, /valid \[2026-01-01T00:00:00\.000Z, 2031-01-01T00:00:00\.000Z\) recorded [^ ]+ superseded 2026-03-01T00:00:00\.000Z evidence "[^"]+" visibility PUBLIC;/);
  assert.match(text, /party pty_agency_s \{ kind: AGENCY; visibility: PRIVATE; \}/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/text/format-facts.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: 구현**

`src/text/format-facts.ts`:
```ts
import type { Interval } from "../core/time.ts";
import type { FactsDocument } from "../facts/types.ts";
import { formatPercent, idText, quoteText } from "./format-allocation.ts";

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function idsText(ids: Readonly<Record<string, string>> | undefined): string {
  if (ids === undefined) return "";
  return ` ids: { ${Object.keys(ids).sort(byKey).map((k) => `${k}: ${quoteText(ids[k]!)}`).join(", ")} };`;
}

const interval = (v: Interval) => `[${v.from}, ${v.to ?? ""})`;
const opt = (label: string, v: string | undefined, render: (s: string) => string = (s) => s) =>
  v === undefined ? "" : ` ${label} ${render(v)}`;

/** 원문 facts IR을 사람이 검토할 수 있는 텍스트로 표시한다(스펙 4.1 스타일, 파싱하지 않는다). */
export function formatFacts(doc: FactsDocument): string {
  const b = doc.body;
  const lines: string[] = [`facts ${quoteText(doc.id)} version ${doc.version} {`];
  for (const p of b.parties) {
    lines.push(`  party ${idText(p.id)} { kind: ${p.kind};${idsText(p.ids)}${p.visibility === undefined ? "" : ` visibility: ${p.visibility};`} }`);
  }
  for (const w of b.works) lines.push(`  work ${idText(w.id)} {${idsText(w.ids)} }`);
  for (const r of b.recordings) lines.push(`  recording ${idText(r.id)} { of: ${idText(r.of)};${idsText(r.ids)} }`);
  for (const v of b.voices) lines.push(`  voice ${idText(v.id)} { kind: ${v.kind}; }`);
  for (const s of b.stems) {
    lines.push(`  stem ${idText(s.id)} { of: ${idText(s.of)}; slot: ${idText(s.slot)}; rights_bearing: ${s.rights_bearing}; }`);
  }
  for (const c of b.claims) {
    lines.push(
      `  claim ${idText(c.id)}: ${idText(c.source)} ${c.edge} ${idText(c.target)} share ${formatPercent(c.share)}` +
        `${opt("role", c.performer_role)}${opt("detail", c.role_detail, quoteText)}` +
        ` status ${c.status} valid ${interval(c.valid)} recorded ${c.recorded_at}` +
        `${opt("superseded", c.superseded_at)}${opt("evidence", c.evidence, quoteText)}${opt("visibility", c.visibility)};`,
    );
  }
  for (const m of b.mandates) {
    lines.push(
      `  mandate ${idText(m.id)}: ${idText(m.from)} -> ${idText(m.to)} right ${m.right} share ${formatPercent(m.share)}` +
        ` status ${m.status} valid ${interval(m.valid)} recorded ${m.recorded_at}` +
        `${opt("superseded", m.superseded_at)}${opt("visibility", m.visibility)};`,
    );
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/text/format-facts.test.ts && npx tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 03_구현문서_코드/vcrl/src/text/format-facts.ts 03_구현문서_코드/vcrl/test/text/format-facts.test.ts && git commit -m "$(printf 'feat(vcrl): facts 읽기 전용 텍스트 표시\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 5: 투영 재검증 · 공개본 검증 보강

**Files:**
- Modify: `src/facts/result.ts`, `src/facts/validate.ts`
- Test: `test/facts/result.test.ts` (Modify), `test/facts/structure.test.ts` (Modify)

**Interfaces:**
- Consumes: `projectToIr`, `ProjectionIr`, `diag`, `isPlainObject`, `commitValue`, `publicFacts`
- Produces: `verifyProjection(doc: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant, projection: unknown): Diagnostic[]`

**규칙:**
- `verifyProjection`은 입력으로 투영을 다시 계산해 digest가 같으면 `[]`, 다르면 `CORE_DIGEST_MISMATCH`(path `$.projection.digest`), 투영 계산이 실패하면 그 진단을 반환한다. 제공된 투영을 신뢰하지 않는 검증 경로다.
- 공개본 검증(`validatePublicFacts`): claim·mandate의 share, claim의 evidence는 그 항목의 `visibility`가 `PUBLIC`이면 커밋먼트를 허용하지 않는다(원문이어야 함). party.ids는 party가 `PRIVATE`일 때만 커밋먼트를 허용한다.
- party.ids(원문·공개본 모두)의 키 `commit`은 커밋먼트 표지로 예약되어 쓸 수 없다(`CORE_TYPE_ERROR`, path `<ids path>.commit`).

- [ ] **Step 1: 실패하는 테스트 작성**

`test/facts/result.test.ts` 끝에 추가(상단 import에 `verifyProjection`, `commitValue`, `validatePublicFacts`가 없으면 추가: `import { projectToIr, verifyProjection } from "../../src/facts/result.ts";`, `import { commitValue } from "../../src/core/commit.ts";`, `import { validatePublicFacts } from "../../src/facts/validate.ts";`):
```ts
test("verifyProjection recomputes instead of trusting the supplied projection", () => {
  const i = loadBasic();
  const p = projectToIr(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(p.ok);
  assert.deepEqual(verifyProjection(i.facts, i.usage, i.as_of, i.known_at, p.value), []);
  const forged = { ...p.value, vectors: { MASTER_OWNER: { pty_komca: "1/1" } } };
  const forgedIr = { ...forged, digest: digestOf({ ...forged, digest: undefined }) };
  assert.deepEqual(verifyProjection(i.facts, i.usage, i.as_of, i.known_at, forgedIr).map((d) => [d.code, d.path]), [
    ["CORE_DIGEST_MISMATCH", "$.projection.digest"],
  ]);
  assert.deepEqual(verifyProjection(i.facts, { stm_ghost: "1" }, i.as_of, i.known_at, p.value).map((d) => d.code), ["FACTS_USAGE_INVALID"]);
  assert.deepEqual(verifyProjection(i.facts, i.usage, i.as_of, i.known_at, null).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);
});

test("public validation: PUBLIC items must stay raw, only PRIVATE party ids may be committed", () => {
  const salt = new Uint8Array(32).fill(3);
  const i = loadBasic();
  claimOf(i, "c6").visibility = "PUBLIC";
  const pub = publicFacts(i.facts, () => salt).doc as typeof i.facts;
  assert.deepEqual(validatePublicFacts(pub), []);
  const c6 = pub.body.claims.find((c) => c.id === "c6")!;
  (c6 as unknown as { share: unknown }).share = commitValue("6000", salt);
  assert.deepEqual(validatePublicFacts(pub).map((d) => [d.code, d.path]), [["CORE_TYPE_ERROR", "$.body.claims[5].share"]]);
  const pub2 = publicFacts(loadBasic().facts, () => salt).doc as typeof i.facts;
  const label = pub2.body.parties.find((p) => p.id === "pty_label_x")!;
  (label as unknown as { ids: unknown }).ids = commitValue({ isni: "0000000123456789" }, salt);
  assert.deepEqual(validatePublicFacts(pub2).map((d) => d.code), ["CORE_TYPE_ERROR"]);
});
```

`test/facts/structure.test.ts` 끝에 추가:
```ts
test("party ids reserve the key `commit`", () => {
  const i = loadBasic();
  i.facts.body.parties.find((p) => p.id === "pty_label_x")!.ids = { commit: "x", isni: "1" };
  assert.deepEqual(validateFactsStructure(i.facts).map((d) => [d.code, d.path]), [["CORE_TYPE_ERROR", "$.body.parties[4].ids.commit"]]);
});
```
(이 테스트 파일이 `validateFactsStructure`와 `loadBasic`을 이미 import한다. 파티 배열은 id 순이므로 `pty_label_x`는 인덱스 4다.)

- [ ] **Step 2: 실패 확인**

Run: `node --test test/facts/result.test.ts test/facts/structure.test.ts`
Expected: FAIL — `verifyProjection` 미정의, 그리고 새 공개본·예약 키 단언 실패.

- [ ] **Step 3: 구현**

`src/facts/result.ts` 끝에 추가(import에 `diag`, `type Diagnostic`, `isPlainObject` 추가: `import { diag, err, ok, type Diagnostic, type Result } from "../core/errors.ts";`, `import { isPlainObject } from "../core/jcs.ts";`):
```ts
/** 제공된 투영을 신뢰하지 않고 입력으로 다시 계산해 digest를 대조한다. */
export function verifyProjection(doc: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant, projection: unknown): Diagnostic[] {
  const recomputed = projectToIr(doc, usage, asOf, knownAt);
  if (!recomputed.ok) return recomputed.errors;
  const given = isPlainObject(projection) ? projection.digest : undefined;
  return given === recomputed.value.digest
    ? []
    : [diag("CORE_DIGEST_MISMATCH", "$.projection.digest", `${String(given)} != ${recomputed.value.digest}`)];
}
```

`src/facts/validate.ts`:
1. `committed` 정의를 다음으로 교체:
```ts
  /** 공개본에서 커밋먼트로 치환될 수 있는 필드가 커밋먼트인가. PUBLIC 항목은 원문이어야 한다. */
  const committed = (v: unknown, visibility?: unknown): boolean => mode === "public" && visibility !== "PUBLIC" && isCommitment(v);
```
2. `idsField`를 다음으로 교체:
```ts
  const idsField = (v: unknown, path: string, sealable = false) => {
    if (v === undefined || (sealable && committed(v))) return;
    if (!isPlainObject(v) || !Object.values(v).every((x) => typeof x === "string")) {
      out.push(diag("CORE_TYPE_ERROR", path, "must be an object of strings"));
    } else if (Object.hasOwn(v, "commit")) {
      out.push(diag("CORE_TYPE_ERROR", `${path}.commit`, "reserved key (commitment marker)"));
    }
  };
```
3. `bps`를 `const bps = (v: unknown, path: string, visibility?: unknown) => { if (!committed(v, visibility)) out.push(...capture(() => parseBps(v, path))); };`로 교체.
4. party 처리의 `idsField(x.ids, \`${p}.ids\`, true);`를 `idsField(x.ids, \`${p}.ids\`, x.visibility === "PRIVATE");`로 교체.
5. claim 처리의 `bps(c.share, \`${p}.share\`);`를 `bps(c.share, \`${p}.share\`, c.visibility);`로, `if (!committed(c.evidence)) text(...)`를 `if (!committed(c.evidence, c.visibility)) text(c.evidence, \`${p}.evidence\`, true);`로 교체.
6. mandate 처리의 `bps(m.share, \`${p}.share\`);`를 `bps(m.share, \`${p}.share\`, m.visibility);`로 교체.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/facts/result.test.ts test/facts/structure.test.ts && npm test && npx tsc -p tsconfig.json`
Expected: 전부 PASS(기존 공개본 테스트 포함).

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 03_구현문서_코드/vcrl/src/facts/result.ts 03_구현문서_코드/vcrl/src/facts/validate.ts 03_구현문서_코드/vcrl/test/facts/result.test.ts 03_구현문서_코드/vcrl/test/facts/structure.test.ts && git commit -m "$(printf 'feat(vcrl): 투영 재검증과 공개본 검증 보강\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 6: `vcrl` CLI

**Files:**
- Create: `src/cli/main.ts`, `bin/vcrl.ts`, `src/text/index.ts`
- Modify: `package.json`, `tsconfig.json`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `compileAllocation` (T2), `formatAllocation` (T3), `formatFacts` (T4), `verifyProjection` (T5), `projectToIr`, `evaluate`, `checkActivation`, `validateFacts`, `validateFactsStructure`, `validateAllocation`, `digestOf`, `VcrlError`, `fail`, `diag`, `isPlainObject`
- Produces: `type Io = { readText(path: string): string; out(s: string): void; err(s: string): void }`, `run(argv: readonly string[], io: Io): number`, `USAGE`

**출력 규약:** 결과 JSON은 stdout(2칸 들여쓰기 + 줄바꿈), 진단은 stderr에 한 줄씩 `<CODE> <path> <message>`. 종료 코드: 0 성공, 1 진단 실패(검증·파싱·digest 불일치·파일 읽기), 2 사용법 오류. `--policy`는 `.vcrl`이면 컴파일하고, 아니면 IR JSON으로 읽는다.

| 명령 | 옵션 | 출력 |
|---|---|---|
| `compile <policy.vcrl>` | | IR JSON |
| `fmt <doc.json>` | | facts는 읽기 전용 텍스트, allocation은 정규 텍스트 |
| `check <doc.json\|policy.vcrl>` | | `OK <digest>` (facts는 `validateFacts`, allocation은 `validateAllocation`) |
| `project` | `--facts --usage --as-of --known-at` | 투영 IR JSON |
| `evaluate` | `--policy --facts --usage --as-of --known-at --snapshot --events --run-id` | 결과 IR JSON(투영은 입력으로 계산) |
| `verify` | `--result` + evaluate 옵션 | `OK <result_digest>` 또는 `CORE_DIGEST_MISMATCH` |
| `activate` | `--facts --usage --as-of --known-at --declared` | `OK` 또는 진단 |
| `help` | | 사용법(종료 0) |

- [ ] **Step 1: 실패하는 테스트 작성**

`test/cli.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, type Io } from "../src/cli/main.ts";
import { loadAllocationCase, loadBasic } from "./helpers.ts";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

function fixture(): Map<string, string> {
  const basic = loadBasic();
  const alloc = loadAllocationCase();
  const j = (v: unknown) => JSON.stringify(v);
  return new Map([
    ["policy.vcrl", read("conformance/text/001-basic.vcrl")],
    ["policy.json", j(alloc.policy)],
    ["facts.json", j(basic.facts)],
    ["usage.json", j(basic.usage)],
    ["snapshot.json", j(alloc.snapshot)],
    ["events.json", j(alloc.events)],
    ["declared.json", j(basic.declared_claimants)],
    ["bad.vcrl", 'allocation "x" version 1 { scope { pack p; } }'],
    ["broken.json", "{"],
  ]);
}

function cli(argv: string[], files = fixture()) {
  let out = "";
  let err = "";
  const io: Io = {
    readText: (p) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return v;
    },
    out: (s) => { out += s; },
    err: (s) => { err += s; },
  };
  const code = run(argv, io);
  return { code, out, err };
}

const TIMES = ["--as-of", "2026-06-01T00:00:00.000Z", "--known-at", "2026-06-01T00:00:00.000Z"];
const EVAL = ["--policy", "policy.vcrl", "--facts", "facts.json", "--usage", "usage.json", ...TIMES,
  "--snapshot", "snapshot.json", "--events", "events.json", "--run-id", "run_2026_06"];
const expectedDigest = () => JSON.parse(read("conformance/allocation/001-basic/expected.json")).result_digest as string;

test("compile turns text into the conformance IR", () => {
  const r = cli(["compile", "policy.vcrl"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), loadAllocationCase().policy);
});

test("compile reports syntax errors with positions", () => {
  const r = cli(["compile", "bad.vcrl"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^PARSE_SYNTAX @1:41 /);
});

test("check, fmt and project", () => {
  assert.match(cli(["check", "facts.json"]).out, /^OK vcrl:sha256:4c8fc5573e79e0da0e23eee13566d4af8c5aa5fd319319f7b2684a78077ca6f4\n$/);
  assert.equal(cli(["check", "policy.vcrl"]).code, 0);
  assert.match(cli(["fmt", "facts.json"]).out, /^facts "nova-debut-01" version 1 \{\n/);
  const fmt = cli(["fmt", "policy.json"]);
  const files = fixture();
  files.set("round.vcrl", fmt.out);
  assert.deepEqual(JSON.parse(cli(["compile", "round.vcrl"], files).out), loadAllocationCase().policy);
  const p = cli(["project", "--facts", "facts.json", "--usage", "usage.json", ...TIMES]);
  assert.equal(p.code, 0, p.err);
  assert.deepEqual(JSON.parse(p.out).vectors.MASTER_OWNER, { pty_label_x: "1/1" });
});

test("evaluate from text reproduces the conformance result digest, verify accepts it", () => {
  const r = cli(["evaluate", ...EVAL]);
  assert.equal(r.code, 0, r.err);
  const result = JSON.parse(r.out);
  assert.equal(result.result_digest, expectedDigest());
  const files = fixture();
  files.set("result.json", r.out);
  const v = cli(["verify", "--result", "result.json", ...EVAL], files);
  assert.equal(v.code, 0, v.err);
  assert.equal(v.out, `OK ${expectedDigest()}\n`);
  result.lines[0].amount = "1";
  files.set("tampered.json", JSON.stringify(result));
  const t = cli(["verify", "--result", "tampered.json", ...EVAL], files);
  assert.equal(t.code, 1);
  assert.match(t.err, /^CORE_DIGEST_MISMATCH /m);
});

test("activate", () => {
  const ok = cli(["activate", "--facts", "facts.json", "--usage", "usage.json", ...TIMES, "--declared", "declared.json"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, "OK\n");
  const files = fixture();
  files.set("declared.json", JSON.stringify(loadBasic().declared_claimants.filter((c) => c.role !== "CMO")));
  const drift = cli(["activate", "--facts", "facts.json", "--usage", "usage.json", ...TIMES, "--declared", "declared.json"], files);
  assert.equal(drift.code, 1);
  assert.match(drift.err, /^FACTS_CLAIMANT_DRIFT /m);
});

test("usage errors exit 2, input errors exit 1", () => {
  assert.equal(cli([]).code, 2);
  assert.equal(cli(["nope"]).code, 2);
  assert.equal(cli(["project", "--facts", "facts.json"]).code, 2);
  assert.equal(cli(["compile", "a.vcrl", "--bogus"]).code, 2);
  const missing = cli(["check", "missing.json"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^CORE_UNKNOWN_REF missing\.json /);
  assert.match(cli(["check", "broken.json"]).err, /^CORE_TYPE_ERROR broken\.json /);
  const help = cli(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /사용법: vcrl/);
});

test("bin/vcrl.ts runs as a Node executable", () => {
  const bin = fileURLToPath(new URL("../bin/vcrl.ts", import.meta.url));
  const out = execFileSync(process.execPath, [bin, "help"], { encoding: "utf8" });
  assert.match(out, /사용법: vcrl/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/cli.test.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` (`src/cli/main.ts`).

- [ ] **Step 3: 구현**

`src/text/index.ts`:
```ts
export * from "./lexer.ts";
export * from "./roles.ts";
export * from "./parse-allocation.ts";
export * from "./format-allocation.ts";
export * from "./format-facts.ts";
```

`src/cli/main.ts`:
```ts
import { parseArgs } from "node:util";
import { digestOf } from "../core/digest.ts";
import { VcrlError, diag, fail, type Diagnostic } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { evaluate } from "../allocation/evaluate.ts";
import type { AllocationDocument, AllocationResult, RevenueEvent, Snapshot } from "../allocation/types.ts";
import { validateAllocation } from "../allocation/validate.ts";
import { checkActivation } from "../facts/activation.ts";
import type { ClaimantEntry } from "../facts/mandate.ts";
import type { Usage } from "../facts/project.ts";
import { projectToIr, type ProjectionIr } from "../facts/result.ts";
import type { FactsDocument } from "../facts/types.ts";
import { validateFacts, validateFactsStructure } from "../facts/validate.ts";
import { formatAllocation } from "../text/format-allocation.ts";
import { formatFacts } from "../text/format-facts.ts";
import { compileAllocation } from "../text/parse-allocation.ts";

export type Io = { readText(path: string): string; out(s: string): void; err(s: string): void };

export const USAGE = `사용법: vcrl <명령> [옵션]
  compile <policy.vcrl>                        텍스트 정책을 IR(JSON)로 컴파일
  fmt <doc.json>                               IR을 텍스트로 출력(facts는 읽기 전용 표시)
  check <doc.json|policy.vcrl>                 구조·불변식 검증, 성공 시 digest 출력
  project --facts F --usage U --as-of T --known-at T
  evaluate --policy P --facts F --usage U --as-of T --known-at T --snapshot S --events E --run-id R
  verify --result R (+ evaluate 옵션)          입력으로 다시 계산해 result_digest 대조
  activate --facts F --usage U --as-of T --known-at T --declared D
  help
`;

class UsageError extends Error {}

const OPTIONS = {
  facts: { type: "string" },
  usage: { type: "string" },
  "as-of": { type: "string" },
  "known-at": { type: "string" },
  policy: { type: "string" },
  snapshot: { type: "string" },
  events: { type: "string" },
  "run-id": { type: "string" },
  result: { type: "string" },
  declared: { type: "string" },
} as const;

type Opts = Partial<Record<keyof typeof OPTIONS, string>>;

/** CLI 진입점. 입출력은 주입받는다. 반환값은 종료 코드(0 성공, 1 진단 실패, 2 사용법 오류). */
export function run(argv: readonly string[], io: Io): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "help" || cmd === "--help") {
      io.out(USAGE);
      return 0;
    }
    let parsed: { values: Opts; positionals: string[] };
    try {
      parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true }) as { values: Opts; positionals: string[] };
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e));
    }
    return dispatch(cmd, parsed.values, parsed.positionals, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof VcrlError) {
      report(io, e.diagnostics);
      return 1;
    }
    throw e;
  }
}

function dispatch(cmd: string | undefined, o: Opts, pos: string[], io: Io): number {
  switch (cmd) {
    case "compile": {
      printJson(io, loadPolicy(io, onePositional(pos)));
      return 0;
    }
    case "fmt": {
      const path = onePositional(pos);
      const doc = readJson(io, path);
      if (isPlainObject(doc) && doc.module === "facts") {
        throwIf(validateFactsStructure(doc));
        io.out(formatFacts(doc as unknown as FactsDocument));
      } else if (isPlainObject(doc) && doc.module === "allocation") {
        throwIf(validateAllocation(doc));
        io.out(formatAllocation(doc as unknown as AllocationDocument));
      } else {
        fail("CORE_TYPE_ERROR", `${path}:$.module`, "expected a facts or allocation document");
      }
      return 0;
    }
    case "check": {
      const path = onePositional(pos);
      const doc = path.endsWith(".vcrl") ? loadPolicy(io, path) : readJson(io, path);
      if (isPlainObject(doc) && doc.module === "facts") throwIf(validateFacts(doc));
      else if (isPlainObject(doc) && doc.module === "allocation") throwIf(validateAllocation(doc));
      else fail("CORE_TYPE_ERROR", `${path}:$.module`, "expected a facts or allocation document");
      io.out(`OK ${digestOf(doc)}\n`);
      return 0;
    }
    case "project": {
      printJson(io, project(io, o));
      return 0;
    }
    case "evaluate": {
      printJson(io, evaluateFromFiles(io, o).result);
      return 0;
    }
    case "verify": {
      const given = readJson(io, need(o, "result"));
      const { result, projection } = evaluateFromFiles(io, o);
      const errors: Diagnostic[] = [];
      if (!isPlainObject(given)) {
        errors.push(diag("CORE_TYPE_ERROR", "$.result", "must be an object"));
      } else {
        if (given.projection_digest !== projection.digest) errors.push(diag("CORE_DIGEST_MISMATCH", "$.result.projection_digest", String(given.projection_digest)));
        if (given.result_digest !== result.result_digest) errors.push(diag("CORE_DIGEST_MISMATCH", "$.result.result_digest", String(given.result_digest)));
        if (digestOf({ ...given, result_digest: undefined }) !== result.result_digest) {
          errors.push(diag("CORE_DIGEST_MISMATCH", "$.result", "result content does not match the recomputed result"));
        }
      }
      throwIf(errors);
      io.out(`OK ${result.result_digest}\n`);
      return 0;
    }
    case "activate": {
      throwIf(checkActivation({
        facts: readJson(io, need(o, "facts")) as FactsDocument,
        usage: readJson(io, need(o, "usage")) as Usage,
        asOf: need(o, "as-of"),
        knownAt: need(o, "known-at"),
        declared: readJson(io, need(o, "declared")) as ClaimantEntry[],
      }));
      io.out("OK\n");
      return 0;
    }
    default:
      throw new UsageError(cmd === undefined ? "명령이 필요합니다" : `알 수 없는 명령: ${cmd}`);
  }
}

function project(io: Io, o: Opts): ProjectionIr {
  const r = projectToIr(
    readJson(io, need(o, "facts")) as FactsDocument, readJson(io, need(o, "usage")) as Usage, need(o, "as-of"), need(o, "known-at"),
  );
  if (!r.ok) throw new VcrlError(r.errors);
  return r.value;
}

/** 투영은 입력으로 계산하고(제공된 투영을 받지 않는다) 평가한다. */
function evaluateFromFiles(io: Io, o: Opts): { result: AllocationResult; projection: ProjectionIr } {
  const projection = project(io, o);
  const r = evaluate({
    policy: loadPolicy(io, need(o, "policy")),
    facts: readJson(io, need(o, "facts")) as FactsDocument,
    projection,
    snapshot: readJson(io, need(o, "snapshot")) as Snapshot,
    events: readJson(io, need(o, "events")) as RevenueEvent[],
    runId: need(o, "run-id"),
  });
  if (!r.ok) throw new VcrlError(r.errors);
  return { result: r.value, projection };
}

function loadPolicy(io: Io, path: string): AllocationDocument {
  if (!path.endsWith(".vcrl")) return readJson(io, path) as AllocationDocument;
  const r = compileAllocation(readText(io, path));
  if (!r.ok) throw new VcrlError(r.errors);
  return r.value;
}

function readText(io: Io, path: string): string {
  try {
    return io.readText(path);
  } catch {
    return fail("CORE_UNKNOWN_REF", path, "cannot read file");
  }
}

function readJson(io: Io, path: string): unknown {
  const text = readText(io, path);
  try {
    return JSON.parse(text);
  } catch {
    return fail("CORE_TYPE_ERROR", path, "invalid JSON");
  }
}

function need(o: Opts, name: keyof typeof OPTIONS): string {
  const v = o[name];
  if (v === undefined) throw new UsageError(`--${name} 옵션이 필요합니다`);
  return v;
}

function onePositional(pos: string[]): string {
  if (pos.length !== 1) throw new UsageError("파일 경로 하나가 필요합니다");
  return pos[0]!;
}

function throwIf(errors: Diagnostic[]): void {
  if (errors.length > 0) throw new VcrlError(errors);
}

function printJson(io: Io, v: unknown): void {
  io.out(JSON.stringify(v, null, 2) + "\n");
}

function report(io: Io, diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) io.err(`${d.code} ${d.path} ${d.message}\n`);
}
```

`bin/vcrl.ts`:
```ts
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "../src/cli/main.ts";

process.exitCode = run(process.argv.slice(2), {
  readText: (p) => readFileSync(p, "utf8"),
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
```

`package.json` — `exports`에 `"./text": "./src/text/index.ts"`를 `"./allocation"` 다음에 추가하고, 최상위에 `"bin": { "vcrl": "./bin/vcrl.ts" },`를 `"exports"` 앞에 추가한다.
`tsconfig.json` — `"include"`를 `["src", "test", "scripts", "bin"]`으로 바꾼다.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/cli.test.ts && npm test && npx tsc -p tsconfig.json`
Expected: PASS. `evaluate` 테스트의 digest는 `conformance/allocation/001-basic/expected.json`의 값이며, 텍스트 컴파일 결과가 적합성 IR과 같으므로 일치해야 한다.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 03_구현문서_코드/vcrl/src/cli/main.ts 03_구현문서_코드/vcrl/bin/vcrl.ts 03_구현문서_코드/vcrl/src/text/index.ts 03_구현문서_코드/vcrl/package.json 03_구현문서_코드/vcrl/tsconfig.json 03_구현문서_코드/vcrl/test/cli.test.ts && git commit -m "$(printf 'feat(vcrl): vcrl CLI(compile·fmt·check·project·evaluate·verify·activate)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 7: 오류 코드 목록 테스트 · 스펙 반영

**Files:**
- Create: `test/error-catalog.test.ts`
- Modify: `02_설계문서/VCRL_보컬조합권리언어/VCRL_아키텍처_코어규격_설계_v1.0.md`

**Interfaces:**
- Consumes: `ERROR_CODES`
- Produces: 없음(검사·문서)

**규칙(스펙 10.3 "오류 코드별 최소 재현 케이스"의 구현):** 모든 오류 코드는 적어도 하나의 테스트 파일 또는 적합성 기대값에 문자열(`"CODE"`)로 등장해야 한다. 정상 입력으로 도달할 수 없는 방어용 코드는 이유와 함께 예외 목록에 둔다(현재 `ALLOC_ROUNDING_INVARIANT` 하나).

- [ ] **Step 1: 테스트 작성**

`test/error-catalog.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "../src/core/errors.ts";

/** 정상 입력으로 도달할 수 없는 방어용 코드와 그 이유. */
const UNREACHABLE: Readonly<Record<string, string>> = {
  ALLOC_ROUNDING_INVARIANT: "splitLrm의 층별 합 불변식 방어 — 가중치 합 1이 검증된 뒤에는 수학적으로 발생하지 않는다",
};

const root = fileURLToPath(new URL("..", import.meta.url));
const self = fileURLToPath(import.meta.url);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

test("every error code is asserted by at least one test or conformance case", () => {
  const text = [...files(join(root, "test")), ...files(join(root, "conformance"))]
    .filter((p) => p !== self)
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  const missing = Object.keys(ERROR_CODES).filter((c) => !Object.hasOwn(UNREACHABLE, c) && !text.includes(`"${c}"`));
  assert.deepEqual(missing, []);
});

test("the unreachable list names only registered codes", () => {
  for (const c of Object.keys(UNREACHABLE)) assert.ok(Object.hasOwn(ERROR_CODES, c), c);
});
```

- [ ] **Step 2: 실행**

Run: `node --test test/error-catalog.test.ts`
Expected: PASS. 실패하면 `missing`에 나온 코드마다 그 코드를 단언하는 최소 테스트를 해당 모듈의 테스트 파일에 추가한다(예외 목록에 넣지 않는다 — 도달 가능한 코드는 테스트로 증명한다).

- [ ] **Step 3: 스펙 12절에 반영**

`02_설계문서/VCRL_보컬조합권리언어/VCRL_아키텍처_코어규격_설계_v1.0.md`의 12절 끝(현재 마지막 항목 다음)에 번호를 이어 추가한다:
```markdown
37. **allocation 텍스트 문법(계획 1-C)**: 정본은 `spec/grammar/allocation.ebnf`. 블록은 `uses facts "<id>"@<v> digest "<d>";`, `visibility`, `scope`, `bind`, `tier1`, `tier2 <권리자 풀 버킷> { split { … } }`, `guard`, `exceptions`, `rounding`이다. scope·bind·tier1·tier2·rounding은 필수이고 블록 순서는 자유다. 비율은 `%`(소수 둘째 자리까지) 또는 `bps`(정수), id는 식별자 또는 따옴표 문자열, 주석은 `//`. 문법 오류는 `PARSE_SYNTAX`이며 경로는 `@줄:열`이다. 텍스트 입력은 allocation만 받고(사용자 결정), facts는 읽기 전용 텍스트로 표시만 한다.
38. **버킷 역할 추론(사용자 결정)**: `as ROLE`을 생략하면 벡터 식에서 추론한다. `graph(r)`은 r, 실연 풀·멤버 비율은 `PERFORMER_FEATURED`, 실연 graph만 있으면 그 역할이다. `contract`는 역할을 정하지 않는다. 추론할 수 없거나 서로 다른 역할의 graph가 섞이면 `PARSE_ROLE_REQUIRED`.
39. **guard·exceptions 블록**: 엔진의 고정 의미를 문서로 드러내는 선택 블록이며 IR에 남지 않는다. `require covered(all_claimants)`, `require sum(split) == 100%`, `on DISPUTED -> hold(DISPUTED_SHARE)`, `on FRAUD_FLAG -> hold(RIGHTS_POOL)`만 허용하고, 그 밖은 `PARSE_UNSUPPORTED`.
40. **포매터**: `formatAllocation`은 IR을 정규 텍스트로 쓰며 `parseAllocation(formatAllocation(ir)) = ir`이다. guard·exceptions는 출력하지 않고, `as ROLE`은 추론 결과와 다를 때만 쓴다. `formatFacts`는 원문 facts를 4.1 스타일로 표시하며 파싱 대상이 아니다.
41. **CLI**: `compile`·`fmt`·`check`·`project`·`evaluate`·`verify`·`activate`·`help`. 결과 JSON은 stdout, 진단은 stderr에 `<CODE> <path> <message>` 한 줄씩, 종료 코드는 0(성공)·1(진단 실패)·2(사용법 오류). `evaluate`·`verify`는 투영을 입력으로 다시 계산하며 제공된 투영을 받지 않는다. 라이브러리에서는 `verifyProjection`이 같은 역할을 한다.
42. **공개본 검증 보강**: `visibility: PUBLIC` 항목의 share·evidence는 공개본에서도 원문이어야 하고, party.ids의 커밋먼트는 PRIVATE party에만 허용한다. party.ids의 키 `commit`은 커밋먼트 표지로 예약된다.
43. **오류 코드 커버리지**: 모든 오류 코드는 테스트나 적합성 기대값에서 단언되어야 한다(`test/error-catalog.test.ts`). 도달 불가 방어 코드(`ALLOC_ROUNDING_INVARIANT`)만 이유와 함께 예외로 둔다.
44. **1-C 범위 밖**: legacy-v1 변환기(사용자 결정으로 연기), facts 텍스트 입력, `diff` 명령, 결과 IR의 JSON Schema·버전 태그, 설치형 배포(Node는 `node_modules` 안의 `.ts`를 실행하지 않으므로 배포 전 빌드 단계가 필요하다).
```

- [ ] **Step 4: 전체 확인**

Run: `npm test && npx tsc -p tsconfig.json && git -C "/Users/changkyuneun/Vocal Combination" status --porcelain 03_구현문서_코드/vcrl`
Expected: 전체 PASS, tsc 출력 없음, 추적되지 않은 파일 없음.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination" && git add 03_구현문서_코드/vcrl/test/error-catalog.test.ts "02_설계문서/VCRL_보컬조합권리언어/VCRL_아키텍처_코어규격_설계_v1.0.md" && git commit -m "$(printf 'test(vcrl): 오류 코드 커버리지 검사와 스펙 1-C 반영\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

## Self-Review 결과

- **스펙 커버리지:** 5.2 텍스트 문법(T1·T2, 정본 EBNF) · 12.21 IR 매핑(T2, 적합성 텍스트가 IR과 동일) · 사용자 결정 3건(T2 역할 추론, T4 facts 출력만, legacy 연기는 12.44) · 10.2 CLI(T6; `diff`는 12.44로 연기) · 10.3 오류 코드별 재현(T7) · 1-B 최종 리뷰 권고: `verifyProjection`·CLI 재계산(T5·T6), 공개본 보강(T5), guard·exceptions 처리 결정(T2·12.39).
- **타입 일관성:** `Token`·`at`(T1) ↔ T2, `inferRole`(T2) ↔ T3, `formatPercent`·`idText`·`quoteText`(T3) ↔ T4, `verifyProjection`(T5) ↔ 스펙 12.41, `compileAllocation`·`formatAllocation`·`formatFacts` ↔ T6 CLI.
- **자리표시자:** 없음. 위치 기대값(`@1:41`, `@1:24`)은 입력 문자열의 열을 센 값이다.
