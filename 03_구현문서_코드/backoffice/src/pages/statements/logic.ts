/** 명세 화면의 순수 로직(단위 테스트 대상). 모든 금액은 BigInt로 계산한다. */

export type StatementLike = {
  opening: string; settled: string; reversed: string; holdReleased: string; adjusted: string;
  payoutGross: string; payoutFailedRestored: string; withholding: string; payoutNet: string;
  withholdingRestored: string; netRestored: string; closing: string;
};

export const partyPayableId = (partyId: string) => `PARTY_PAYABLE:${partyId}`;

/** closing = opening + settled + reversed + holdReleased + adjusted − payoutGross + payoutFailedRestored (rights-core statements.ts). */
export function identityValue(s: StatementLike): bigint {
  return BigInt(s.opening) + BigInt(s.settled) + BigInt(s.reversed) + BigInt(s.holdReleased) + BigInt(s.adjusted)
    - BigInt(s.payoutGross) + BigInt(s.payoutFailedRestored);
}

export type Reconciliation = {
  /** 대조 1: 항등식 계산값 = 기말. */
  identity: bigint; closing: bigint; identityOk: boolean; identityDiff: bigint;
  /** 대조 2: 기말 = −(PARTY_PAYABLE 잔액). 잔액을 모르면(계정 없음) null. */
  expectedClosing: bigint | null; balanceOk: boolean | null; balanceDiff: bigint | null;
};

/** payableBalance = GET /ledger/accounts의 그 권리자 PARTY_PAYABLE 잔액(부채라 음수), 계정이 없으면 null. */
export function reconcile(s: StatementLike, payableBalance: string | null): Reconciliation {
  const identity = identityValue(s);
  const closing = BigInt(s.closing);
  const expectedClosing = payableBalance === null ? null : -BigInt(payableBalance);
  return {
    identity, closing, identityOk: identity === closing, identityDiff: closing - identity,
    expectedClosing, balanceOk: expectedClosing === null ? null : expectedClosing === closing,
    balanceDiff: expectedClosing === null ? null : closing - expectedClosing,
  };
}

/** 권리자에게 실제로 남은 원천세·실지급 = 총계 − 실패 복원분. */
export function actualPayout(s: StatementLike): { withholding: bigint; net: bigint } {
  return { withholding: BigInt(s.withholding) - BigInt(s.withholdingRestored), net: BigInt(s.payoutNet) - BigInt(s.netRestored) };
}
