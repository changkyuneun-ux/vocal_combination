import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { attestationMessage, checkAttestations, checkSod, signAttestation, verifyAttestation, type Attestation } from "../../src/core/attest.ts";
import { digestOf } from "../../src/core/digest.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const D = digestOf({ a: "1" });
const alice = keypair();
const bob = keypair();

test("sign and verify", () => {
  const att = signAttestation({ signer: "pty_alice", role: "EDITOR", over: D, privateKeyPem: alice.priv });
  assert.equal(att.alg, "Ed25519");
  assert.equal(verifyAttestation(att, alice.pub), true);
  assert.equal(verifyAttestation(att, bob.pub), false);
});

test("checkAttestations reports digest, key and signature problems", () => {
  const keys = { pty_alice: alice.pub, pty_bob: bob.pub };
  const good = signAttestation({ signer: "pty_alice", role: "EDITOR", over: D, privateKeyPem: alice.priv });
  assert.deepEqual(checkAttestations([good], D, keys), []);

  const other = signAttestation({ signer: "pty_bob", role: "ACTIVATOR", over: digestOf({ b: "2" }), privateKeyPem: bob.priv });
  assert.deepEqual(checkAttestations([other], D, keys).map((d) => d.code), ["CORE_DIGEST_MISMATCH"]);

  const forged: Attestation = { ...good, signer: "pty_bob" };
  assert.deepEqual(checkAttestations([forged], D, keys).map((d) => d.code), ["CORE_SIGNATURE_INVALID"]);

  const unknown: Attestation = { ...good, signer: "pty_carol" };
  assert.deepEqual(checkAttestations([unknown], D, keys).map((d) => d.code), ["CORE_UNKNOWN_REF"]);
});

test("built-in SoD: editor != activator, ops != settle", () => {
  const a = (signer: string, role: Attestation["role"]): Attestation => ({ signer, role, over: D, alg: "Ed25519", sig: "x" });
  assert.deepEqual(checkSod([a("p1", "EDITOR"), a("p2", "ACTIVATOR")]), []);
  assert.deepEqual(checkSod([a("p1", "EDITOR"), a("p1", "ACTIVATOR")]).map((d) => d.code), ["CORE_SOD_VIOLATION"]);
  assert.deepEqual(checkSod([a("p9", "SPACE_OPS"), a("p9", "SPACE_SETTLE")]).map((d) => d.code), ["CORE_SOD_VIOLATION"]);
});

test("signature binds signer, role and alg, not only the digest", () => {
  const keys = { pty_alice: alice.pub };
  const good = signAttestation({ signer: "pty_alice", role: "EDITOR", over: D, privateKeyPem: alice.priv });
  const promoted: Attestation = { ...good, role: "APPROVER" };
  assert.deepEqual(checkAttestations([promoted], D, keys).map((d) => d.code), ["CORE_SIGNATURE_INVALID"]);
  assert.equal(verifyAttestation({ ...good, alg: "RS256" as never }, alice.pub), false);
});

test("attestation message is JCS of the context-tagged payload", () => {
  const msg = attestationMessage({ signer: "pty_alice", role: "EDITOR", over: D, alg: "Ed25519" });
  assert.equal(
    new TextDecoder().decode(msg),
    `{"alg":"Ed25519","ctx":"mdrl-attest/1","over":"${D}","role":"EDITOR","signer":"pty_alice"}`,
  );
});

test("non-Ed25519 public keys never verify", () => {
  const good = signAttestation({ signer: "pty_alice", role: "EDITOR", over: D, privateKeyPem: alice.priv });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyAttestation(good, rsa), false);
  assert.equal(verifyAttestation(good, ec), false);
});

test("PLATFORM (platform verifier) is an attestation role and verifies like any other", () => {
  const keys = { sys_verifier: bob.pub };
  const att = signAttestation({ signer: "sys_verifier", role: "PLATFORM", over: D, privateKeyPem: bob.priv });
  assert.deepEqual(checkAttestations([att], D, keys), []);
  assert.deepEqual(checkAttestations([{ ...att, role: "SPACE_OPS" }], D, keys).map((d) => d.code), ["CORE_SIGNATURE_INVALID"]);
  assert.deepEqual(checkAttestations([{ ...att, role: "PLATFORMX" as never }], D, keys).map((d) => d.code), ["CORE_ENUM_UNKNOWN"]);
  // 내장 SoD 규칙은 바꾸지 않는다: PLATFORM은 어느 쌍에도 들지 않는다.
  assert.deepEqual(checkSod([att, { ...att, role: "SPACE_OPS" }]), []);
});
