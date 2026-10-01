import { describe, expect, it } from "vitest";
import { actualPayout, identityValue, reconcile, partyPayableId, type StatementLike } from "./logic.ts";

const base: StatementLike = {
  opening: "0", settled: "1000000", reversed: "-100000", holdReleased: "50000", adjusted: "0",
  payoutGross: "300000", payoutFailedRestored: "0", withholding: "9900", payoutNet: "290100",
  withholdingRestored: "0", netRestored: "0", closing: "650000",
};

describe("identityValue", () => {
  it("기초 + 정산 + 역분개 + 해제 + 조정 − 지급 총액 + 실패 복원", () => {
    expect(identityValue(base)).toBe(650000n);
    expect(identityValue({ ...base, payoutGross: "300000", payoutFailedRestored: "300000", closing: "950000" })).toBe(950000n);
  });
  it("2^53을 넘는 금액도 정확하다", () => {
    expect(identityValue({ ...base, opening: "9007199254740993", settled: "1", reversed: "0", holdReleased: "0", payoutGross: "0" })).toBe(9007199254740994n);
  });
});

describe("reconcile", () => {
  it("항등식과 부채 잔액이 모두 맞으면 둘 다 ok", () => {
    const r = reconcile(base, "-650000");
    expect(r.identityOk).toBe(true);
    expect(r.balanceOk).toBe(true);
  });
  it("항등식이 어긋나면 identityOk=false, 차이를 돌려준다", () => {
    const r = reconcile({ ...base, closing: "650001" }, "-650001");
    expect(r.identityOk).toBe(false);
    expect(r.identityDiff).toBe(1n);
    expect(r.balanceOk).toBe(true);
  });
  it("기말이 부채 잔액의 부호 반전과 다르면 balanceOk=false", () => {
    const r = reconcile(base, "-650001");
    expect(r.identityOk).toBe(true);
    expect(r.balanceOk).toBe(false);
    expect(r.balanceDiff).toBe(-1n);
  });
  it("계정이 없으면(잔액을 모르면) balanceOk=null", () => {
    expect(reconcile(base, null).balanceOk).toBeNull();
  });
  it("잔액 0 계정은 -0이 아니라 0과 같다", () => {
    expect(reconcile({ ...base, opening: "0", settled: "0", reversed: "0", holdReleased: "0", payoutGross: "0", closing: "0" }, "0").balanceOk).toBe(true);
  });
});

describe("actualPayout", () => {
  it("실패 지시의 원천세·실지급을 뺀 실제 값", () => {
    expect(actualPayout({ ...base, withholdingRestored: "9900", netRestored: "290100" })).toEqual({ withholding: 0n, net: 0n });
    expect(actualPayout(base)).toEqual({ withholding: 9900n, net: 290100n });
  });
});

describe("partyPayableId", () => {
  it("PARTY_PAYABLE:<party>", () => { expect(partyPayableId("pty_a")).toBe("PARTY_PAYABLE:pty_a"); });
});
