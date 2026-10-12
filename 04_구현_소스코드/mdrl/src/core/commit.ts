import { DIGEST_PREFIX, isDigest, sha256Hex } from "./digest.ts";
import { fail } from "./errors.ts";
import { canonicalize, isPlainObject } from "./jcs.ts";

export type Commitment = { commit: string };
export const SALT_BYTES = 32;

export function commitValue(value: unknown, salt: Uint8Array): Commitment {
  if (salt.length !== SALT_BYTES) fail("CORE_TYPE_ERROR", "$salt", `salt must be ${SALT_BYTES} bytes`);
  const body = new TextEncoder().encode(canonicalize(value));
  const buf = new Uint8Array(salt.length + body.length);
  buf.set(salt, 0);
  buf.set(body, salt.length);
  return { commit: DIGEST_PREFIX + sha256Hex(buf) };
}

export function openCommitment(c: Commitment, value: unknown, salt: Uint8Array): boolean {
  return commitValue(value, salt).commit === c.commit;
}

export function isCommitment(v: unknown): v is Commitment {
  return isPlainObject(v) && Object.keys(v).length === 1 && isDigest(v.commit);
}
