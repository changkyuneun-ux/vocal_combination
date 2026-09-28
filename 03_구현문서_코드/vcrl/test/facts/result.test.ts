import { test } from "node:test";
import assert from "node:assert/strict";
import { projectVectors } from "../../src/facts/project.ts";
import { toProjectionIr } from "../../src/facts/result.ts";
import { publicFacts } from "../../src/facts/public.ts";
import { digestOf } from "../../src/core/digest.ts";
import { openCommitment, type Commitment } from "../../src/core/commit.ts";
import { claimOf, loadBasic } from "../helpers.ts";

function build() {
  const i = loadBasic();
  const r = projectVectors(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(r.ok);
  return toProjectionIr(r.value, i.facts, i.usage, i.as_of, i.known_at);
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
