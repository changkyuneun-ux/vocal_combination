import { test } from "node:test";
import assert from "node:assert/strict";
import * as resultModule from "../../src/facts/result.ts";
import { projectToIr } from "../../src/facts/result.ts";
import { publicFacts } from "../../src/facts/public.ts";
import { validateFactsStructure, validatePublicFacts } from "../../src/facts/validate.ts";
import { digestOf } from "../../src/core/digest.ts";
import { openCommitment, type Commitment } from "../../src/core/commit.ts";
import { claimOf, loadBasic, sortBody, type BasicInput } from "../helpers.ts";

function build(i: BasicInput = loadBasic()) {
  const r = projectToIr(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(r.ok);
  return r.value;
}

test("projection IR is deterministic and self-digested", () => {
  const a = build();
  assert.equal(a.digest, build().digest);
  assert.equal(a.digest, digestOf({ ...a, digest: undefined }));
  assert.equal(a.facts_digest, digestOf(loadBasic().facts));
  assert.deepEqual(a.vectors.WORK_AUTHOR, { pty_author_b: "3/5", pty_author_c: "2/5" });
});

test("paths are sorted by stem, role, party", () => {
  const keys = build().paths.map((p) => `${p.stem}|${p.role}|${p.party}`);
  assert.deepEqual(keys, [...keys].sort());
});

test("publicFacts commits shares and evidence; PUBLIC claims stay open", () => {
  const i = loadBasic();
  claimOf(i, "c6").visibility = "PUBLIC";
  const salt = new Uint8Array(32).fill(7);
  const { doc, digest } = publicFacts(i.facts, () => salt);
  const claims = (doc as typeof i.facts).body.claims;
  const c5 = claims.find((c) => c.id === "c5")!;
  assert.equal(openCommitment(c5.share as unknown as Commitment, "10000", salt), true);
  assert.equal(openCommitment(c5.evidence as unknown as Commitment, claimOf(i, "c5").evidence, salt), true);
  assert.equal(claims.find((c) => c.id === "c6")!.share, "6000");
  assert.equal((doc as typeof i.facts).body.mandates[0]!.share.constructor, Object);
  assert.deepEqual((doc as typeof i.facts).body.parties, i.facts.body.parties);
  assert.notEqual(digest, digestOf(i.facts));
  assert.equal(digest, digestOf(doc));
});

test("projectToIr is the single IR entry point", () => {
  assert.equal("toProjectionIr" in resultModule, false);
  const i = loadBasic();
  i.usage = { stm_ghost: "1" };
  const r = projectToIr(i.facts, i.usage, i.as_of, i.known_at);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.errors.map((e) => e.code), ["FACTS_USAGE_INVALID"]);
});

test("u_digest is over the normalized usage, so scaled or zero-padded usage yields the same IR", () => {
  const withV3 = () => {
    const i = loadBasic();
    i.facts.body.stems.push({ id: "stm_v3", of: "rcd_01", slot: "slt_v3", rights_bearing: true });
    return sortBody(i);
  };
  const usages: Record<string, string>[] = [
    { stm_inst: "9", stm_v1: "6", stm_v2: "3" },
    { stm_inst: "90000", stm_v1: "60000", stm_v2: "30000" },
    { stm_inst: "90000", stm_v1: "60000", stm_v2: "30000", stm_v3: "0" },
  ];
  const irs = usages.map((usage) => build({ ...withV3(), usage }));
  assert.equal(irs[0]!.u_digest, digestOf({ stm_inst: "1/2", stm_v1: "1/3", stm_v2: "1/6" }));
  for (const ir of irs) {
    assert.equal(ir.u_digest, irs[0]!.u_digest);
    assert.equal(ir.digest, irs[0]!.digest);
  }
});

test("public facts validate with validatePublicFacts but not as raw facts", () => {
  const { doc } = publicFacts(loadBasic().facts, () => new Uint8Array(32).fill(3));
  assert.deepEqual(validatePublicFacts(doc), []);
  assert.deepEqual(
    validateFactsStructure(doc).map((d) => [d.code, d.path]),
    [
      ["CORE_TYPE_ERROR", "$.body.claims[0].share"],
      ["CORE_TYPE_ERROR", "$.body.claims[1].share"],
      ["CORE_TYPE_ERROR", "$.body.claims[2].share"],
      ["CORE_TYPE_ERROR", "$.body.claims[3].share"],
      ["CORE_TYPE_ERROR", "$.body.claims[4].share"],
      ["CORE_TYPE_ERROR", "$.body.claims[4].evidence"],
      ["CORE_TYPE_ERROR", "$.body.claims[5].share"],
      ["CORE_TYPE_ERROR", "$.body.claims[6].share"],
      ["CORE_TYPE_ERROR", "$.body.mandates[0].share"],
      ["CORE_TYPE_ERROR", "$.body.mandates[1].share"],
    ],
  );
  const pub = doc as { body: { mandates: Record<string, unknown>[]; claims: Record<string, unknown>[] } };
  pub.body.claims[0]!.share = "10001";
  pub.body.mandates[0]!.share = { commit: "not-a-digest" };
  assert.deepEqual(validatePublicFacts(pub).map((d) => d.path), ["$.body.claims[0].share", "$.body.mandates[0].share"]);
});

test("PRIVATE party keeps id and kind public and commits its ids", () => {
  const i = loadBasic();
  const label = i.facts.body.parties.find((p) => p.id === "pty_label_x")!;
  label.visibility = "PRIVATE";
  const salt = new Uint8Array(32).fill(9);
  const paths: string[] = [];
  const { doc } = publicFacts(i.facts, (p) => (paths.push(p), salt));
  const parties = (doc as typeof i.facts).body.parties;
  const pub = parties.find((p) => p.id === "pty_label_x")!;
  assert.equal(pub.kind, "LABEL");
  assert.equal(pub.visibility, "PRIVATE");
  assert.equal(openCommitment(pub.ids as unknown as Commitment, { isni: "0000000123456789" }, salt), true);
  assert.ok(paths.includes("$.body.parties.pty_label_x.ids"));
  assert.deepEqual(parties.filter((p) => p.id !== "pty_label_x"), i.facts.body.parties.filter((p) => p.id !== "pty_label_x"));
  assert.deepEqual(validatePublicFacts(doc), []);
});
