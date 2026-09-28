import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInterval, contains, isInstant } from "../../src/core/time.ts";
import { formatRef, parseRef } from "../../src/core/ref.ts";
import { VcrlError } from "../../src/core/errors.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-07-01T00:00:00.000Z";

test("isInstant requires canonical UTC millisecond format", () => {
  assert.ok(isInstant(T0));
  for (const bad of ["2026-01-01", "2026-01-01T00:00:00Z", "2026-02-30T00:00:00.000Z", "2026-01-01T00:00:00.000+09:00", 5]) {
    assert.equal(isInstant(bad), false, String(bad));
  }
});

test("contains is half-open [from, to)", () => {
  assert.equal(contains({ from: T0, to: T1 }, T0), true);
  assert.equal(contains({ from: T0, to: T1 }, T1), false);
  assert.equal(contains({ from: T0 }, "2099-01-01T00:00:00.000Z"), true);
  assert.equal(contains({ from: T1 }, T0), false);
});

test("checkInterval", () => {
  assert.deepEqual(checkInterval({ from: T0 }, "$.v"), []);
  assert.deepEqual(checkInterval({ from: T1, to: T0 }, "$.v").map((d) => d.code), ["CORE_TYPE_ERROR"]);
  assert.deepEqual(checkInterval({ from: "2026-01-01" }, "$.v").map((d) => d.path), ["$.v.from"]);
  assert.deepEqual(checkInterval("x", "$.v").map((d) => d.code), ["CORE_TYPE_ERROR"]);
});

test("refs", () => {
  const r = parseRef("vc:facts/nova-debut-01@3");
  assert.deepEqual(r, { kind: "facts", id: "nova-debut-01", version: 3 });
  assert.equal(formatRef(r), "vc:facts/nova-debut-01@3");
  assert.throws(() => parseRef("vc:facts/x"), VcrlError);
  assert.throws(
    () => parseRef("vc:unknown/x@1"),
    (e: unknown) => e instanceof VcrlError && e.diagnostics[0]?.code === "CORE_ENUM_UNKNOWN",
  );
});
