import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatAllocation, formatPercent } from "../../src/text/format-allocation.ts";
import { compileAllocation, parseAllocation } from "../../src/text/parse-allocation.ts";
import { validateAllocation } from "../../src/allocation/validate.ts";
import { evaluate } from "../../src/allocation/evaluate.ts";
import type { AllocationDocument } from "../../src/allocation/types.ts";
import { MdrlError } from "../../src/core/errors.ts";
import { evaluationInput, loadAllocationCase } from "../helpers.ts";

const sample = (name: string) => readFileSync(new URL(`../../samples/${name}.mdrl`, import.meta.url), "utf8");
function roundTrip(doc: AllocationDocument) {
  const text = formatAllocation(doc);
  const back = parseAllocation(text);
  assert.ok(back.ok, `${text}\n${JSON.stringify(back)}`);
  assert.deepEqual(back.value, doc);
  return text;
}

test("formatPercent uses integer arithmetic", () => {
  assert.deepEqual(["4500", "1250", "1", "5", "50", "105", "10000", "0"].map(formatPercent), [
    "45%", "12.5%", "0.01%", "0.05%", "0.5%", "1.05%", "100%", "0%",
  ]);
});

test("conformance policy formats to canonical text and round-trips", () => {
  const text = roundTrip(loadAllocationCase().policy);
  assert.match(text, /^allocation "VC-ALLOC-NOVA-02" version 1 \{\n/);
  assert.match(text, /\n      work = graph\(WORK_AUTHOR\) via mandate : 10%;\n/);
  assert.match(text, /\n    ops = 5%;\n/);
  assert.doesNotMatch(text, /visibility|guard|exceptions| as /);
});

test("explicit roles, quoted ids, pipes and visibility round-trip", () => {
  const doc = loadAllocationCase().policy;
  doc.visibility_default = "PUBLIC";
  doc.body.tier2.split = [
    { name: "master", bps: "4500", role: "MASTER_OWNER", vector: { fn: "floor_guarantee", min: "5", of: { fn: "cap", max: "6000", of: {
      fn: "mix", parts: [{ weight: "5000", of: { fn: "graph", role: "MASTER_OWNER" } }, { weight: "5000", of: { fn: "contract", party: "10" } }],
    } } } },
    { name: "performer", bps: "4500", role: "PERFORMER_NON_FEATURED", vector: { fn: "performance_pool", mode: "FIXED" } },
    { name: "agency", bps: "1000", role: "AGENCY", vector: { fn: "contract", party: "pty_agency_s" } },
  ];
  const text = roundTrip(doc);
  assert.match(text, /contract\("10"\)/);
  assert.match(text, / : 45% as PERFORMER_NON_FEATURED;/);
  assert.match(text, / : 10% as AGENCY;/);
  assert.match(text, /\n  visibility PUBLIC;\n/);
});

test("non-facts dependencies are rejected by the validator and cannot be written as text", () => {
  const doc = loadAllocationCase().policy;
  doc.depends_on = [{ ref: "vc:grant/g1@1", digest: doc.depends_on[0]!.digest }];
  assert.deepEqual(validateAllocation(doc).map((d) => [d.code, d.path]), [["CORE_TYPE_ERROR", "$.depends_on[0].ref"]]);
  assert.throws(() => formatAllocation(doc), (e: unknown) => e instanceof MdrlError && e.diagnostics[0]?.code === "CORE_TYPE_ERROR");
});

test("every vector form and keyword-like bucket names round-trip", () => {
  const doc = loadAllocationCase().policy;
  doc.body.tier2.split = [
    { name: "master_via", bps: "1000", role: "MASTER_OWNER", vector: { fn: "graph", role: "MASTER_OWNER", via_mandate: true } },
    { name: "as", bps: "1000", role: "WORK_AUTHOR", vector: { fn: "graph", role: "WORK_AUTHOR" } },
    { name: "agency", bps: "500", role: "AGENCY", vector: { fn: "contract", party: "10" } },
    { name: "members", bps: "1000", role: "PERFORMER_FEATURED", vector: { fn: "member_pct" } },
    { name: "via", bps: "1000", role: "PERFORMER_NON_FEATURED", vector: { fn: "performance_pool", mode: "FIXED" } },
    { name: "usage_w", bps: "1000", role: "PERFORMER_FEATURED", vector: { fn: "performance_pool", mode: "USAGE_WEIGHTED", featured_weight: "7000" } },
    { name: "mix", bps: "1000", role: "PERFORMER_FEATURED", vector: { fn: "performance_pool", mode: "HYBRID", fixed: "4000", usage: "6000", featured_weight: "7000" } },
    { name: "member_mode", bps: "500", role: "PERFORMER_FEATURED", vector: { fn: "performance_pool", mode: "MEMBER_PCT" } },
    { name: "mixed", bps: "1000", role: "CMO", vector: {
      fn: "mix", parts: [{ weight: "5000", of: { fn: "graph", role: "CMO" } }, { weight: "5000", of: { fn: "contract", party: "pty_x" } }],
    } },
    { name: "capped", bps: "1000", role: "MASTER_OWNER", vector: { fn: "cap", max: "5000", of: { fn: "graph", role: "MASTER_OWNER" } } },
    { name: "floored", bps: "1000", role: "PERFORMER_FEATURED", vector: { fn: "floor_guarantee", min: "300", of: { fn: "member_pct" } } },
  ];
  roundTrip(doc);
});

test("samples compile, round-trip and evaluate against the basic facts", () => {
  for (const name of ["VC-ALLOC-DEFAULT-V1", "VC-ALLOC-HYBRID-V2"]) {
    const compiled = compileAllocation(sample(name));
    assert.ok(compiled.ok, `${name}: ${JSON.stringify(compiled)}`);
    roundTrip(compiled.value);
    const c = loadAllocationCase();
    c.policy = compiled.value;
    const r = evaluate(evaluationInput(c));
    assert.ok(r.ok, `${name}: ${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    for (const ev of c.events) {
      const rights: bigint = BigInt(r.value.pool_lines.find((l) => l.event_id === ev.id && l.bucket === "rights")!.amount);
      const paid: bigint = [...r.value.lines, ...r.value.holdings].filter((l) => l.event_id === ev.id).reduce((a, l) => a + BigInt(l.amount), 0n);
      assert.equal(paid, rights, `${name} ${ev.id}`);
    }
  }
});
