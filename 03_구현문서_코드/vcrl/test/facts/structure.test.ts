import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { validateFactsStructure } from "../../src/facts/validate.ts";
import { CLAIM_EDGE_KINDS } from "../../src/facts/types.ts";
import { ENUMS } from "../../src/core/enums.ts";
import { claimOf, loadBasic } from "../helpers.ts";

const codes = (doc: unknown) => validateFactsStructure(doc).map((d) => d.code);

/** ajv 컴파일은 비용이 있으므로 파일 전체에서 하나의 검증기를 재사용한다. */
function compileFactsAjv() {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
  const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../../spec/schema/${f}`, import.meta.url), "utf8"));
  ajv.addSchema(load("envelope.schema.json"));
  return ajv.compile(load("facts.ir.schema.json"));
}
const validateFactsSchema = compileFactsAjv();

test("claim edges are registered edge types", () => {
  for (const e of Object.keys(CLAIM_EDGE_KINDS)) assert.ok((ENUMS.edge_type as readonly string[]).includes(e), e);
});

test("basic fixture is structurally valid", () => {
  assert.deepEqual(validateFactsStructure(loadBasic().facts), []);
});

test("wrong module is rejected", () => {
  const i = loadBasic();
  assert.deepEqual(codes({ ...i.facts, module: "allocation" }), ["CORE_TYPE_ERROR"]);
});

test("duplicate id", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_komca", kind: "CMO" });
  assert.deepEqual(codes(i.facts), ["FACTS_DUPLICATE_ID"]);
});

test("unknown party and unknown entity", () => {
  const i = loadBasic();
  claimOf(i, "c5").target = "pty_ghost";
  i.facts.body.stems[0]!.of = "rcd_ghost";
  assert.deepEqual(codes(i.facts).sort(), ["FACTS_UNKNOWN_ENTITY", "FACTS_UNKNOWN_PARTY"]);
});

test("edge kind mismatch", () => {
  const i = loadBasic();
  claimOf(i, "c5").source = "wrk_01";
  assert.deepEqual(codes(i.facts), ["FACTS_EDGE_KIND"]);
});

test("performer_role required on PERFORMED_BY and forbidden elsewhere", () => {
  const i = loadBasic();
  delete claimOf(i, "c1").performer_role;
  claimOf(i, "c3").performer_role = "FEATURED";
  assert.deepEqual(codes(i.facts).sort(), ["CORE_ENUM_UNKNOWN", "CORE_TYPE_ERROR"]);
});

test("share, status, interval, recorded_at formats", () => {
  const i = loadBasic();
  claimOf(i, "c5").share = "10001";
  claimOf(i, "c6").status = "PENDING" as never;
  claimOf(i, "c7").valid = { from: "2026-01-01" };
  claimOf(i, "c4").superseded_at = "2025-01-01T00:00:00.000Z";
  assert.deepEqual(codes(i.facts).sort(), ["CORE_ENUM_UNKNOWN", "CORE_TYPE_ERROR", "CORE_TYPE_ERROR", "CORE_TYPE_ERROR"]);
});

test("facts JSON Schema agrees with validator", () => {
  const i = loadBasic();
  assert.equal(validateFactsSchema(i.facts), true, JSON.stringify(validateFactsSchema.errors));
  claimOf(i, "c5").share = 10000 as never;
  assert.equal(validateFactsSchema(i.facts), false);
  assert.ok(codes(i.facts).length > 0);
});

test("unknown keys are rejected like the JSON Schema does", () => {
  const i = loadBasic();
  (claimOf(i, "c1") as unknown as Record<string, unknown>).extra = "x";
  (claimOf(i, "c1").valid as unknown as Record<string, unknown>).extra = "x";
  (i.facts.body as unknown as Record<string, unknown>).extra = "x";

  assert.deepEqual(
    validateFactsStructure(i.facts).map((d) => [d.code, d.path]),
    [
      ["CORE_TYPE_ERROR", "$.body.claims[0].extra"],
      ["CORE_TYPE_ERROR", "$.body.claims[0].valid.extra"],
      ["CORE_TYPE_ERROR", "$.body.extra"],
    ],
  );
  assert.equal(validateFactsSchema(i.facts), false);
});

test("unknown keys are rejected on every entity shape", () => {
  const cases: { label: string; path: string; mutate: (i: ReturnType<typeof loadBasic>) => void }[] = [
    { label: "party", path: "$.body.parties[0]", mutate: (i) => ((i.facts.body.parties[0] as unknown as Record<string, unknown>).extra = "x") },
    { label: "work", path: "$.body.works[0]", mutate: (i) => ((i.facts.body.works[0] as unknown as Record<string, unknown>).extra = "x") },
    { label: "recording", path: "$.body.recordings[0]", mutate: (i) => ((i.facts.body.recordings[0] as unknown as Record<string, unknown>).extra = "x") },
    { label: "voice", path: "$.body.voices[0]", mutate: (i) => ((i.facts.body.voices[0] as unknown as Record<string, unknown>).extra = "x") },
    { label: "stem", path: "$.body.stems[0]", mutate: (i) => ((i.facts.body.stems[0] as unknown as Record<string, unknown>).extra = "x") },
    { label: "mandate", path: "$.body.mandates[0]", mutate: (i) => ((i.facts.body.mandates[0] as unknown as Record<string, unknown>).extra = "x") },
    { label: "mandate.valid", path: "$.body.mandates[0].valid", mutate: (i) => ((i.facts.body.mandates[0]!.valid as unknown as Record<string, unknown>).extra = "x") },
  ];

  for (const { label, path, mutate } of cases) {
    const i = loadBasic();
    mutate(i);
    assert.deepEqual(
      validateFactsStructure(i.facts).map((d) => [d.code, d.path]),
      [["CORE_TYPE_ERROR", `${path}.extra`]],
      label,
    );
    assert.equal(validateFactsSchema(i.facts), false, label);
  }
});
