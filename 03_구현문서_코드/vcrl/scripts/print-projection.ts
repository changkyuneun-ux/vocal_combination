import { readFileSync } from "node:fs";
import { projectVectors } from "../src/facts/project.ts";
import { toProjectionIr } from "../src/facts/result.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/print-projection.ts <input.json>");
const input = JSON.parse(readFileSync(file, "utf8"));
const r = projectVectors(input.facts, input.usage, input.as_of, input.known_at);
const out = r.ok
  ? toProjectionIr(r.value, input.facts, input.usage, input.as_of, input.known_at)
  : { errors: r.errors.map((e) => e.code).sort() };
console.log(JSON.stringify(out, null, 2));
