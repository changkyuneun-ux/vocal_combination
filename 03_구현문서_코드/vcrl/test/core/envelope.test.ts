import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { checkDependencies, validateEnvelope, type Dependency, type IrDocument } from "../../src/core/envelope.ts";
import { digestOf } from "../../src/core/digest.ts";
import type { EnumValue } from "../../src/core/enums.ts";

function doc(module: EnumValue<"module">, id: string, deps: Dependency[] = []): IrDocument {
  return { vcrl: "1.0", module, id, version: "1", depends_on: deps, visibility_default: "PARTIES", body: {} };
}

test("valid envelope has no diagnostics", () => {
  assert.deepEqual(validateEnvelope(doc("facts", "f")), []);
});

test("envelope errors are reported", () => {
  const bad = { ...doc("facts", "f"), vcrl: "2.0", version: 1 };
  const codes = validateEnvelope(bad).map((d) => d.code);
  assert.ok(codes.includes("CORE_NUMBER_IN_IR"));
  assert.ok(codes.includes("CORE_TYPE_ERROR"));
  assert.deepEqual(validateEnvelope({ ...doc("facts", "f"), module: "policy" }).map((d) => d.code), ["CORE_ENUM_UNKNOWN"]);
  assert.deepEqual(validateEnvelope([]).map((d) => d.code), ["CORE_TYPE_ERROR"]);
});

test("dependencies: ok, digest mismatch, direction, unknown", () => {
  const facts = doc("facts", "f");
  const alloc = doc("allocation", "a", [{ ref: "vc:facts/f@1", digest: digestOf(facts) }]);
  assert.deepEqual(checkDependencies([facts, alloc]), []);

  const stale = doc("allocation", "a", [{ ref: "vc:facts/f@1", digest: digestOf({ other: "x" }) }]);
  assert.deepEqual(checkDependencies([facts, stale]).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);

  const back = doc("facts", "g", [{ ref: "vc:allocation/a@1", digest: digestOf(alloc) }]);
  assert.deepEqual(checkDependencies([alloc, back, facts]).map((d) => d.code), ["CORE_DEP_DIRECTION"]);

  const missing = doc("allocation", "a", [{ ref: "vc:facts/zzz@1", digest: digestOf(facts) }]);
  assert.deepEqual(checkDependencies([missing]).map((d) => d.code), ["CORE_UNKNOWN_REF"]);
});

test("envelope JSON Schema agrees with validator", () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
  const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
  const schema = JSON.parse(readFileSync(new URL("../../spec/schema/envelope.schema.json", import.meta.url), "utf8"));
  const validate = ajv.compile(schema);
  assert.equal(validate(doc("facts", "f")), true);
  assert.equal(validate({ ...doc("facts", "f"), version: 1 }), false);
});
