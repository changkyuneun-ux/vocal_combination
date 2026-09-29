import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvaluationInput } from "../../src/allocation/evaluate.ts";
import { shadowReport, verifyShadowReport } from "../../src/allocation/shadow.ts";
import type { AllocationDocument } from "../../src/allocation/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import { evaluationInput, loadAllocationCase } from "../helpers.ts";

const base = (): EvaluationInput => evaluationInput(loadAllocationCase("001-basic"));
/** master 버킷과 performer 버킷의 bps를 서로 옮긴 후보 정책(합 10000 유지). */
function shifted(policy: AllocationDocument, delta: number): AllocationDocument {
  const split = policy.body.tier2.split.map((b) => {
    if (b.name === "master") return { ...b, bps: String(Number(b.bps) - delta) };
    if (b.name === "performer") return { ...b, bps: String(Number(b.bps) + delta) };
    return b;
  });
  return { ...policy, version: "2", body: { ...policy.body, tier2: { split } } };
}
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));

test("comparing a policy with itself yields all-zero deltas", () => {
  const b = base();
  const r = shadowReport([{ baseline: b, candidate: b }]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.value.format, "vcrl-shadow-report/1");
  assert.ok([...r.value.parties, ...r.value.buckets, ...r.value.holdings].every((x) => x.delta === "0"));
  assert.deepEqual(r.value.totals, { events: "2", amount: "11001" });
  const { report_digest, ...body } = r.value;
  assert.equal(report_digest, digestOf(body));
});

test("moving 5% from master to performer shows opposite deltas that sum to zero", () => {
  const b = base();
  const c = { ...b, policy: shifted(b.policy, 500) };
  const r = shadowReport([{ baseline: b, candidate: c }]);
  assert.ok(r.ok, JSON.stringify(r));
  const bucket = (level: string, name: string) => r.value.buckets.find((x) => x.level === level && x.bucket === name)!;
  assert.ok(BigInt(bucket("tier2", "master").delta) < 0n);
  assert.ok(BigInt(bucket("tier2", "performer").delta) > 0n);
  assert.equal(bucket("tier1", "rights").delta, "0");
  assert.equal(r.value.parties.reduce((a, p) => a + BigInt(p.delta), 0n), 0n);
  const label = r.value.parties.find((p) => p.party === "pty_label_x")!;
  assert.equal(BigInt(label.candidate) - BigInt(label.baseline), BigInt(label.delta));
  assert.ok(r.value.parties.every((p, i, xs) => i === 0 || xs[i - 1]!.party < p.party || (xs[i - 1]!.party === p.party && xs[i - 1]!.role < p.role)));
});

test("mismatched events, duplicate events, empty pairs and evaluation errors are rejected", () => {
  const b = base();
  const other = { ...b, events: b.events.map((e) => ({ ...e, amount: String(Number(e.amount) + 1) })) };
  assert.deepEqual(codes(shadowReport([{ baseline: b, candidate: other }])), ["SHADOW_EVENTS_MISMATCH"]);
  assert.deepEqual(codes(shadowReport([{ baseline: b, candidate: b }, { baseline: b, candidate: b }])), ["SHADOW_DUPLICATE_EVENT", "SHADOW_DUPLICATE_EVENT"]);
  assert.deepEqual(codes(shadowReport([])), ["CORE_TYPE_ERROR"]);
  const broken = shadowReport([{ baseline: b, candidate: { ...b, runId: "bad id" } }]);
  assert.equal(broken.ok, false);
  assert.ok(!broken.ok && broken.errors.every((e) => e.path.startsWith("$.pairs[0].candidate")), JSON.stringify(broken));
});

test("verifyShadowReport accepts an honest report and rejects a re-sealed forgery", () => {
  const b = base();
  const pairs = [{ baseline: b, candidate: { ...b, policy: shifted(b.policy, 500) } }];
  const r = shadowReport(pairs);
  assert.ok(r.ok);
  assert.deepEqual(verifyShadowReport(pairs, r.value), []);
  assert.deepEqual(verifyShadowReport(pairs, 1).map((d) => d.code), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(verifyShadowReport(pairs, { ...r.value, format: "x" }).map((d) => d.path), ["$.result.format"]);
  const { report_digest: _d, ...rest } = { ...r.value, totals: { ...r.value.totals, amount: "1" } };
  assert.deepEqual(verifyShadowReport(pairs, { ...rest, report_digest: digestOf(rest) }).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);
});
