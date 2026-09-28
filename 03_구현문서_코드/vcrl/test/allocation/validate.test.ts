import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { MAX_VECTOR_DEPTH, validateAllocation } from "../../src/allocation/validate.ts";
import { diag } from "../../src/core/errors.ts";
import { formatAllocation } from "../../src/text/format-allocation.ts";
import { parseAllocation } from "../../src/text/parse-allocation.ts";
import type { VectorExpr } from "../../src/allocation/types.ts";
import { loadAllocationCase } from "../helpers.ts";

const codes = (doc: unknown) => validateAllocation(doc).map((d) => d.code).sort();
const policy = () => loadAllocationCase().policy;
const withRole = (role: string) => {
  const p = policy();
  p.body.tier2.split[0]!.role = role as never;
  return p;
};
const withVector = (v: unknown) => {
  const p = policy();
  p.body.tier2.split[1]!.vector = v as VectorExpr;
  return p;
};
const withMasterVector = (v: unknown) => {
  const p = policy();
  p.body.tier2.split[0]!.vector = v as VectorExpr;
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
  assert.deepEqual(codes(withVector({ fn: "graph", role: "PERFORMER_FEATURED", extra: "x" })), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(codes(withMasterVector({ fn: "graph", role: "MASTER_OWNER", via_mandate: false })), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(codes(withVector({ fn: "contract", party: "@hold" })), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(
    codes(withVector({ fn: "mix", parts: [
      { weight: "5000", of: { fn: "member_pct" } },
      { weight: "4000", of: { fn: "graph", role: "PERFORMER_FEATURED" } },
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
    withVector({ fn: "graph", role: "PERFORMER_FEATURED", extra: "x" }),
    withMasterVector({ fn: "graph", role: "MASTER_OWNER", via_mandate: false }),
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

test("bucket role must match its vector expression", () => {
  const at = (role: string, v: unknown) => {
    const p = policy();
    p.body.tier2.split[1]!.role = role as never;
    p.body.tier2.split[1]!.vector = v as VectorExpr;
    return validateAllocation(p).map((d) => [d.code, d.path]);
  };
  const mismatch = (field: string) => [["CORE_TYPE_ERROR", `$.body.tier2.split[1].${field}`]];
  assert.deepEqual(at("AI_PROVIDER", { fn: "graph", role: "MASTER_OWNER" }), mismatch("role"));
  assert.deepEqual(at("MASTER_OWNER", { fn: "performance_pool", mode: "MEMBER_PCT" }), mismatch("role"));
  assert.deepEqual(at("PERFORMER_NON_FEATURED", { fn: "performance_pool", mode: "HYBRID", fixed: "4000", usage: "6000", featured_weight: "7000" }), []);
  assert.deepEqual(at("MASTER_OWNER", { fn: "mix", parts: [
    { weight: "5000", of: { fn: "graph", role: "MASTER_OWNER" } },
    { weight: "5000", of: { fn: "contract", party: "pty_agency_s" } },
  ] }), []);
  assert.deepEqual(at("AI_PROVIDER", { fn: "graph", role: "AI_PROVIDER", via_mandate: true }), mismatch("vector.via_mandate"));
  // 실연 버킷 안의 비실연 graph 잎, 비실연 버킷 안의 실연 graph 잎
  assert.deepEqual(at("PERFORMER_FEATURED", { fn: "mix", parts: [
    { weight: "5000", of: { fn: "member_pct" } },
    { weight: "5000", of: { fn: "graph", role: "MASTER_OWNER" } },
  ] }), mismatch("role"));
  assert.deepEqual(at("MASTER_OWNER", { fn: "cap", max: "5000", of: { fn: "graph", role: "PERFORMER_FEATURED" } }), mismatch("role"));
  assert.match(validateAllocation(withRole("AI_PROVIDER"))[0]!.message, /role mismatch: AI_PROVIDER vs /);
});

/** graph 잎 하나를 mix(100%)로 감싸 IR 깊이 n(잎 = 1)의 벡터를 만든다. */
function nestedVector(n: number): VectorExpr {
  let v: VectorExpr = { fn: "graph", role: "MASTER_OWNER" };
  for (let i = 1; i < n; i++) v = { fn: "mix", parts: [{ weight: "10000", of: v }] };
  return v;
}

test("vector nesting depth limit matches the parser (64)", () => {
  assert.equal(MAX_VECTOR_DEPTH, 64);
  const ok = withMasterVector(nestedVector(64));
  assert.deepEqual(validateAllocation(ok), []);
  const text = formatAllocation(ok);
  const back = parseAllocation(text);
  assert.ok(back.ok, JSON.stringify(back));
  assert.deepEqual(back.value, ok);

  const deep = withMasterVector(nestedVector(65));
  assert.deepEqual(validateAllocation(deep), [diag("CORE_TYPE_ERROR", "$.body.tier2.split[0].vector", "vector nesting too deep")]);
  const deepParsed = parseAllocation(formatAllocation(deep));
  assert.equal(deepParsed.ok, false);
  assert.equal((deepParsed as { ok: false; errors: { code: string }[] }).errors[0]!.code, "PARSE_SYNTAX");
});

test("a 20,000-deep vector yields a diagnostic instead of a RangeError", () => {
  const deep = withMasterVector(nestedVector(20_000));
  assert.deepEqual(codes(deep), ["CORE_TYPE_ERROR"]);
  let v: unknown = { fn: "member_pct" };
  for (let i = 0; i < 20_000; i++) v = { fn: "cap", max: "5000", of: v };
  assert.deepEqual(codes(withVector(v)), ["CORE_TYPE_ERROR"]);
});

test("allocation v1.0 may depend only on facts", () => {
  const p = policy();
  const digest = p.depends_on[0]!.digest;
  p.depends_on = [p.depends_on[0]!, { ref: "vc:grant/g1@1", digest }, { ref: "vc:approval/a1@2", digest }];
  assert.deepEqual(validateAllocation(p), [
    diag("CORE_TYPE_ERROR", "$.depends_on[1].ref", "allocation v1.0 may depend only on facts"),
    diag("CORE_TYPE_ERROR", "$.depends_on[2].ref", "allocation v1.0 may depend only on facts"),
  ]);
});
