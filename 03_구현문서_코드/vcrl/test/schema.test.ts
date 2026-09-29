import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { evaluate } from "../src/allocation/evaluate.ts";
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
