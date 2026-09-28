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

test("truncated input never throws; it returns PARSE_SYNTAX", () => {
  for (const src of [
    'allocation "x" version 1 { exceptions { on',
    'allocation "x" version 1 { exceptions { on DISPUTED -> hold (',
    basicText().slice(0, basicText().indexOf("split {") + "split {".length),
  ]) {
    const r = compileAllocation(src);
    assert.equal(r.ok, false);
    assert.equal((r as { ok: false; errors: { code: string }[] }).errors[0]!.code, "PARSE_SYNTAX");
  }
});

test("exceptions require ident tokens; quoted hold target is PARSE_SYNTAX", () => {
  assert.equal(errs(basicText().replace('hold(DISPUTED_SHARE)', 'hold("DISPUTED_SHARE")'))[0]![0], "PARSE_SYNTAX");
});

test("guard rejects a non-ident all_claimants target as PARSE_SYNTAX, a different ident as PARSE_UNSUPPORTED", () => {
  assert.equal(errs(basicText().replace("covered(all_claimants)", 'covered("all_claimants")'))[0]![0], "PARSE_SYNTAX");
  assert.equal(errs(basicText().replace("covered(all_claimants)", "covered(some)"))[0]![0], "PARSE_UNSUPPORTED");
});

test("__proto__ is not a valid performance_pool argument name", () => {
  const src = basicText().replace("featured_weight: 70%)", "featured_weight: 70%, __proto__: 10%)");
  assert.equal(errs(src)[0]![0], "PARSE_SYNTAX");
});

test("deeply nested mix() fails with PARSE_SYNTAX instead of a RangeError", () => {
  const nested = "mix(100%: ".repeat(100) + "graph(MASTER_OWNER)" + ")".repeat(100);
  const src = withSplit(`      master = ${nested} : 45% as MASTER_OWNER;\n      performer = member_pct() : 45%;\n      agency = contract(pty_agency_s) : 10% as AGENCY;`);
  const r = parseAllocation(src);
  assert.equal(r.ok, false);
  assert.equal((r as { ok: false; errors: { code: string }[] }).errors[0]!.code, "PARSE_SYNTAX");
});

test("block order is free", () => {
  const scopeLine = '  scope { pack: pak_nova_summer_02; events: [PRIMARY, RESALE]; currency: KRW; }\n';
  const roundingLine = '  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }\n';
  const withoutScope = basicText().replace(scopeLine, "");
  const withoutRounding = withoutScope.replace(roundingLine, "");
  const reordered = withoutRounding.replace("  bind { time: ISSUE_TIME; }\n", `${roundingLine}${scopeLine}  bind { time: ISSUE_TIME; }\n`);
  assert.notEqual(reordered, basicText());
  const r = compileAllocation(reordered);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value, loadAllocationCase().policy);
});
