import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { evaluate } from "../src/allocation/evaluate.ts";
import { reverse } from "../src/allocation/reverse.ts";
import { shadowReport } from "../src/allocation/shadow.ts";
import { projectToIr } from "../src/facts/result.ts";
import { evaluationInput, loadAllocationCase, loadFactsCase } from "./helpers.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
const load = (f: string) => JSON.parse(readFileSync(new URL(`../spec/schema/${f}`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
const projectionSchema = ajv.compile(load("projection.ir.schema.json"));
const resultSchema = ajv.compile(load("allocation.result.schema.json"));

const caseNames = (dir: string) =>
  readdirSync(new URL(`../conformance/${dir}/`, import.meta.url), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

function projection(name = "001-basic") {
  const f = loadFactsCase(name);
  return projectToIr(f.facts, f.usage, f.as_of, f.known_at);
}

test("every successful conformance projection matches the projection schema (spec 12.49)", () => {
  let n = 0;
  for (const name of caseNames("facts")) {
    const r = projection(name);
    if (!r.ok) continue;
    n++;
    assert.equal(projectionSchema(r.value), true, `${name}: ${JSON.stringify(projectionSchema.errors)}`);
  }
  assert.equal(n, 3);
});

test("every conformance allocation result matches the result schema (spec 12.49)", () => {
  let n = 0;
  for (const name of caseNames("allocation")) {
    const r = evaluate(evaluationInput(loadAllocationCase(name)));
    assert.ok(r.ok, name);
    n++;
    assert.equal(resultSchema(r.value), true, `${name}: ${JSON.stringify(resultSchema.errors)}`);
  }
  assert.equal(n, 3);
});

test("an allocation result without trace still matches the result schema (trace is optional)", () => {
  const r = evaluate(evaluationInput(loadAllocationCase()));
  assert.ok(r.ok);
  const { trace: _omit, ...untraced } = r.value;
  assert.equal(resultSchema(untraced), true, JSON.stringify(resultSchema.errors));
});

test("result schemas reject another format, unknown fields, JSON numbers and unknown roles", () => {
  const p = projection();
  assert.ok(p.ok);
  const path0 = p.value.paths[0]!;
  for (const bad of [
    { ...p.value, format: "vcrl-projection/2" },
    { ...p.value, extra: "x" },
    { ...p.value, paths: [{ ...path0, weight: 1 }] },
    { ...p.value, vectors: { NOBODY: {} } },
  ]) assert.equal(projectionSchema(bad), false, JSON.stringify(bad).slice(0, 80));

  const r = evaluate(evaluationInput(loadAllocationCase()));
  assert.ok(r.ok);
  const line0 = r.value.lines[0]!;
  for (const bad of [
    { ...r.value, format: "vcrl-allocation-result/2" },
    { ...r.value, extra: "x" },
    { ...r.value, lines: [{ ...line0, amount: 3150 }] },
    { ...r.value, lines: [{ ...line0, role: "NOBODY" }] },
    { ...r.value, holdings: [{ event_id: "ev_001", bucket: "rights", reason: "WHATEVER", amount: "1" }] },
  ]) assert.equal(resultSchema(bad), false, JSON.stringify(bad).slice(0, 80));
});

const reversalSchema = ajv.compile(load("reversal.result.schema.json"));
const shadowSchema = ajv.compile(load("shadow.report.schema.json"));

test("reversal results and shadow reports match their schemas", () => {
  const c = loadAllocationCase();
  const input = evaluationInput(c);
  const ev = evaluate(input);
  assert.ok(ev.ok);
  const first = reverse({ original: ev.value, policy: c.policy, eventId: "ev_001", refund: { id: "rf_1", reason: "REFUND", amount: "3000" }, priors: [], runId: "run_1" });
  assert.ok(first.ok);
  const second = reverse({ original: ev.value, policy: c.policy, eventId: "ev_001", refund: { id: "rf_2", reason: "REFUND", amount: "7000" }, priors: [first.value], runId: "run_2" });
  assert.ok(second.ok);
  for (const r of [first.value, second.value]) assert.equal(reversalSchema(r), true, JSON.stringify(reversalSchema.errors));
  assert.equal(reversalSchema({ ...first.value, lines: [{ ...first.value.lines[0], amount: "945" }] }), false);
  assert.equal(reversalSchema({ ...first.value, previous_digest: second.value.result_digest }), false, "sequence 1 must not carry previous_digest");
  const { previous_digest: _p, ...unlinked } = second.value;
  assert.equal(reversalSchema(unlinked), false, "sequence > 1 requires previous_digest");
  const shadow = shadowReport([{ baseline: input, candidate: input }]);
  assert.ok(shadow.ok);
  assert.equal(shadowSchema(shadow.value), true, JSON.stringify(shadowSchema.errors));
  assert.equal(shadowSchema({ ...shadow.value, extra: "x" }), false);
});

test("a shifted-policy shadow report (negative deltas) and a holdings reversal match their schemas", () => {
  const input = evaluationInput(loadAllocationCase("002-disputed-master"));
  const split = input.policy.body.tier2.split.map((b) =>
    b.name === "master" ? { ...b, bps: "4000" } : b.name === "performer" ? { ...b, bps: "5000" } : b);
  const candidate = { ...input, policy: { ...input.policy, version: "2", body: { ...input.policy.body, tier2: { split } } } };
  const shadow = shadowReport([{ baseline: input, candidate }]);
  assert.ok(shadow.ok, JSON.stringify(shadow));
  assert.ok([...shadow.value.parties, ...shadow.value.buckets, ...shadow.value.holdings].some((x) => x.delta.startsWith("-")));
  assert.ok(shadow.value.holdings.length > 0);
  assert.equal(shadowSchema(shadow.value), true, JSON.stringify(shadowSchema.errors));
  assert.equal(shadowSchema({ ...shadow.value, currency: "krw" }), false);

  const c = loadAllocationCase("003-fraud-hold");
  const ev = evaluate(evaluationInput(c));
  assert.ok(ev.ok);
  const held = ev.value.holdings[0]!;
  const rv = reverse({ original: ev.value, policy: c.policy, eventId: held.event_id, refund: { id: "rf_f", reason: "FRAUD", amount: "1000" }, priors: [], runId: "run_f" });
  assert.ok(rv.ok, JSON.stringify(rv));
  assert.ok(rv.value.holdings.length > 0);
  assert.equal(reversalSchema(rv.value), true, JSON.stringify(reversalSchema.errors));
});
