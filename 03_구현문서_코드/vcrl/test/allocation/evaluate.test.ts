import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type EvaluationInput } from "../../src/allocation/evaluate.ts";
import type { AllocationResult } from "../../src/allocation/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import { projectToIr } from "../../src/facts/result.ts";
import type { ProjectionIr } from "../../src/facts/result.ts";
import { evaluationInput, loadAllocationCase, loadFactsCase, sortBody, type BasicInput } from "../helpers.ts";

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
/** 기본 케이스의 facts를 바꿔 평가 입력을 다시 만든다(정규형 정렬, depends_on digest·투영 재계산). */
function withFacts(change: (f: BasicInput) => BasicInput): EvaluationInput {
  const c = loadAllocationCase();
  const f = sortBody(change(loadFactsCase(c.facts_case)));
  c.policy.depends_on[0]!.digest = digestOf(f.facts);
  const p = projectToIr(f.facts, f.usage, f.as_of, f.known_at);
  assert.ok(p.ok);
  return { policy: c.policy, facts: f.facts, projection: p.value, snapshot: c.snapshot, events: c.events, runId: c.run_id };
}
const renameParty = (from: string, to: string) => (f: BasicInput): BasicInput => JSON.parse(JSON.stringify(f).replaceAll(`"${from}"`, `"${to}"`));
function assertConserved(res: AllocationResult, i: EvaluationInput): void {
  for (const ev of i.events) {
    const pool = res.pool_lines.filter((l) => l.event_id === ev.id);
    assert.equal(pool.reduce((a, l) => a + BigInt(l.amount), 0n), BigInt(ev.amount));
    const rights = BigInt(pool.find((l) => l.bucket === "rights")!.amount);
    const paid = [...res.lines, ...res.holdings].filter((l) => l.event_id === ev.id).reduce((a, l) => a + BigInt(l.amount), 0n);
    assert.equal(paid, rights);
  }
}
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
  assertConserved(run(basic()), basic());
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
  j.policy.body.tier2.split[0]!.role = "RECORDING_CONTRIBUTOR";
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
    ["projection as_of number", (i) => { i.projection = { ...i.projection, as_of: 5 as never }; }, "CORE_TYPE_ERROR"],
    ["projection number inside paths", (i) => {
      i.projection = { ...i.projection, paths: [{ ...i.projection.paths[0]!, weight: 5 as never }] };
    }, "CORE_NUMBER_IN_IR"],
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

test("a party id named after an Object.prototype member evaluates end to end", () => {
  const i = withFacts(renameParty("pty_member_b", "constructor"));
  i.snapshot = { members: { constructor: "1/2", pty_member_a: "1/2" } };
  i.policy.body.tier2.split[1]!.vector = {
    fn: "floor_guarantee", min: "1000",
    of: { fn: "performance_pool", mode: "HYBRID", fixed: "4000", usage: "6000", featured_weight: "7000" },
  };
  const res = run(i);
  assertConserved(res, i);
  assert.ok(res.lines.some((l) => l.party === "constructor"));
  // 벡터에 없는 멤버(constructor)를 floor_guarantee가 끌어올리는 경로
  const j = withFacts(renameParty("pty_member_b", "constructor"));
  j.snapshot = { members: { constructor: "1/2", pty_member_a: "1/2" } };
  j.policy.body.tier2.split[2]!.vector = { fn: "floor_guarantee", min: "1000", of: j.policy.body.tier2.split[2]!.vector };
  const res2 = run(j);
  assertConserved(res2, j);
  assert.ok(res2.lines.some((l) => l.bucket === "work" && l.party === "constructor"));
});

test("line and trace order use code-unit key order, not JS integer-like key order", () => {
  const i = withFacts((f) => {
    for (const id of ["10", "9", "a"]) f.facts.body.parties.push({ id, kind: "PERFORMER" });
    return f;
  });
  i.snapshot = { members: { "10": "1/5", "9": "1/5", a: "1/5", pty_member_a: "1/5", pty_member_b: "1/5" } };
  i.policy.body.tier2.split[1]!.vector = { fn: "member_pct" };
  const res = run(i);
  const order = ["10", "9", "a", "pty_member_a", "pty_member_b"];
  assert.deepEqual(res.lines.filter((l) => l.event_id === "ev_001" && l.bucket === "performer").map((l) => l.party), order);
  const trace = res.trace.find((t) => t.event_id === "ev_001" && t.level === "bucket:performer")!;
  assert.deepEqual(trace.parts.map((p) => p.key), order);
});

test("projection instants and digests are validated", () => {
  const i = basic();
  const body = { ...i.projection, as_of: "garbage", digest: undefined };
  i.projection = { ...body, digest: digestOf(body) };
  const r = evaluate(i);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [["CORE_TYPE_ERROR", "$.projection.as_of"]]);
  for (const field of ["known_at", "digest", "facts_digest", "u_digest"] as const) {
    const j = basic();
    j.projection = { ...j.projection, [field]: "x" };
    const rj = evaluate(j);
    assert.equal(rj.ok, false, field);
    if (!rj.ok) assert.deepEqual(rj.errors.map((e) => [e.code, e.path]), [["CORE_TYPE_ERROR", `$.projection.${field}`]], field);
  }
});

test("performer coverage is checked per party", () => {
  const i = basic();
  i.snapshot = { members: { pty_member_a: "1/1" } };
  i.policy.body.tier2.split[1]!.vector = { fn: "performance_pool", mode: "MEMBER_PCT" };
  const r = evaluate(i);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [["ALLOC_UNCOVERED_CLAIMANT", "$.body.tier2.split"]]);
    assert.match(r.errors[0]!.message, /PERFORMER_FEATURED:pty_member_b/);
  }
  const j = basic();
  j.snapshot = { members: { pty_member_a: "1/1" } };
  assertConserved(run(j), j);
});

test("performer line role comes from the party's role in the projection", () => {
  const i = withFacts((f) => {
    const b = f.facts.body;
    const base = { status: "VERIFIED", valid: { from: "2026-01-01T00:00:00.000Z" }, recorded_at: "2026-01-01T00:00:00.000Z" } as const;
    b.parties.push({ id: "pty_member_c", kind: "PERFORMER" });
    b.voices.push({ id: "vo_c", kind: "HUMAN" });
    b.claims.push(
      { id: "c8", source: "stm_v2", edge: "PERFORMED_BY", target: "vo_c", share: "10000", performer_role: "NON_FEATURED", ...base },
      { id: "c9", source: "vo_c", edge: "OWNED_BY", target: "pty_member_c", share: "10000", ...base },
    );
    return f;
  });
  i.snapshot = { members: { pty_member_a: "1/3", pty_member_b: "1/3", pty_member_c: "1/3" } };
  const res = run(i);
  assertConserved(res, i);
  const roles = new Map(res.lines.filter((l) => l.bucket === "performer").map((l) => [l.party, l.role]));
  assert.deepEqual([...roles], [
    ["pty_member_a", "PERFORMER_FEATURED"],
    ["pty_member_b", "PERFORMER_FEATURED"],
    ["pty_member_c", "PERFORMER_NON_FEATURED"],
  ]);
});

test("zero-amount parts produce no line but stay in the trace", () => {
  const i = basic();
  i.events = [{ ...i.events[0]!, amount: "1" }];
  const res = run(i);
  assert.equal(res.lines.some((l) => l.amount === "0"), false);
  // rights 1 → tier2 동률(9/20)에서 master가 key 순으로 1을 받는다
  assert.deepEqual(linesOf(res, "ev_001"), [["master", "pty_label_x", "MASTER_OWNER", "1"]]);
  const performer = res.trace.find((t) => t.level === "bucket:performer")!;
  assert.deepEqual(performer.parts.map((p) => [p.key, p.amount]), [["pty_member_a", "0"], ["pty_member_b", "0"]]);
});

test("an AGENCY party in a non-performer bucket gets the AGENCY line role", () => {
  const i = basic();
  i.policy.body.tier2.split[0]!.vector = { fn: "mix", parts: [
    { weight: "5000", of: { fn: "graph", role: "MASTER_OWNER" } },
    { weight: "5000", of: { fn: "contract", party: "pty_agency_s" } },
  ] };
  const res = run(i);
  assert.deepEqual(linesOf(res, "ev_001").filter((l) => l[0] === "master"), [
    ["master", "pty_agency_s", "AGENCY", "1575"],
    ["master", "pty_label_x", "MASTER_OWNER", "1575"],
  ]);
});

test("duplicate event ids are rejected as not strictly sorted", () => {
  const i = basic();
  i.events[1]!.id = i.events[0]!.id;
  const r = evaluate(i);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [["CORE_TYPE_ERROR", "$.events"]]);
    assert.match(r.errors[0]!.message, /not sorted by id/);
  }
});

test("diagnostics from nested inputs carry the input's path prefix", () => {
  const paths = (mutate: (i: EvaluationInput) => void) => {
    const i = basic();
    mutate(i);
    const r = evaluate(i);
    assert.equal(r.ok, false);
    return r.ok ? [] : r.errors.map((e) => [e.code, e.path]);
  };
  assert.deepEqual(paths((i) => { (i as { facts: unknown }).facts = null; }), [["CORE_TYPE_ERROR", "$.facts"]]);
  assert.deepEqual(paths((i) => { i.facts.id = "a b"; }), [["CORE_TYPE_ERROR", "$.facts.id"]]);
  assert.deepEqual(paths((i) => { i.facts.body.parties[0]!.kind = "NOBODY" as never; }), [["CORE_ENUM_UNKNOWN", "$.facts.body.parties[0].kind"]]);
  assert.deepEqual(
    paths((i) => { i.projection = { ...i.projection, paths: [{ ...i.projection.paths[0]!, weight: 5 as never }] }; }),
    [["CORE_NUMBER_IN_IR", "$.projection.paths[0].weight"]],
  );
  assert.deepEqual(paths((i) => { (i.snapshot as unknown as Record<string, unknown>).extra = "x"; }), [["CORE_TYPE_ERROR", "$.snapshot.extra"]]);
  assert.deepEqual(paths((i) => { i.snapshot = { members: { pty_ghost: "1/1" } }; }), [["FACTS_UNKNOWN_PARTY", "$.snapshot.members.pty_ghost"]]);
});

test("performer coverage is judged per role: graph(PERFORMER_FEATURED) does not reach NON_FEATURED parties", () => {
  const withGuest = (members: Record<string, string>) => {
    const i = withFacts((f) => {
      const b = f.facts.body;
      const base = { status: "VERIFIED", valid: { from: "2026-01-01T00:00:00.000Z" }, recorded_at: "2026-01-01T00:00:00.000Z" } as const;
      b.parties.push({ id: "pty_guest", kind: "PERFORMER" });
      b.voices.push({ id: "vo_g", kind: "HUMAN" });
      b.claims.push(
        { id: "c8", source: "stm_v2", edge: "PERFORMED_BY", target: "vo_g", share: "10000", performer_role: "NON_FEATURED", ...base },
        { id: "c9", source: "vo_g", edge: "OWNED_BY", target: "pty_guest", share: "10000", ...base },
      );
      return f;
    });
    i.snapshot = { members };
    const [master, performer, work] = i.policy.body.tier2.split;
    i.policy.body.tier2.split = [
      master!,
      { ...performer!, bps: "2500", vector: { fn: "performance_pool", mode: "FIXED" } },
      { name: "performer_usage", bps: "2000", role: "PERFORMER_FEATURED", vector: { fn: "graph", role: "PERFORMER_FEATURED" } },
      work!,
    ];
    return i;
  };
  const r = evaluate(withGuest({ pty_member_a: "1/2", pty_member_b: "1/2" }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [["ALLOC_UNCOVERED_CLAIMANT", "$.body.tier2.split"]]);
    assert.match(r.errors[0]!.message, /PERFORMER_NON_FEATURED:pty_guest/);
  }
  const ok = withGuest({ pty_guest: "1/3", pty_member_a: "1/3", pty_member_b: "1/3" });
  assertConserved(run(ok), ok);
});

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

test("evaluate diagnoses a hostile projection format without throwing", () => {
  const input = basic();
  const projection = { ...input.projection, format: JSON.parse('{"toString":1}') } as unknown as ProjectionIr;
  const r = evaluate({ ...input, projection });
  assert.ok(!r.ok && r.errors.some((e) => e.code === "CORE_TYPE_ERROR" && e.path === "$.projection.format"), JSON.stringify(r));
});
