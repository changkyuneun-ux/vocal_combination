import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { projectToIr } from "../src/facts/result.ts";
import { evaluate } from "../src/allocation/evaluate.ts";
import { reverse, type ReversalResult } from "../src/allocation/reverse.ts";
import { evaluationInput, loadAllocationCase } from "./helpers.ts";

const root = new URL("../conformance/facts/", import.meta.url);

const cases = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

for (const name of cases) {
  test(`conformance facts/${name}`, () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`${name}/${f}`, root), "utf8"));
    const input = read("input.json");
    const expected = read("expected.json");
    const r = projectToIr(input.facts, input.usage, input.as_of, input.known_at);
    if (expected.errors !== undefined) {
      assert.equal(r.ok, false);
      assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.code).sort(), expected.errors);
      return;
    }
    assert.ok(r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const ir = r.value;
    assert.deepEqual(ir.vectors, expected.vectors);
    assert.deepEqual(ir.paths, expected.paths);
    assert.equal(ir.format, expected.format);
    assert.equal(ir.digest, expected.digest);
  });
}

const allocationRoot = new URL("../conformance/allocation/", import.meta.url);
const allocationCases = readdirSync(allocationRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

for (const name of allocationCases) {
  test(`conformance allocation/${name}`, () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`${name}/${f}`, allocationRoot), "utf8"));
    const expected = read("expected.json");
    const r = evaluate(evaluationInput(read("input.json")));
    if (expected.errors !== undefined) {
      assert.equal(r.ok, false);
      assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.code).sort(), expected.errors);
      return;
    }
    assert.ok(r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.deepEqual(r.value.pool_lines, expected.pool_lines);
    assert.deepEqual(r.value.lines, expected.lines);
    assert.deepEqual(r.value.holdings, expected.holdings);
    assert.equal(r.value.format, expected.format);
    assert.equal(r.value.result_digest, expected.result_digest);
  });
}

const reversalRoot = new URL("../conformance/reversal/", import.meta.url);
const reversalCases = readdirSync(reversalRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

for (const name of reversalCases) {
  test(`conformance reversal/${name}`, () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`${name}/${f}`, reversalRoot), "utf8"));
    const input = read("input.json");
    const expected = read("expected.json");
    const c = loadAllocationCase(input.allocation_case);
    const ev = evaluate(evaluationInput(c));
    assert.ok(ev.ok);
    const priors: ReversalResult[] = [];
    input.steps.forEach((s: { run_id: string; refund: ReversalResult["refund"] }, i: number) => {
      const want = expected.steps[i];
      const r = reverse({ original: ev.value, policy: c.policy, eventId: input.event_id, refund: s.refund, priors, runId: s.run_id });
      if (want.errors !== undefined) {
        assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.code).sort(), want.errors, `step ${i}`);
        return;
      }
      assert.ok(r.ok, `step ${i}: ${JSON.stringify(r)}`);
      assert.equal(r.value.sequence, want.sequence);
      assert.equal(r.value.cumulative, want.cumulative);
      assert.deepEqual(r.value.pool_lines, want.pool_lines);
      assert.deepEqual(r.value.lines, want.lines);
      assert.deepEqual(r.value.holdings, want.holdings);
      assert.equal(r.value.result_digest, want.result_digest);
      priors.push(r.value);
    });
  });
}
