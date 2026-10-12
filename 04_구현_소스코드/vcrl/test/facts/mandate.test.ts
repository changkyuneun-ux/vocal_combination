import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaimantCoverage, deriveClaimants, routeVector } from "../../src/facts/mandate.ts";
import { HOLD, projectVectors } from "../../src/facts/project.ts";
import { ratio } from "../../src/core/ratio.ts";
import { claimOf, loadBasic, mandateOf, sortBody, type BasicInput } from "../helpers.ts";

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
  sortBody(i);
  const vec = vectors(i).vectors.WORK_AUTHOR!;
  const two = routeVector(i.facts, vec, "WORK", i.as_of, i.known_at);
  assert.ok(two.ok);
  assert.deepEqual(two.value, { pty_author_c: ratio(2n, 5n), pty_komca: ratio(3n, 5n) });

  i.facts.body.mandates.push({ id: "m4", from: "pty_komca", to: "pty_agency_s", ...hop });
  sortBody(i);
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

test("routeVector rejects mandates of one party summing over 10000bps", () => {
  const i = loadBasic();
  i.facts.body.mandates.push({ ...mandateOf(i, "m1"), id: "m1b", to: "pty_agency_s" });
  sortBody(i);
  const r = routeVector(i.facts, vectors(i).vectors.WORK_AUTHOR!, "WORK", i.as_of, i.known_at);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.errors.map((e) => [e.code, e.path, e.message.endsWith("pty_author_b")]), [
    ["FACTS_SUM_MISMATCH", "$.route.WORK", true],
  ]);
});

test("routed recipients are claimants under the originating role unless CMO or AGENCY", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_pub", kind: "PUBLISHER" });
  i.facts.body.mandates.push({ ...mandateOf(i, "m1"), id: "m3", from: "pty_author_c", to: "pty_pub" });
  sortBody(i);
  const derived = deriveClaimants(i.facts, vectors(i), i.as_of, i.known_at);
  assert.ok(derived.ok);
  assert.ok(derived.value.some((e) => e.role === "WORK_AUTHOR" && e.party === "pty_pub"), JSON.stringify(derived.value));
  assert.ok(!derived.value.some((e) => e.party === HOLD));
});

test("zero-weight parties are not claimants", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_author_d", kind: "AUTHOR" });
  i.facts.body.claims.push({ ...claimOf(i, "c7"), id: "c8", target: "pty_author_d", share: "0" });
  sortBody(i);
  const v = vectors(i);
  assert.deepEqual(v.vectors.WORK_AUTHOR!.pty_author_d, ratio(0n));
  const derived = deriveClaimants(i.facts, v, i.as_of, i.known_at);
  assert.ok(derived.ok);
  assert.deepEqual(derived.value, i.declared_claimants);
});
