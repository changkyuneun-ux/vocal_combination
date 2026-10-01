import { describe, expect, it } from "vitest";
import { failureReason, hasOpen, isCooling, nextPayoutRunId, openInstructions, type AuditLike } from "./logic.ts";

describe("isCooling", () => {
  it("coolingUntil이 가상 시계보다 뒤면 냉각 중", () => {
    expect(isCooling("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isCooling("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(isCooling(null, "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(isCooling("2026-01-02T00:00:00.000Z", undefined)).toBe(false);
  });
});

describe("nextPayoutRunId", () => {
  it("pr_<YYYYMMDD>_<n>, 겹치지 않는 가장 작은 n(밑줄은 id에 못 쓰므로 하이픈)", () => {
    expect(nextPayoutRunId("2026-02-05T10:00:00.000Z", [])).toBe("pr-20260205-1");
    expect(nextPayoutRunId("2026-02-05T10:00:00.000Z", ["pr-20260205-1", "pr-20260205-3"])).toBe("pr-20260205-2");
  });
  it("백엔드 id 규칙 [A-Za-z0-9.-]{1,100}에 맞는다", () => {
    expect(nextPayoutRunId("2026-02-05T10:00:00.000Z", [])).toMatch(/^[A-Za-z0-9.-]{1,100}$/);
  });
});

describe("hasOpen / openInstructions", () => {
  const counts = (o: Record<string, number>) => ({ PENDING: 0, SUBMITTED: 0, PAID: 0, FAILED: 0, CARRIED: 0, HELD: 0, ...o });
  it("PENDING·SUBMITTED가 하나라도 있으면 열림", () => {
    expect(hasOpen(counts({ PAID: 3 }))).toBe(false);
    expect(hasOpen(counts({ SUBMITTED: 1 }))).toBe(true);
    expect(hasOpen(counts({ PENDING: 2 }))).toBe(true);
    expect(hasOpen(undefined)).toBe(false);
  });
  it("열린 지시만 고른다", () => {
    expect(openInstructions([{ status: "PAID" }, { status: "PENDING" }, { status: "SUBMITTED" }, { status: "HELD" }]).map((i) => i.status)).toEqual(["PENDING", "SUBMITTED"]);
  });
});

describe("failureReason", () => {
  const a = (action: string, after: unknown): AuditLike => ({ action, after });
  it("PAYOUT_FAILED 감사의 reason", () => {
    expect(failureReason([a("PAYOUT_SUBMITTED", {}), a("PAYOUT_FAILED", { reason: "ACCOUNT_CHANGED" })])).toBe("ACCOUNT_CHANGED");
  });
  it("reason이 없으면 null, 감사가 없어도 null", () => {
    expect(failureReason([a("PAYOUT_FAILED", { reason: null })])).toBeNull();
    expect(failureReason([])).toBeNull();
  });
});
