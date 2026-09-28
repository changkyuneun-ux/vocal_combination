import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { validateFactsStructure } from "../../src/facts/validate.ts";
import { CLAIM_EDGE_KINDS } from "../../src/facts/types.ts";
import { ENUMS } from "../../src/core/enums.ts";
import { claimOf, loadBasic, mandateOf, sortBody, type BasicInput } from "../helpers.ts";

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
  sortBody(i);
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

test("party id __proto__ is rejected by both ajv and validateFactsStructure", () => {
  // loadBasic()은 JSON.parse로 읽으므로 id는 진짜 own property다(객체 리터럴 `{__proto__: ...}`와
  // 달리 프로토타입 접근자를 건드리지 않는다). __proto__를 party id 값으로 넣어도 여전히 거부되어야 한다.
  const i = loadBasic();
  i.facts.body.parties[0]!.id = "__proto__";
  sortBody(i);
  // 이 party를 참조하던 claim들은 더 이상 대상을 찾지 못해 FACTS_UNKNOWN_PARTY도 함께 나온다;
  // 여기서 확인할 것은 id 자체가 CORE_TYPE_ERROR로 거부된다는 점이다.
  assert.deepEqual(codes(i.facts).sort(), ["CORE_TYPE_ERROR", "FACTS_UNKNOWN_PARTY"]);
  assert.equal(validateFactsSchema(i.facts), false);
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

test("entity arrays must be strictly ascending by id (canonical order)", () => {
  const i = loadBasic();
  i.facts.body.claims.reverse();
  assert.deepEqual(
    validateFactsStructure(i.facts).map((d) => [d.code, d.path, d.message.endsWith("not sorted by id")]),
    [["CORE_TYPE_ERROR", "$.body.claims", true]],
  );
  const j = loadBasic();
  j.facts.body.parties.push({ id: "pty_zz", kind: "CMO" }, { id: "pty_aa", kind: "CMO" });
  assert.deepEqual(validateFactsStructure(j.facts).map((d) => [d.code, d.path]), [["CORE_TYPE_ERROR", "$.body.parties"]]);
  assert.deepEqual(validateFactsStructure(sortBody(j).facts), []);
});

test("validator matches the JSON Schema on element, id, required, ids, text and visibility rules", () => {
  type Row = { label: string; mutate: (i: BasicInput) => void; expect: [string, string][] };
  const rec = (x: object) => x as unknown as Record<string, unknown>;
  const rows: Row[] = [
    { label: "non-object element", mutate: (i) => (rec(i.facts.body).voices = ["vo_a", { id: "vo_b", kind: "HUMAN" }]),
      expect: [["CORE_TYPE_ERROR", "$.body.voices[0]"]] },
    { label: "id @hold as reference", mutate: (i) => (claimOf(i, "c5").target = "@hold"),
      expect: [["CORE_TYPE_ERROR", "$.body.claims[4].target"]] },
    { label: "id with | and ,", mutate: (i) => (claimOf(i, "c7").id = "c7|x,y"),
      expect: [["CORE_TYPE_ERROR", "$.body.claims[6].id"]] },
    { label: "missing id", mutate: (i) => delete rec(i.facts.body.works[0]!).id,
      expect: [
        ["CORE_TYPE_ERROR", "$.body.works[0].id"],
        ["FACTS_UNKNOWN_ENTITY", "$.body.recordings[0].of"],
        ["FACTS_UNKNOWN_ENTITY", "$.body.claims[5].source"],
        ["FACTS_UNKNOWN_ENTITY", "$.body.claims[6].source"],
      ] },
    { label: "mandate.to format", mutate: (i) => (mandateOf(i, "m1").to = "pty@komca"),
      expect: [["CORE_TYPE_ERROR", "$.body.mandates[0].to"]] },
    { label: "party.kind required", mutate: (i) => delete rec(i.facts.body.parties[0]!).kind,
      expect: [["CORE_TYPE_ERROR", "$.body.parties[0].kind"]] },
    { label: "recording.of required", mutate: (i) => delete rec(i.facts.body.recordings[0]!).of,
      expect: [["CORE_TYPE_ERROR", "$.body.recordings[0].of"]] },
    { label: "voice.kind required", mutate: (i) => delete rec(i.facts.body.voices[0]!).kind,
      expect: [["CORE_TYPE_ERROR", "$.body.voices[0].kind"]] },
    { label: "stem.of required", mutate: (i) => delete rec(i.facts.body.stems[0]!).of,
      expect: [["CORE_TYPE_ERROR", "$.body.stems[0].of"]] },
    { label: "stem.slot string", mutate: (i) => (rec(i.facts.body.stems[0]!).slot = true),
      expect: [["CORE_TYPE_ERROR", "$.body.stems[0].slot"]] },
    { label: "stem.rights_bearing required", mutate: (i) => delete rec(i.facts.body.stems[0]!).rights_bearing,
      expect: [["CORE_TYPE_ERROR", "$.body.stems[0].rights_bearing"]] },
    { label: "claim.edge required", mutate: (i) => delete rec(claimOf(i, "c5")).edge,
      expect: [["CORE_TYPE_ERROR", "$.body.claims[4].edge"]] },
    { label: "claim.status required", mutate: (i) => delete rec(claimOf(i, "c5")).status,
      expect: [["CORE_TYPE_ERROR", "$.body.claims[4].status"]] },
    { label: "mandate.right required", mutate: (i) => delete rec(mandateOf(i, "m1")).right,
      expect: [["CORE_TYPE_ERROR", "$.body.mandates[0].right"]] },
    { label: "mandate.share required", mutate: (i) => delete rec(mandateOf(i, "m1")).share,
      expect: [["CORE_TYPE_ERROR", "$.body.mandates[0].share"]] },
    { label: "ids non-string value", mutate: (i) => (rec(i.facts.body.parties[4]!).ids = { isni: true }),
      expect: [["CORE_TYPE_ERROR", "$.body.parties[4].ids"]] },
    { label: "ids not an object", mutate: (i) => (rec(i.facts.body.works[0]!).ids = "T-1"),
      expect: [["CORE_TYPE_ERROR", "$.body.works[0].ids"]] },
    { label: "recording ids array", mutate: (i) => (rec(i.facts.body.recordings[0]!).ids = ["x"]),
      expect: [["CORE_TYPE_ERROR", "$.body.recordings[0].ids"]] },
    { label: "evidence string", mutate: (i) => (rec(claimOf(i, "c5")).evidence = true),
      expect: [["CORE_TYPE_ERROR", "$.body.claims[4].evidence"]] },
    { label: "role_detail string", mutate: (i) => (rec(claimOf(i, "c6")).role_detail = { x: "y" }),
      expect: [["CORE_TYPE_ERROR", "$.body.claims[5].role_detail"]] },
    { label: "party visibility", mutate: (i) => (rec(i.facts.body.parties[0]!).visibility = "EVERYONE"),
      expect: [["CORE_ENUM_UNKNOWN", "$.body.parties[0].visibility"]] },
    { label: "claim visibility", mutate: (i) => (rec(claimOf(i, "c5")).visibility = "EVERYONE"),
      expect: [["CORE_ENUM_UNKNOWN", "$.body.claims[4].visibility"]] },
    { label: "mandate visibility", mutate: (i) => (rec(mandateOf(i, "m1")).visibility = "EVERYONE"),
      expect: [["CORE_ENUM_UNKNOWN", "$.body.mandates[0].visibility"]] },
  ];
  for (const { label, mutate, expect } of rows) {
    const i = loadBasic();
    mutate(i);
    assert.deepEqual(validateFactsStructure(i.facts).map((d) => [d.code, d.path]), expect, label);
    assert.equal(validateFactsSchema(i.facts), false, label);
  }
});
