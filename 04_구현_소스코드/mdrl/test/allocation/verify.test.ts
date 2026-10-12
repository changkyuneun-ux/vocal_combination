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
  assert.deepEqual(at(verifyAllocationResult(input, { ...result, format: "mdrl-allocation-result/2" })), ["CORE_TYPE_ERROR $.result.format"]);
  const { format: _omit, ...untagged } = result;
  assert.deepEqual(at(verifyAllocationResult(input, untagged)), ["CORE_TYPE_ERROR $.result.format"]);
});

test("a genuine result without trace verifies (trace is outside the seal)", () => {
  const { input, result } = setup();
  const { trace: _omit, ...untraced } = result;
  assert.deepEqual(verifyAllocationResult(input, untraced), []);
});

test("a forged trace is caught against the recomputed trace", () => {
  const { input, result } = setup();
  const forged = structuredClone(result);
  forged.trace[0]!.total = "1";
  const ds = verifyAllocationResult(input, forged);
  assert.deepEqual(at(ds), ["CORE_DIGEST_MISMATCH $.result.trace"]);
  assert.match(ds[0]!.message, /: trace does not match the recomputed trace$/);
});

test("a hostile trace is diagnosed, not thrown", () => {
  const { input, result } = setup();
  const ds = verifyAllocationResult(input, { ...result, trace: JSON.parse('{"toString":1}') });
  assert.ok(ds.length > 0);
  assert.ok(ds.every((d) => d.path.startsWith("$.result.trace")), JSON.stringify(ds));
});

test("tampered content is caught even when result_digest is re-sealed", () => {
  const { input, result } = setup();
  const forged = structuredClone(result);
  forged.lines[0]!.amount = "1";
  forged.result_digest = digestOf({ ...forged, result_digest: undefined, trace: undefined });
  assert.deepEqual(at(verifyAllocationResult(input, forged)), ["CORE_DIGEST_MISMATCH $.result", "CORE_DIGEST_MISMATCH $.result.result_digest"]);
});

test("a different projection digest is reported", () => {
  const { input, result } = setup();
  const other = { ...result, projection_digest: `mdrl:sha256:${"0".repeat(64)}` };
  assert.deepEqual(at(verifyAllocationResult(input, other)), ["CORE_DIGEST_MISMATCH $.result", "CORE_DIGEST_MISMATCH $.result.projection_digest"]);
});

const hostile = () => JSON.parse('{"toString":1}');

test("hostile format values are diagnosed, not thrown", () => {
  const { input, result } = setup();
  for (const format of [hostile(), Object.create(null)]) {
    assert.deepEqual(at(verifyAllocationResult(input, { ...result, format })), ["CORE_TYPE_ERROR $.result.format"]);
  }
});

test("hostile digest values are diagnosed, not thrown", () => {
  const { input, result } = setup();
  const ds = at(verifyAllocationResult(input, { ...result, projection_digest: hostile(), result_digest: hostile() }));
  assert.ok(ds.includes("CORE_DIGEST_MISMATCH $.result.projection_digest"), ds.join());
  assert.ok(ds.includes("CORE_DIGEST_MISMATCH $.result.result_digest"), ds.join());
});

test("a forged projection_digest alone, re-sealed, is reported", () => {
  const { input, result } = setup();
  const forged = { ...result, projection_digest: `mdrl:sha256:${"0".repeat(64)}` };
  forged.result_digest = digestOf({ ...forged, result_digest: undefined, trace: undefined });
  assert.deepEqual(at(verifyAllocationResult(input, forged)), ["CORE_DIGEST_MISMATCH $.result", "CORE_DIGEST_MISMATCH $.result.projection_digest", "CORE_DIGEST_MISMATCH $.result.result_digest"]);
});

test("malformed verification input is diagnosed, not thrown", () => {
  const { input, result } = setup();
  assert.deepEqual(at(verifyAllocationResult(null as unknown as VerificationInput, result)), ["CORE_TYPE_ERROR $"]);
  for (const k of ["asOf", "knownAt", "runId"] as const) {
    const ds = verifyAllocationResult({ ...input, [k]: hostile() }, result);
    assert.ok(ds.length > 0, k);
  }
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
