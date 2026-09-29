import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/allocation/evaluate.ts";
import { reverse, verifyReversal, type ReversalResult, type Refund } from "../../src/allocation/reverse.ts";
import type { AllocationResult } from "../../src/allocation/types.ts";
import { digestOf } from "../../src/core/digest.ts";
import { evaluationInput, loadAllocationCase } from "../helpers.ts";

function original(name = "001-basic"): { result: AllocationResult; policy: ReturnType<typeof loadAllocationCase>["policy"] } {
  const c = loadAllocationCase(name);
  const r = evaluate(evaluationInput(c));
  if (!r.ok) throw new Error(r.errors.map((e) => e.code).join(","));
  return { result: r.value, policy: c.policy };
}
const refund = (amount: string, id = "rf_1", reason: Refund["reason"] = "REFUND"): Refund => ({ id, reason, amount });
const codes = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.code));
const sum = (xs: readonly { amount: string }[]) => xs.reduce((a, x) => a + BigInt(x.amount), 0n);

test("a 30% refund of ev_001 reverses every pool, bucket and line exactly (hand-computed)", () => {
  const { result, policy } = original();
  const r = reverse({ original: result, policy, eventId: "ev_001", refund: refund("3000"), priors: [], runId: "run_rev_1" });
  assert.ok(r.ok, JSON.stringify(r));
  const v = r.value;
  assert.equal(v.format, "vcrl-reversal-result/1");
  assert.equal(v.method, "REVERSAL_REMAINING_LRM_V1");
  assert.equal(v.sequence, "1");
  assert.equal(v.cumulative, "3000");
  assert.equal(v.original_amount, "10000");
  assert.equal(v.previous_digest, undefined);
  assert.equal(v.original_result_digest, result.result_digest);
  assert.deepEqual(v.pool_lines, [
    { event_id: "ev_001", bucket: "platform", amount: "-750" },
    { event_id: "ev_001", bucket: "ops", amount: "-150" },
    { event_id: "ev_001", bucket: "rights", amount: "-2100" },
  ]);
  assert.deepEqual(v.lines.map((l) => [l.party, l.bucket, l.line_seq, l.reverses_line_seq, l.amount]), [
    ["pty_label_x", "master", "2", "1", "-945"],
    ["pty_member_a", "performer", "2", "1", "-567"],
    ["pty_member_b", "performer", "2", "1", "-378"],
    ["pty_author_c", "work", "2", "1", "-84"],
    ["pty_komca", "work", "2", "1", "-126"],
  ]);
  assert.deepEqual(v.holdings, []);
  const { result_digest, ...body } = v;
  assert.equal(result_digest, digestOf(body));
});

test("partial refunds chained to the full amount net every line of the event to exactly zero", () => {
  const { result, policy } = original();
  const priors: ReversalResult[] = [];
  for (const [i, amount] of ["3333", "1", "6666"].entries()) {
    const r = reverse({ original: result, policy, eventId: "ev_001", refund: refund(amount, `rf_${i}`), priors, runId: `run_${i}` });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.sequence, String(i + 1));
    assert.equal(r.value.previous_digest, i === 0 ? undefined : priors[i - 1]!.result_digest);
    assert.ok(r.value.lines.every((l) => l.line_seq === String(i + 2)));
    assert.equal(-sum(r.value.pool_lines), BigInt(amount));
    priors.push(r.value);
  }
  const net = new Map<string, bigint>();
  const add = (k: string, a: string) => net.set(k, (net.get(k) ?? 0n) + BigInt(a));
  for (const l of result.lines.filter((l) => l.event_id === "ev_001")) add(`${l.party}/${l.bucket}`, l.amount);
  for (const p of result.pool_lines.filter((l) => l.event_id === "ev_001")) add(`pool/${p.bucket}`, p.amount);
  for (const rv of priors) {
    for (const l of rv.lines) add(`${l.party}/${l.bucket}`, l.amount);
    for (const p of rv.pool_lines) add(`pool/${p.bucket}`, p.amount);
  }
  assert.ok([...net.values()].every((v) => v === 0n), JSON.stringify([...net].map(([k, v]) => [k, v.toString()])));
  const over = reverse({ original: result, policy, eventId: "ev_001", refund: refund("1", "rf_x"), priors, runId: "run_x" });
  assert.deepEqual(codes(over), ["REV_EXCEEDS_REMAINING"]);
});

test("a fraud-held event reverses its holding (003-fraud-hold)", () => {
  const { result, policy } = original("003-fraud-hold");
  const held = result.holdings[0]!;
  const r = reverse({ original: result, policy, eventId: held.event_id, refund: refund(
    result.pool_lines.filter((p) => p.event_id === held.event_id).reduce((a, p) => a + BigInt(p.amount), 0n).toString(), "rf_f", "FRAUD",
  ), priors: [], runId: "run_f" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value.holdings, [{ ...held, amount: `-${held.amount}` }]);
  assert.equal(r.value.refund.reason, "FRAUD");
});

test("input errors are reported with their codes", () => {
  const { result, policy } = original();
  const base = { original: result, policy, eventId: "ev_001", refund: refund("100"), priors: [] as ReversalResult[], runId: "run_e" };
  assert.deepEqual(codes(reverse({ ...base, eventId: "ev_999" })), ["REV_UNKNOWN_EVENT"]);
  assert.deepEqual(codes(reverse({ ...base, refund: refund("0") })), ["REV_AMOUNT"]);
  assert.deepEqual(codes(reverse({ ...base, refund: refund("-5") })), ["REV_AMOUNT"]);
  assert.deepEqual(codes(reverse({ ...base, refund: refund("10001") })), ["REV_EXCEEDS_REMAINING"]);
  assert.deepEqual(codes(reverse({ ...base, refund: { ...refund("1"), reason: "OOPS" as never } })), ["CORE_ENUM_UNKNOWN"]);
  const tampered = { ...result, lines: result.lines.map((l, i) => (i === 0 ? { ...l, amount: "3151" } : l)) };
  assert.deepEqual(codes(reverse({ ...base, original: tampered })), ["REV_ORIGINAL_DIGEST"]);
  const resealed = { ...tampered, result_digest: digestOf({ ...tampered, trace: undefined, result_digest: undefined }) };
  assert.deepEqual(codes(reverse({ ...base, original: resealed })), ["REV_ORIGINAL_INCONSISTENT"]);
  const otherPolicy = { ...policy, version: "2" };
  assert.deepEqual(codes(reverse({ ...base, policy: otherPolicy })), ["CORE_DIGEST_MISMATCH"]);
  assert.deepEqual(codes(reverse({ ...base, original: { ...result, format: "x" } as never })), ["CORE_TYPE_ERROR", "REV_ORIGINAL_DIGEST"]);
});

test("a prior that does not re-derive breaks the chain", () => {
  const { result, policy } = original();
  const first = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100"), priors: [], runId: "run_1" });
  assert.ok(first.ok);
  const forged = { ...first.value, lines: first.value.lines.map((l, i) => (i === 0 ? { ...l, amount: "-1" } : l)) };
  const r1 = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100", "rf_2"), priors: [forged], runId: "run_2" });
  assert.deepEqual(codes(r1), ["REV_CHAIN_BROKEN"]);
  const other = reverse({ original: result, policy, eventId: "ev_002", refund: refund("100"), priors: [], runId: "run_1" });
  assert.ok(other.ok);
  const r2 = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100", "rf_2"), priors: [other.value], runId: "run_2" });
  assert.deepEqual(codes(r2), ["REV_CHAIN_BROKEN"]);
  const ok2 = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100", "rf_2"), priors: [first.value], runId: "run_2" });
  assert.ok(ok2.ok);
  assert.equal(ok2.value.previous_digest, first.value.result_digest);
});

test("chain: a re-sealed forged prior and a skipped first reversal are both rejected", () => {
  const { result, policy } = original();
  const first = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100"), priors: [], runId: "run_1" });
  assert.ok(first.ok);
  const second = reverse({ original: result, policy, eventId: "ev_001", refund: refund("200", "rf_2"), priors: [first.value], runId: "run_2" });
  assert.ok(second.ok);
  const forgedBody = { ...first.value, lines: first.value.lines.map((l, i) => (i === 0 ? { ...l, amount: "-1" } : l)) };
  const { result_digest: _d, ...rest } = forgedBody;
  const resealed = { ...rest, result_digest: digestOf(rest) } as ReversalResult;
  const r1 = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100", "rf_3"), priors: [resealed], runId: "run_3" });
  assert.deepEqual(codes(r1), ["REV_CHAIN_BROKEN"]);
  const r2 = reverse({ original: result, policy, eventId: "ev_001", refund: refund("100", "rf_3"), priors: [second.value], runId: "run_3" });
  assert.deepEqual(codes(r2), ["REV_CHAIN_BROKEN"]);
});

test("a re-sealed original with malformed row fields is a CORE_TYPE_ERROR at the row path", () => {
  const { result, policy } = original();
  const seal = (o: Record<string, unknown>) => ({ ...o, result_digest: digestOf({ ...o, trace: undefined, result_digest: undefined }) }) as unknown as AllocationResult;
  const base = { original: result, policy, eventId: "ev_001", refund: refund("100"), priors: [] as ReversalResult[], runId: "run_h" };
  const mutLine = (patch: Record<string, unknown>) => seal({ ...result, lines: result.lines.map((l, i) => (i === 3 ? { ...l, ...patch } : l)) });
  for (const [patch, field] of [[{ party: "Not An Id" }, "party"], [{ bucket: "Bad" }, "bucket"], [{ role: "NOPE" }, "role"], [{ line_seq: "0" }, "line_seq"]] as const) {
    const r = reverse({ ...base, original: mutLine(patch) });
    assert.ok(!r.ok);
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [["CORE_TYPE_ERROR", `$.original.lines[3].${field}`]]);
  }
  const badPool = seal({ ...result, pool_lines: result.pool_lines.map((p, i) => (i === 0 ? { ...p, bucket: "Bad" } : p)) });
  const rp = reverse({ ...base, original: badPool });
  assert.ok(!rp.ok);
  assert.deepEqual(rp.errors.map((e) => [e.code, e.path]), [["CORE_TYPE_ERROR", "$.original.pool_lines[0].bucket"]]);
  const held = original("003-fraud-hold");
  const h = held.result.holdings[0]!;
  const hi = held.result.holdings.indexOf(h);
  const badHold = seal({ ...held.result, holdings: held.result.holdings.map((x, i) => (i === hi ? { ...x, reason: "WHY" } : x)) });
  const rh = reverse({ original: badHold, policy: held.policy, eventId: h.event_id, refund: refund("1"), priors: [], runId: "run_h" });
  assert.ok(!rh.ok);
  assert.deepEqual(rh.errors.map((e) => [e.code, e.path]), [["CORE_TYPE_ERROR", `$.original.holdings[${hi}].reason`]]);
});

test("verifyReversal accepts an honest result and rejects forgeries, including re-sealed ones", () => {
  const { result, policy } = original();
  const r = reverse({ original: result, policy, eventId: "ev_001", refund: refund("1234"), priors: [], runId: "run_v" });
  assert.ok(r.ok);
  const input = { original: result, policy, priors: [] };
  assert.deepEqual(verifyReversal(input, r.value), []);
  assert.deepEqual(verifyReversal(input, "x").map((d) => d.code), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(verifyReversal(input, { ...r.value, format: "vcrl-reversal-result/2" }).map((d) => d.path), ["$.result.format"]);
  const moved = r.value.lines.map((l, i) => (i === 0 ? { ...l, amount: String(BigInt(l.amount) - 1n) } : i === 1 ? { ...l, amount: String(BigInt(l.amount) + 1n) } : l));
  const { result_digest: _d, ...rest } = { ...r.value, lines: moved };
  const resealed = { ...rest, result_digest: digestOf(rest) };
  assert.deepEqual(verifyReversal(input, resealed).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);
  assert.deepEqual(verifyReversal(input, { ...r.value, refund: { ...r.value.refund, amount: "99999" } }).map((d) => d.code), ["REV_EXCEEDS_REMAINING"]);
});
