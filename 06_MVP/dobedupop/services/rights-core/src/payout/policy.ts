import type { Tx } from "../platform/db.ts";

export type TaxType = "DOMESTIC_INDIVIDUAL" | "DOMESTIC_CORP" | "FOREIGN" | "EXEMPT";
export const TAX_TYPES: readonly TaxType[] = ["DOMESTIC_INDIVIDUAL", "DOMESTIC_CORP", "FOREIGN", "EXEMPT"];
export type HoldReason = "NO_PROFILE" | "NO_ACCOUNT" | "KYC_REQUIRED" | "ACCOUNT_COOLING" | "ACCOUNT_SOD" | "INITIAL_HOLD" | "TENANT_SUSPENDED";
export type PayoutPolicy = { minPayoutKrw: bigint; initialHoldDays: number; accountCoolingHours: number; taxBps: Record<TaxType, number> };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 원천징수(통합 설계 11.2-6) = ⌊총액 × bps / 10000 / 10⌋ × 10(10원 미만 절사). 총액 0 이하는 0. bps는 0~10000 정수. */
export function computeWithholding(gross: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError(`tax bps must be an integer in 0..10000, got ${bps}`);
  if (gross <= 0n) return 0n;
  return ((gross * BigInt(bps)) / 100_000n) * 10n;
}

/** 기본 지급 정책을 읽는다. 세율 표에 없는 세금 유형이나 잘못된 값이 있으면 지급을 멈춘다(설정 오류). */
export async function loadPayoutPolicy(tx: Tx): Promise<PayoutPolicy> {
  const r = (await tx.query("SELECT min_payout_krw::text AS m, initial_hold_days AS d, account_cooling_hours AS c, tax_bps FROM payout_policy WHERE policy_id = 'default'")).rows[0];
  if (r === undefined) throw new Error("payout_policy 'default' is missing");
  const taxBps = {} as Record<TaxType, number>;
  for (const t of TAX_TYPES) {
    const v = (r.tax_bps as Record<string, unknown>)[t];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`payout_policy tax_bps.${t} must be an integer in 0..10000`);
    taxBps[t] = v;
  }
  return { minPayoutKrw: BigInt(r.m), initialHoldDays: r.d as number, accountCoolingHours: r.c as number, taxBps };
}

export type ProfileView = {
  taxType: TaxType; payoutAccountRef: string | null; kycVerified: boolean; firstPayableAt: string;
  /** 계좌 토큰을 마지막으로 바꾼 시각·사용자(토큰이 있으면 늘 있다). */
  accountChangedAt: string | null; accountChangedBy: string | null;
};

/**
 * 지급 판정(통합 설계 11.2-6): 보류 사유가 있으면 HELD, 총액이 최소 지급액 미만(0 이하 포함)이면 CARRIED, 아니면 PENDING.
 * 보류 사유 순서: NO_PROFILE → NO_ACCOUNT → KYC_REQUIRED → ACCOUNT_COOLING(계좌 토큰 변경 뒤 account_cooling_hours가 asOf까지 지나지 않음 —
 * asOf보다 뒤의 변경 포함) → ACCOUNT_SOD(지급 실행자 = 그 권리자의 계좌 토큰을 마지막으로 바꾼 사용자) → INITIAL_HOLD.
 * 프로필 상태(존재·계좌·KYC·세금 유형)는 asOf 시점이 아니라 실행 시점의 현재 값으로 판정한다(프로필은 이력을 두지 않는다).
 * 초기 보류와 냉각 기간만 asOf와 비교한다.
 */
export function decide(policy: PayoutPolicy, asOf: string, gross: bigint, prof: ProfileView | undefined, runBy: string):
  { status: "HELD"; reason: HoldReason } | { status: "CARRIED" } | { status: "PENDING"; withholding: bigint } {
  if (prof === undefined) return { status: "HELD", reason: "NO_PROFILE" };
  if (prof.payoutAccountRef === null || prof.payoutAccountRef === "") return { status: "HELD", reason: "NO_ACCOUNT" };
  if (!prof.kycVerified) return { status: "HELD", reason: "KYC_REQUIRED" };
  // 토큰이 있으면 변경 기록이 있다(DB CHECK). 없으면(있어서는 안 됨) 보수적으로 냉각 중으로 본다.
  if (prof.accountChangedAt === null || Date.parse(asOf) < Date.parse(prof.accountChangedAt) + policy.accountCoolingHours * HOUR_MS) {
    return { status: "HELD", reason: "ACCOUNT_COOLING" };
  }
  if (prof.accountChangedBy === runBy) return { status: "HELD", reason: "ACCOUNT_SOD" };
  if (Date.parse(asOf) < Date.parse(prof.firstPayableAt) + policy.initialHoldDays * DAY_MS) return { status: "HELD", reason: "INITIAL_HOLD" };
  if (gross < policy.minPayoutKrw) return { status: "CARRIED" };
  return { status: "PENDING", withholding: computeWithholding(gross, policy.taxBps[prof.taxType]) };
}
