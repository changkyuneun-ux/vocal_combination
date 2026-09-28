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
