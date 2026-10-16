import { readFileSync } from "node:fs";
import { evaluate } from "../src/allocation/evaluate.ts";
import { projectToIr } from "../src/facts/result.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/print-allocation.ts <conformance/allocation/case-dir>");
const read = (p: string | URL) => JSON.parse(readFileSync(p, "utf8"));
const input = read(`${dir}/input.json`);
const facts = read(new URL(`../conformance/facts/${input.facts_case}/input.json`, import.meta.url));
const projection = projectToIr(facts.facts, facts.usage, facts.as_of, facts.known_at);
if (!projection.ok) throw new Error(projection.errors.map((e) => e.code).join(","));
const r = evaluate({ policy: input.policy, facts: facts.facts, projection: projection.value, snapshot: input.snapshot, events: input.events, runId: input.run_id });
const out = r.ok
  ? { format: r.value.format, pool_lines: r.value.pool_lines, lines: r.value.lines, holdings: r.value.holdings, result_digest: r.value.result_digest }
  : { errors: r.errors.map((e) => e.code).sort() };
console.log(JSON.stringify(out, null, 2));
