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

test("malformed inputs return diagnostics instead of throwing", () => {
  const cases: [string, (i: EvaluationInput) => void, string][] = [
    ["snapshot undefined", (i) => { (i as { snapshot: unknown }).snapshot = undefined; }, "CORE_TYPE_ERROR"],
    ["snapshot with extra key", (i) => { (i.snapshot as unknown as Record<string, unknown>).extra = 1; }, "CORE_TYPE_ERROR"],
    ["projection.vectors undefined", (i) => { i.projection = { ...i.projection, vectors: undefined as never }; }, "CORE_TYPE_ERROR"],
    ["projection as_of number", (i) => { i.projection = { ...i.projection, as_of: 5 as never }; }, "CORE_NUMBER_IN_IR"],
    ["facts null", (i) => { (i as { facts: unknown }).facts = null; }, "CORE_TYPE_ERROR"],
    ["currency number", (i) => { i.events[0]!.currency = 5 as unknown as string; }, "CORE_TYPE_ERROR"],
  ];
  for (const [name, mutate, expected] of cases) {
    const i = basic();
    mutate(i);
    const r = evaluate(i);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.some((e) => e.code === expected), `${name}: expected ${expected}, got ${r.errors.map((e) => e.code).join(",")}`);
  }
});

test("events out of order report one CORE_TYPE_ERROR, not one per adjacent pair", () => {
  const i = basic();
  i.events = [
    { ...i.events[0]!, id: "ev_003" },
    { ...i.events[0]!, id: "ev_002" },
    { ...i.events[0]!, id: "ev_001" },
  ];
  assert.deepEqual(codes(i), ["CORE_TYPE_ERROR"]);
});

test("trace records tier1, tier2 and bucket levels in order for ev_001", () => {
  const res = run(basic());
  const trace = res.trace.filter((t) => t.event_id === "ev_001");
  assert.deepEqual(trace.map((t) => t.level), ["tier1", "tier2", "bucket:master", "bucket:performer", "bucket:work"]);
  const tier1 = trace.find((t) => t.level === "tier1")!;
  assert.equal(tier1.total, "10000");
  assert.deepEqual(tier1.parts, [
    { key: "platform", weight: "1/4", amount: "2500" },
    { key: "ops", weight: "1/20", amount: "500" },
    { key: "rights", weight: "7/10", amount: "7000" },
  ]);
});

test("result carries bind_time and events_digest", () => {
  const res = run(basic());
  assert.equal(res.bind_time, "ISSUE_TIME");
  assert.equal(res.events_digest, digestOf(basic().events));
});
