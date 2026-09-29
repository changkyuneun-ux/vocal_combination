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
