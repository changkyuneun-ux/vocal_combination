import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { isEnumValue, type EnumValue } from "./enums.ts";
import { diag, type Diagnostic } from "./errors.ts";

export type AttestationRole = EnumValue<"attestation_role">;
export type Attestation = { signer: string; role: AttestationRole; over: string; alg: "Ed25519"; sig: string };
export type KeyRegistry = Readonly<Record<string, string>>;

/** 서명 대상 메시지는 digest 문자열의 UTF-8 바이트다. */
export function signAttestation(p: { signer: string; role: AttestationRole; over: string; privateKeyPem: string }): Attestation {
  const sig = sign(null, Buffer.from(p.over, "utf8"), createPrivateKey(p.privateKeyPem)).toString("base64url");
  return { signer: p.signer, role: p.role, over: p.over, alg: "Ed25519", sig };
}

export function verifyAttestation(att: Attestation, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(att.over, "utf8"), createPublicKey(publicKeyPem), Buffer.from(att.sig, "base64url"));
  } catch {
    return false;
  }
}

export function checkAttestations(atts: readonly Attestation[], expectedDigest: string, keys: KeyRegistry): Diagnostic[] {
  const out: Diagnostic[] = [];
  atts.forEach((att, i) => {
    const p = `$.attestations[${i}]`;
    if (!isEnumValue("attestation_role", att.role)) {
      out.push(diag("CORE_ENUM_UNKNOWN", `${p}.role`, String(att.role)));
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
