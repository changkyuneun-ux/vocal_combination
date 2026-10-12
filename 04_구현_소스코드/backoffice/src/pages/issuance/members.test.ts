import { describe, expect, it } from "vitest";
import { autoMemberBps, sumBps } from "./members.ts";

describe("autoMemberBps", () => {
  it("슬롯 수에 비례하고 합이 10000이다", () => {
    expect(autoMemberBps(["a", "b", "c", "a"])).toEqual({ a: 5000, b: 2500, c: 2500 });
  });
  it("나머지는 party_id 오름차순 첫 멤버에 준다", () => {
    const r = autoMemberBps(["pty_c", "pty_b", "pty_a"]);
    expect(r).toEqual({ pty_a: 3334, pty_b: 3333, pty_c: 3333 });
    expect(sumBps(r)).toBe(10000);
  });
  it("한 멤버가 전부 부르면 10000", () => {
    expect(autoMemberBps(["x", "x", "x", "x"])).toEqual({ x: 10000 });
  });
  it("권리 대상이 아닌(null) 슬롯은 세지 않는다", () => {
    expect(autoMemberBps(["a", null, "b", null])).toEqual({ a: 5000, b: 5000 });
  });
  it("멤버가 없으면 빈 객체", () => {
    expect(autoMemberBps([null])).toEqual({});
  });
});
