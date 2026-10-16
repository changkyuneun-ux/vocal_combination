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

/** 여러 계정을 한 번의 INSERT로 만든다(이미 있으면 그대로). */
export async function ensureAccounts(tx: Tx, keys: AccountKey[]): Promise<void> {
  const uniq = new Map<string, AccountKey>();
  for (const k of keys) uniq.set(accountId(k), k);
  if (uniq.size === 0) return;
  // 계정 id 순으로 넣는다: 동시에 같은 새 계정들을 만드는 트랜잭션이 서로 다른 순서로 행을 잡아 교착하지 않도록.
  const ids = [...uniq.keys()].sort();
  const ks = ids.map((id) => uniq.get(id)!);
  await tx.query(
    `INSERT INTO ledger_account (account_id, kind, party_id, reason, bucket)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) ON CONFLICT (account_id) DO NOTHING`,
    [ids, ks.map((k) => k.kind), ks.map((k) => k.partyId ?? null), ks.map((k) => k.reason ?? null), ks.map((k) => k.bucket ?? null)],
  );
}

export async function ensureAccount(tx: Tx, k: AccountKey): Promise<string> {
  const id = accountId(k);
  await tx.query("INSERT INTO ledger_account (account_id, kind, party_id, reason, bucket) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id) DO NOTHING",
    [id, k.kind, k.partyId ?? null, k.reason ?? null, k.bucket ?? null]);
  return id;
}
