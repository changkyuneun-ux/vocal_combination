import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaimantCoverage, deriveClaimants, routeVector } from "../../src/facts/mandate.ts";
import { HOLD, projectVectors } from "../../src/facts/project.ts";
import { ratio } from "../../src/core/ratio.ts";
import { loadBasic, mandateOf, type BasicInput } from "../helpers.ts";

const T0 = "2026-01-01T00:00:00.000Z";

function vectors(i: BasicInput) {
  const r = projectVectors(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(r.ok);
  return r.value;
}

test("full mandate routes WORK author share to CMO", () => {
  const i = loadBasic();
  const r = routeVector(i.facts, vectors(i).vectors.WORK_AUTHOR!, "WORK", i.as_of, i.known_at);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { pty_author_c: ratio(2n, 5n), pty_komca: ratio(3n, 5n) });
});

test("partial mandate keeps the remainder with the principal", () => {
  const i = loadBasic();
  mandateOf(i, "m2").share = "2000";
  const r = routeVector(i.facts, vectors(i).vectors.PERFORMER_FEATURED!, "PERFORMER", i.as_of, i.known_at);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    pty_agency_s: ratio(2n, 15n),
    pty_member_a: ratio(8n, 15n),
    pty_member_b: ratio(1n, 3n),
  });
});

test("two hops route through, a third hop is rejected", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_pub", kind: "PUBLISHER" });
  mandateOf(i, "m1").to = "pty_pub";
  const hop = { right: "WORK" as const, share: "10000", status: "VERIFIED" as const, valid: { from: T0 }, recorded_at: T0 };
  i.facts.body.mandates.push({ id: "m3", from: "pty_pub", to: "pty_komca", ...hop });
  const vec = vectors(i).vectors.WORK_AUTHOR!;
  const two = routeVector(i.facts, vec, "WORK", i.as_of, i.known_at);
  assert.ok(two.ok);
  assert.deepEqual(two.value, { pty_author_c: ratio(2n, 5n), pty_komca: ratio(3n, 5n) });

  i.facts.body.mandates.push({ id: "m4", from: "pty_komca", to: "pty_agency_s", ...hop });
  const three = routeVector(i.facts, vec, "WORK", i.as_of, i.known_at);
  assert.equal(three.ok, false);
  assert.deepEqual(three.ok ? [] : three.errors.map((e) => e.code), ["FACTS_MANDATE_DEPTH"]);
});

test("disputed mandate portion is held", () => {
  const i = loadBasic();
  mandateOf(i, "m1").status = "DISPUTED";
  const r = routeVector(i.facts, vectors(i).vectors.WORK_AUTHOR!, "WORK", i.as_of, i.known_at);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { [HOLD]: ratio(3n, 5n), pty_author_c: ratio(2n, 5n) });
});

test("derive claimants and check coverage", () => {
  const i = loadBasic();
  const derived = deriveClaimants(i.facts, vectors(i), i.as_of, i.known_at);
  assert.ok(derived.ok);
  assert.deepEqual(derived.value, i.declared_claimants);
  assert.deepEqual(checkClaimantCoverage(derived.value, i.declared_claimants), []);

  const missing = i.declared_claimants.filter((c) => c.role !== "CMO");
  assert.deepEqual(checkClaimantCoverage(derived.value, missing).map((d) => d.code), ["FACTS_CLAIMANT_DRIFT"]);

  const ghost = [...i.declared_claimants, { role: "AI_PROVIDER" as const, party: "pty_ghost" }];
  assert.deepEqual(checkClaimantCoverage(derived.value, ghost).map((d) => d.code), ["FACTS_UNCOVERED_CLAIMANT"]);
});
