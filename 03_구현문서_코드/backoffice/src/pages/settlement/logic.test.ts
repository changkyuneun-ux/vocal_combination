import { describe, expect, it } from "vitest";
import { allocationCheck, canConfirm, defaultPeriod, holdDisplayStatus, nextBatchId, remainingHold } from "./logic.ts";

describe("defaultPeriod", () => {
  it("지난달 1일 ~ 이번 달 1일(UTC)", () => {
    expect(defaultPeriod("2026-02-02T00:00:00.000Z")).toEqual({ start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" });
  });
  it("1월이면 지난해 12월", () => {
    expect(defaultPeriod("2026-01-15T10:00:00.000Z")).toEqual({ start: "2025-12-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" });
  });
  it("달 경계 직전·직후를 UTC로 판단한다", () => {
    expect(defaultPeriod("2026-03-31T23:59:59.999Z").end).toBe("2026-03-01T00:00:00.000Z");
    expect(defaultPeriod("2026-04-01T00:00:00.000Z").end).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("nextBatchId", () => {
  it("겹치지 않는 가장 작은 번호", () => {
    expect(nextBatchId("2026-01-01T00:00:00.000Z", [])).toBe("bat_202601_1");
    expect(nextBatchId("2026-01-01T00:00:00.000Z", ["bat_202601_1", "bat_202601_3"])).toBe("bat_202601_2");
  });
});

describe("canConfirm", () => {
  const run = (status: string) => ({ runId: `r_${status}`, status });
  it("살아 있는 run이 모두 VERIFIED면 가능", () => {
    expect(canConfirm("OPEN", [run("VERIFIED"), run("VOIDED"), run("FAILED")])).toEqual({ ok: true });
  });
  it("PENDING·CALCULATED가 있으면 이유와 함께 불가", () => {
    const r = canConfirm("OPEN", [run("VERIFIED"), run("PENDING"), run("CALCULATED")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("r_PENDING");
  });
  it("run이 없거나 살아 있는 run이 없으면 불가", () => {
    expect(canConfirm("OPEN", []).ok).toBe(false);
    expect(canConfirm("OPEN", [run("FAILED")]).ok).toBe(false);
  });
  it("이미 확정된 배치는 불가", () => {
    expect(canConfirm("CONFIRMED", [run("CONFIRMED")]).ok).toBe(false);
  });
});

describe("allocationCheck", () => {
  it("합이 보류액과 같으면 ok", () => {
    expect(allocationCheck({ a: "600", b: "400" }, "1000")).toEqual({ ok: true, sum: 1000n, diff: 0n });
  });
  it("차이를 BigInt로 돌려준다(큰 수 포함)", () => {
    expect(allocationCheck({ a: "9007199254740993" }, "9007199254740992")).toMatchObject({ ok: false, diff: 1n });
  });
  it("비었거나 양의 정수 문자열이 아니면 불가", () => {
    expect(allocationCheck({}, "10").ok).toBe(false);
    expect(allocationCheck({ a: "5", b: "" }, "5").ok).toBe(false);
    expect(allocationCheck({ a: "-5", b: "10" }, "5").ok).toBe(false);
    expect(allocationCheck({ a: "1.5" }, "1").ok).toBe(false);
  });
});

describe("remainingHold", () => {
  const h = (lineSeq: number, amountKrw: string, extra: Partial<{ runId: string; eventId: string; bucket: string; reason: string }> = {}) =>
    ({ runId: "r1", eventId: "e1", bucket: "rights", reason: "FRAUD_REVIEW", lineSeq, amountKrw, ...extra });
  it("역분개 행이 없으면 원 금액", () => {
    expect(remainingHold(h(1, "700000"), [h(1, "700000")])).toBe(700000n);
  });
  it("같은 키의 line_seq>1 음수 행을 더한다", () => {
    expect(remainingHold(h(1, "700000"), [h(1, "700000"), h(2, "-200000"), h(3, "-100000")])).toBe(400000n);
  });
  it("다른 run·이벤트·버킷·사유의 행은 무시한다", () => {
    const all = [h(1, "700000"), h(2, "-1", { runId: "r2" }), h(2, "-1", { eventId: "e2" }), h(2, "-1", { bucket: "x" }), h(2, "-1", { reason: "RIGHTS_DISPUTE" })];
    expect(remainingHold(all[0]!, all)).toBe(700000n);
  });
});

describe("holdDisplayStatus", () => {
  it("해제 기록이 있으면 RELEASED, 없으면 보류 행의 status 그대로", () => {
    expect(holdDisplayStatus({ status: "HELD", release: { releaseId: 1, releasedBy: "usr_settle", releasedAt: "2026-03-02T00:00:00.000Z" } })).toBe("RELEASED");
    expect(holdDisplayStatus({ status: "HELD", release: null })).toBe("HELD");
  });
});
