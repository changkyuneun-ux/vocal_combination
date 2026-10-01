import { describe, expect, it } from "vitest";
import { STEPS, judge, countLabel, type Facts, type Fact } from "./checklist.ts";

const ok = <T,>(value: T): Fact<T> => ({ ok: true, value });
const err = (error: string): Fact<never> => ({ ok: false, error });
const none: Facts = {
  parties: ok(0), activePolicy: ok(false), activePacks: ok(0), issues: ok(0), purchases: ok(0), refunds: ok(0),
  confirmedBatches: ok(0), reversals: ok(0), releasedHolds: ok(0), profiles: ok(0), paidInstructions: ok(0), invariantViolations: ok(0),
};
const state = (f: Facts, n: number) => judge(f)[n - 1]!.state;

describe("judge", () => {
  it("11단계, 번호 1~11 순서", () => {
    expect(STEPS).toHaveLength(11);
    expect(judge(none).map((s) => s.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
  it("아무 데이터가 없으면 1~10은 미완료, 11(점검 정상)은 위반 0이라 완료", () => {
    const r = judge(none);
    expect(r.slice(0, 10).every((s) => s.state === "todo")).toBe(true);
    expect(r[10]!.state).toBe("done");
  });
  it("각 단계 기준", () => {
    expect(state({ ...none, parties: ok(1) }, 1)).toBe("done");
    expect(state({ ...none, activePolicy: ok(true) }, 2)).toBe("done");
    expect(state({ ...none, activePacks: ok(1) }, 3)).toBe("done");
    expect(state({ ...none, issues: ok(1) }, 4)).toBe("done");
    expect(state({ ...none, confirmedBatches: ok(2) }, 6)).toBe("done");
    expect(state({ ...none, reversals: ok(1) }, 7)).toBe("done");
    expect(state({ ...none, releasedHolds: ok(1) }, 8)).toBe("done");
    expect(state({ ...none, profiles: ok(1) }, 9)).toBe("done");
    expect(state({ ...none, paidInstructions: ok(3) }, 10)).toBe("done");
    expect(state({ ...none, invariantViolations: ok(1) }, 11)).toBe("todo");
  });
  it("5단계는 구매와 환불이 모두 1건 이상이어야 한다", () => {
    expect(state({ ...none, purchases: ok(2) }, 5)).toBe("todo");
    expect(state({ ...none, refunds: ok(1) }, 5)).toBe("todo");
    expect(state({ ...none, purchases: ok(2), refunds: ok(1) }, 5)).toBe("done");
  });
  it("읽기 실패는 완료로 세지 않고 unknown과 오류를 돌려준다", () => {
    const r = judge({ ...none, parties: err("403 FORBIDDEN"), purchases: ok(3), refunds: err("boom") });
    expect(r[0]).toMatchObject({ state: "unknown", error: "403 FORBIDDEN" });
    expect(r[4]).toMatchObject({ state: "unknown", error: "boom" });
    expect(r[1]!.state).toBe("todo");
  });
  it("5단계: 한쪽이 0건으로 확정이면 다른 쪽이 실패여도 미완료, 한쪽만 양수이고 다른 쪽이 실패면 unknown", () => {
    expect(state({ ...none, purchases: ok(0), refunds: err("x") }, 5)).toBe("todo");
    expect(state({ ...none, purchases: ok(2), refunds: err("x") }, 5)).toBe("unknown");
  });
  it("점검 읽기 실패는 11단계 unknown", () => {
    expect(state({ ...none, invariantViolations: err("403") }, 11)).toBe("unknown");
  });
  it("각 단계에 화면 링크가 있다", () => {
    expect(judge(none).every((s) => s.to.startsWith("/"))).toBe(true);
  });
});

describe("countLabel", () => {
  it("다음 쪽이 있으면 n+", () => {
    expect(countLabel({ items: [1, 2], next: null })).toBe("2");
    expect(countLabel({ items: new Array(200).fill(0), next: "abc" })).toBe("200+");
  });
});
