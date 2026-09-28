import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { projectVectors } from "../src/facts/project.ts";
import { toProjectionIr } from "../src/facts/result.ts";

const root = new URL("../conformance/facts/", import.meta.url);

const cases = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

for (const name of cases) {
  test(`conformance facts/${name}`, () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`${name}/${f}`, root), "utf8"));
    const input = read("input.json");
    const expected = read("expected.json");
    const r = projectVectors(input.facts, input.usage, input.as_of, input.known_at);
    if (expected.errors !== undefined) {
      assert.equal(r.ok, false);
      assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.code).sort(), expected.errors);
      return;
    }
    assert.ok(r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const ir = toProjectionIr(r.value, input.facts, input.usage, input.as_of, input.known_at);
    assert.deepEqual(ir.vectors, expected.vectors);
    assert.deepEqual(ir.paths, expected.paths);
    assert.equal(ir.digest, expected.digest);
  });
}
