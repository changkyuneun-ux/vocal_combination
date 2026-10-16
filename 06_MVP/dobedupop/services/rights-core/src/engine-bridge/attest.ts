import { signAttestation, verifyAttestation, type Attestation, type AttestationRole } from "mdrl/core";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";

/** rights-core가 쓰는 서명 역할(mdrl attestation_role의 부분집합 — PLATFORM은 플랫폼 검증자). */
export type AttestRole = Extract<AttestationRole, "EDITOR" | "WORK_APPROVER" | "ACTIVATOR" | "SPACE_OPS" | "SPACE_SETTLE" | "PLATFORM">;

/** digest에 대한 역할 서명(mdrl-attest/1)을 남긴다. 개발용 키를 쓴다. */
export async function attest(_ctx: BridgeCtx, tx: Tx, clock: Clock, a: { userId: string; role: AttestRole; digest: string }): Promise<void> {
  const key = (await tx.query("SELECT key_version, private_pem FROM dev_signing_key WHERE user_id = $1", [a.userId])).rows[0];
  if (key === undefined) throw new DomainError("NO_SIGNING_KEY", 500, `no signing key for ${a.userId}`);
  const att = signAttestation({ signer: a.userId, role: a.role, over: a.digest, privateKeyPem: key.private_pem });
  await tx.query(
    "INSERT INTO attestation (digest, signer_id, role, key_version, alg, signature, signed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [a.digest, a.userId, a.role, key.key_version, att.alg, att.sig, clock.now()],
  );
}

export async function signersOf(tx: Tx, digest: string): Promise<{ signerId: string; role: string }[]> {
  const r = await tx.query("SELECT signer_id, role FROM attestation WHERE digest = $1 ORDER BY signed_at, role", [digest]);
  return r.rows.map((x) => ({ signerId: x.signer_id, role: x.role }));
}

/** digest의 모든 서명을 공개키로 검증한다. 서명이 없거나 서명자 키가 없으면 false(닫힌 실패). */
export async function verifyAttestations(tx: Tx, digest: string): Promise<boolean> {
  const r = await tx.query(
    "SELECT a.signer_id, a.role, a.alg, a.signature, k.public_pem FROM attestation a LEFT JOIN dev_signing_key k ON k.user_id = a.signer_id WHERE a.digest = $1",
    [digest],
  );
  if (r.rows.length === 0) return false;
  return r.rows.every((x) => {
    if (x.public_pem === null) return false;
    const att: Attestation = { signer: x.signer_id, role: x.role, over: digest, alg: x.alg, sig: x.signature };
    return verifyAttestation(att, x.public_pem);
  });
}
