import { test } from "node:test";
import assert from "node:assert/strict";
import { checkActivation } from "../../src/facts/activation.ts";
import { loadBasic, loadFactsCase, mandateOf, sortBody, type BasicInput } from "../helpers.ts";

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

test("a disputed mandate in the middle of a chain blocks activation", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_pub", kind: "PUBLISHER" });
  mandateOf(i, "m1").to = "pty_pub";
  i.facts.body.mandates.push({
    id: "m3",
    from: "pty_pub",
    to: "pty_komca",
    right: "WORK",
    share: "10000",
    status: "DISPUTED",
    valid: { from: "2026-01-01T00:00:00.000Z" },
    recorded_at: "2026-01-01T00:00:00.000Z",
  });
  sortBody(i);
  const d = checkActivation(input(i));
  const disputes = d.filter((x) => x.code === "FACTS_DISPUTE_OPEN");
  assert.equal(disputes.length, 1);
  assert.match(disputes[0]!.message, /m3$/);
});

test("control: a verified mandate in the middle of a chain does not block activation", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_pub", kind: "PUBLISHER" });
  mandateOf(i, "m1").to = "pty_pub";
  i.facts.body.mandates.push({
    id: "m3",
    from: "pty_pub",
    to: "pty_komca",
    right: "WORK",
    share: "10000",
    status: "VERIFIED",
    valid: { from: "2026-01-01T00:00:00.000Z" },
    recorded_at: "2026-01-01T00:00:00.000Z",
  });
  sortBody(i);
  const d = checkActivation(input(i));
  assert.equal(d.filter((x) => x.code === "FACTS_DISPUTE_OPEN").length, 0);
});

test("projection errors are returned as-is", () => {
  const i = loadBasic();
  i.usage = { stm_ghost: "1" };
  assert.deepEqual(checkActivation(input(i)).map((x) => x.code), ["FACTS_USAGE_INVALID"]);
});

test("declared must be an array of {role, party} objects", () => {
  const i = loadBasic();
  const base = { facts: i.facts, usage: i.usage, asOf: i.as_of, knownAt: i.known_at };
  for (const bad of [null, {}] as const) {
    const d = checkActivation({ ...base, declared: bad as unknown as BasicInput["declared_claimants"] });
    assert.deepEqual(d.map((x) => x.code), ["CORE_TYPE_ERROR"]);
    assert.equal(d[0]!.path, "$.declared");
  }
  const d2 = checkActivation({ ...base, declared: [null] as unknown as BasicInput["declared_claimants"] });
  assert.deepEqual(d2.map((x) => x.code), ["CORE_TYPE_ERROR"]);
  assert.equal(d2[0]!.path, "$.declared[0]");
});
