import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { isEnumValue, type EnumValue } from "./enums.ts";
import { describe, diag, type Diagnostic } from "./errors.ts";
import { canonicalize } from "./jcs.ts";

export type AttestationRole = EnumValue<"attestation_role">;
export type Attestation = { signer: string; role: AttestationRole; over: string; alg: "Ed25519"; sig: string };
export type KeyRegistry = Readonly<Record<string, string>>;

export const ATTEST_CONTEXT = "vcrl-attest/1";

/** 서명 대상 메시지: JCS({ ctx, signer, role, over, alg })의 UTF-8 바이트. 서명자·역할·알고리즘을 digest와 함께 묶는다. */
export function attestationMessage(att: Omit<Attestation, "sig">): Uint8Array {
  return new TextEncoder().encode(
    canonicalize({ ctx: ATTEST_CONTEXT, signer: att.signer, role: att.role, over: att.over, alg: att.alg }),
  );
}

export function signAttestation(p: { signer: string; role: AttestationRole; over: string; privateKeyPem: string }): Attestation {
  const unsigned = { signer: p.signer, role: p.role, over: p.over, alg: "Ed25519" as const };
  const sig = sign(null, attestationMessage(unsigned), createPrivateKey(p.privateKeyPem)).toString("base64url");
  return { ...unsigned, sig };
}

export function verifyAttestation(att: Attestation, publicKeyPem: string): boolean {
  try {
    if (att.alg !== "Ed25519") return false;
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, attestationMessage(att), key, Buffer.from(att.sig, "base64url"));
  } catch {
    return false;
  }
}

export function checkAttestations(atts: readonly Attestation[], expectedDigest: string, keys: KeyRegistry): Diagnostic[] {
  const out: Diagnostic[] = [];
  atts.forEach((att, i) => {
    const p = `$.attestations[${i}]`;
    if (!isEnumValue("attestation_role", att.role)) {
      out.push(diag("CORE_ENUM_UNKNOWN", `${p}.role`, describe(att.role)));
      return;
    }
    if (att.over !== expectedDigest) {
      out.push(diag("CORE_DIGEST_MISMATCH", `${p}.over`, `${att.over} != ${expectedDigest}`));
      return;
    }
    const key = keys[att.signer];
    if (key === undefined) {
      out.push(diag("CORE_UNKNOWN_REF", `${p}.signer`, att.signer));
      return;
    }
    if (!verifyAttestation(att, key)) out.push(diag("CORE_SIGNATURE_INVALID", p, att.signer));
  });
  return out;
}

/** approval 모듈(서브프로젝트 3) 이전까지 코어가 강제하는 직무 분리 규칙. */
export const BUILTIN_SOD: readonly (readonly [AttestationRole, AttestationRole])[] = [
  ["EDITOR", "ACTIVATOR"],
  ["SPACE_OPS", "SPACE_SETTLE"],
];

export function checkSod(atts: readonly Attestation[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [a, b] of BUILTIN_SOD) {
    const holders = new Set(atts.filter((x) => x.role === a).map((x) => x.signer));
    for (const x of atts) {
      if (x.role === b && holders.has(x.signer)) out.push(diag("CORE_SOD_VIOLATION", "$.attestations", `${x.signer} is both ${a} and ${b}`));
    }
  }
  return out;
}
