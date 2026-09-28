import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFacts } from "../../src/facts/validate.ts";
import { groupClaims, isEffective } from "../../src/facts/temporal.ts";
import type { Mandate } from "../../src/facts/types.ts";
import { claimOf, loadBasic, mandateOf } from "../helpers.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const codes = (doc: unknown) => validateFacts(doc).map((d) => d.code).sort();
const mandate = (id: string, from: string, to: string, right: Mandate["right"] = "WORK"): Mandate => ({
  id, from, to, right, share: "10000", status: "VERIFIED", valid: { from: T0 }, recorded_at: T0,
});

test("basic fixture passes all invariants", () => {
  assert.deepEqual(validateFacts(loadBasic().facts), []);
});

test("isEffective applies validity, knowledge time and status", () => {
  const c = claimOf(loadBasic(), "c5");
  assert.equal(isEffective(c, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), true);
  assert.equal(isEffective(c, "2025-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), false);
  assert.equal(isEffective(c, "2026-06-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z"), false);
  assert.equal(isEffective({ ...c, superseded_at: "2026-03-01T00:00:00.000Z" }, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), false);
  assert.equal(isEffective({ ...c, status: "ASSERTED" }, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), false);
  assert.equal(isEffective({ ...c, status: "DISPUTED" }, "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), true);
});

test("groups key PERFORMED_BY by performer_role only", () => {
  const i = loadBasic();
  const g = groupClaims(i.facts.body.claims);
  assert.equal(g.get("wrk_01|WRITTEN_BY")?.sumBps, 10000);
  assert.equal(g.get("stm_v1|PERFORMED_BY|FEATURED")?.claims.length, 1);
});

test("sum mismatch", () => {
  const i = loadBasic();
  claimOf(i, "c7").share = "3000";
  assert.deepEqual(codes(i.facts), ["FACTS_SUM_MISMATCH"]);
});

test("sum mismatch inside a validity gap is detected at the boundary", () => {
  const i = loadBasic();
  claimOf(i, "c7").valid = { from: T0, to: "2026-06-01T00:00:00.000Z" };
  i.facts.body.claims.push({
    ...claimOf(i, "c7"), id: "c8", valid: { from: "2026-07-01T00:00:00.000Z" },
  });
  assert.deepEqual(codes(i.facts), ["FACTS_SUM_MISMATCH"]);
});

test("ASSERTED and superseded claims are ignored by sum check", () => {
  const i = loadBasic();
  i.facts.body.claims.push({ ...claimOf(i, "c7"), id: "c9", status: "ASSERTED" });
  i.facts.body.claims.push({ ...claimOf(i, "c7"), id: "c10", superseded_at: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(codes(i.facts), []);
});

test("mandate share over 10000bps", () => {
  const i = loadBasic();
  i.facts.body.mandates.push({ ...mandateOf(i, "m1"), id: "m9", to: "pty_agency_s", share: "1" });
  assert.deepEqual(codes(i.facts), ["FACTS_SUM_MISMATCH"]);
});

test("mandate cycle", () => {
  const i = loadBasic();
  i.facts.body.mandates.push(mandate("m3", "pty_komca", "pty_author_b"));
  assert.ok(codes(i.facts).includes("FACTS_CYCLE"));
});

test("two hops allowed, three rejected", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_pub", kind: "PUBLISHER" });
  mandateOf(i, "m1").to = "pty_pub";
  i.facts.body.mandates.push(mandate("m3", "pty_pub", "pty_komca"));
  assert.deepEqual(codes(i.facts), []);
  i.facts.body.mandates.push(mandate("m4", "pty_komca", "pty_agency_s"));
  assert.deepEqual(codes(i.facts), ["FACTS_MANDATE_DEPTH"]);
});

test("structural errors short-circuit invariants", () => {
  const i = loadBasic();
  claimOf(i, "c5").target = "pty_ghost";
  assert.deepEqual(codes(i.facts), ["FACTS_UNKNOWN_PARTY"]);
});
