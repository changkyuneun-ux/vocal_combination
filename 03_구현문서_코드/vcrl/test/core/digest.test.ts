import { test } from "node:test";
import assert from "node:assert/strict";
import { digestOf, isDigest } from "../../src/core/digest.ts";
import { commitValue, isCommitment, openCommitment } from "../../src/core/commit.ts";
import { VcrlError } from "../../src/core/errors.ts";

test("digest of canonical form (known vector)", () => {
  const d = digestOf({ b: [true, null], a: "1" });
  assert.equal(d, "vcrl:sha256:8770938d7bda22ac6540b6f5bf73cf4466dc9ff189805b7ccc3c6702716c7557");
  assert.equal(digestOf({ a: "1", b: [true, null] }), d);
  assert.equal(isDigest(d), true);
  assert.equal(isDigest("sha256:abc"), false);
});

test("commitment (known vector) and opening", () => {
  const salt = new Uint8Array(32);
  const c = commitValue("x", salt);
  assert.deepEqual(c, { commit: "vcrl:sha256:3c5486f0bbca8dbba1138169ee91d51cc6e06efdfd96044c2e05c43ffee668d4" });
  assert.equal(isCommitment(c), true);
  assert.equal(openCommitment(c, "x", salt), true);
  assert.equal(openCommitment(c, "y", salt), false);
  const other = new Uint8Array(32).fill(1);
  assert.equal(openCommitment(c, "x", other), false);
});

test("salt must be 32 bytes", () => {
  assert.throws(() => commitValue("x", new Uint8Array(16)), VcrlError);
});

test("isCommitment accepts only plain objects", () => {
  const { commit } = commitValue("x", new Uint8Array(32));
  assert.equal(isCommitment(Object.assign(Object.create(null), { commit })), true);
  assert.equal(isCommitment(Object.assign(Object.create({ inherited: "y" }), { commit })), false);
  assert.equal(isCommitment(Object.assign(new Map(), { commit })), false);
});
