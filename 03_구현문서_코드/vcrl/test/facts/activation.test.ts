import { test } from "node:test";
import assert from "node:assert/strict";
import { checkActivation } from "../../src/facts/activation.ts";
import { loadBasic, loadFactsCase, mandateOf, type BasicInput } from "../helpers.ts";

const input = (i: BasicInput) => ({ facts: i.facts, usage: i.usage, asOf: i.as_of, knownAt: i.known_at, declared: i.declared_claimants });

test("a clean pack can be activated", () => {
  assert.deepEqual(checkActivation(input(loadBasic())), []);
});

test("an open master dispute blocks activation with its claim id", () => {
  const d = checkActivation(input(loadFactsCase("002-disputed-master")));
  assert.deepEqual(d.map((x) => [x.code, x.path]), [["FACTS_DISPUTE_OPEN", "$.activation"]]);
  assert.match(d[0]!.message, /c5$/);
});

test("competing disputed claims are all listed", () => {
  const d = checkActivation(input(loadFactsCase("004-competing-dispute")));
  assert.equal(d[0]?.code, "FACTS_DISPUTE_OPEN");
  const ids = d[0]!.message.split(": ")[1]!.split(",");
  assert.ok(ids.length >= 2, d[0]!.message);
});

test("a disputed mandate blocks activation and breaks coverage", () => {
  const i = loadBasic();
  mandateOf(i, "m1").status = "DISPUTED";
  const d = checkActivation(input(i));
  assert.deepEqual(d.map((x) => x.code).sort(), ["FACTS_DISPUTE_OPEN", "FACTS_UNCOVERED_CLAIMANT"]);
  assert.match(d.find((x) => x.code === "FACTS_DISPUTE_OPEN")!.message, /m1$/);
});

test("projection errors are returned as-is", () => {
  const i = loadBasic();
  i.usage = { stm_ghost: "1" };
  assert.deepEqual(checkActivation(input(i)).map((x) => x.code), ["FACTS_USAGE_INVALID"]);
});
