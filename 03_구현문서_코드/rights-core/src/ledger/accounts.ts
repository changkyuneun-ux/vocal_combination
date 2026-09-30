import type { Tx } from "../platform/db.ts";

export type AccountKind = "RECEIVABLE" | "POOL_PLATFORM" | "POOL_OPS" | "POOL_FAN" | "POOL_OTHER" | "PARTY_PAYABLE" | "HOLD" | "WITHHOLDING_TAX" | "PSP_CLEARING" | "CASH";
export type AccountKey = { kind: AccountKind; partyId?: string; reason?: string; bucket?: string };

export function accountId(k: AccountKey): string {
  if (k.kind === "PARTY_PAYABLE") return `PARTY_PAYABLE:${k.partyId}`;
  if (k.kind === "HOLD") return `HOLD:${k.reason}`;
  if (k.kind === "POOL_OTHER") return `POOL_OTHER:${k.bucket}`;
  return k.kind;
}

/** tier1 비권리 버킷 → 풀 계정(통합 설계 11.2-3). 권리 풀 버킷은 호출하지 않는다. */
export function poolAccountFor(bucket: string): AccountKey {
  if (bucket === "platform") return { kind: "POOL_PLATFORM" };
  if (bucket === "ops") return { kind: "POOL_OPS" };
  if (bucket === "fan") return { kind: "POOL_FAN" };
  return { kind: "POOL_OTHER", bucket };
}

export async function ensureAccount(tx: Tx, k: AccountKey): Promise<string> {
  const id = accountId(k);
  await tx.query("INSERT INTO ledger_account (account_id, kind, party_id, reason, bucket) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id) DO NOTHING",
    [id, k.kind, k.partyId ?? null, k.reason ?? null, k.bucket ?? null]);
  return id;
}
