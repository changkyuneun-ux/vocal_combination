import { createHash } from "node:crypto";
import { canonicalize } from "./jcs.ts";

export const DIGEST_PREFIX = "mdrl:sha256:";
const DIGEST_RE = /^mdrl:sha256:[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestOf(value: unknown): string {
  return DIGEST_PREFIX + sha256Hex(new TextEncoder().encode(canonicalize(value)));
}

export function isDigest(v: unknown): v is string {
  return typeof v === "string" && DIGEST_RE.test(v);
}
