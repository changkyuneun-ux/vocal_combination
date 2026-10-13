import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type EvaluationInput } from "../../src/allocation/evaluate.ts";
import type { AllocationResult } from "../../src/allocation/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import { projectToIr } from "../../src/facts/result.ts";
import { formatAllocation } from "../../src/text/format-allocation.ts";
import { parseAllocation } from "../../src/text/parse-allocation.ts";
import { evaluationInput, loadAllocationCase, loadFactsCase, sortBody, type BasicInput } from "../helpers.ts";

// 버킷 끝의 via mandate: 실연 버킷(cap 적용 후)을 위임 수령인에게 보낸다. 001-basic은 pty_member_a → pty_agency_s 실연 위임이 있다.

const viaMandate = (i: EvaluationInput): EvaluationInput => {
  i.policy.body.tier2.split[1]!.via_mandate = true;
  return i;
};
function run(i: EvaluationInput): AllocationResult {
  const r = evaluate(i);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}
const performerLines = (res: AllocationResult, ev: string) =>
  res.lines.filter((l) => l.event_id === ev && l.bucket === "performer").map((l) => [l.party, l.role, l.amount]);

test("a performer who mandated an agency is paid through the agency, with the AGENCY line role", () => {
  const res = run(viaMandate(evaluationInput(loadAllocationCase())));
  assert.deepEqual(performerLines(res, "ev_001"), [
    ["pty_agency_s", "AGENCY", "1890"],
    ["pty_member_b", "PERFORMER_FEATURED", "1260"],
  ]);
});

test("without via mandate the performer bucket is unchanged (existing policies keep their results)", () => {
  const res = run(evaluationInput(loadAllocationCase()));
  assert.deepEqual(performerLines(res, "ev_001"), [
    ["pty_member_a", "PERFORMER_FEATURED", "1890"],
    ["pty_member_b", "PERFORMER_FEATURED", "1260"],
  ]);
});

test("cap applies to each performer before routing, so one agency may receive several performers' shares", () => {
  const c = loadAllocationCase();
  const f: BasicInput = loadFactsCase(c.facts_case);
  const m2 = f.facts.body.mandates.find((m) => m.id === "m2")!;
  f.facts.body.mandates.push({ ...m2, id: "m3", from: "pty_member_b" });
  sortBody(f);
  c.policy.depends_on[0]!.digest = digestOf(f.facts);
  const p = projectToIr(f.facts, f.usage, f.as_of, f.known_at);
  assert.ok(p.ok);
  const performer = c.policy.body.tier2.split[1]!;
  performer.vector = { fn: "cap", max: "5000", of: performer.vector };
  performer.via_mandate = true;
  const res = run({ policy: c.policy, facts: f.facts, projection: p.value, snapshot: c.snapshot, events: c.events, runId: c.run_id });
  assert.deepEqual(performerLines(res, "ev_001"), [["pty_agency_s", "AGENCY", "3150"]]);
});

test("via_mandate must be true and needs a role with a mandate right", () => {
  const codesOf = (mutate: (i: EvaluationInput) => void) => {
    const i = evaluationInput(loadAllocationCase());
    mutate(i);
    const r = evaluate(i);
    return r.ok ? [] : r.errors.map((e) => [e.code, e.path]);
  };
  assert.deepEqual(codesOf((i) => { (i.policy.body.tier2.split[1] as Record<string, unknown>).via_mandate = false; }),
    [["CORE_TYPE_ERROR", "$.body.tier2.split[1].via_mandate"]]);
  assert.deepEqual(codesOf((i) => {
    const b = i.policy.body.tier2.split[2]!;
    b.role = "CMO";
    b.vector = { fn: "contract", party: "pty_komca" };
    b.via_mandate = true;
  }), [["CORE_TYPE_ERROR", "$.body.tier2.split[2].via_mandate"]]);
});

test("bucket-level via mandate parses from text, formats back and round-trips", () => {
  const doc = loadAllocationCase().policy;
  doc.body.tier2.split[1]!.vector = { fn: "cap", max: "5000", of: doc.body.tier2.split[1]!.vector };
  doc.body.tier2.split[1]!.via_mandate = true;
  const text = formatAllocation(doc);
  assert.match(text, /performer = performance_pool\(HYBRID, [^)]*\) \|> cap\(50%\) via mandate : 45%;/);
  const back = parseAllocation(text);
  assert.ok(back.ok, JSON.stringify(back));
  assert.deepEqual(back.value.body.tier2.split, doc.body.tier2.split);
});
