import { describe, expect, it } from "vitest";
import { nextEventId } from "./eventId.ts";

describe("nextEventId", () => {
  it("비어 있으면 _1", () => {
    expect(nextEventId("2026", "p", [])).toBe("ev_2026_p_1");
  });
  it("이미 있는 번호는 건너뛰고 가장 작은 빈 번호", () => {
    expect(nextEventId("2026", "p", ["ev_2026_p_1", "ev_2026_p_2", "ev_2026_p_4"])).toBe("ev_2026_p_3");
  });
  it("유형이 다르면 겹치지 않는다", () => {
    expect(nextEventId("2026", "r", ["ev_2026_p_1"])).toBe("ev_2026_r_1");
  });
  it("시각이 다르면 겹치지 않는다", () => {
    expect(nextEventId("2027", "c", ["ev_2026_c_1"])).toBe("ev_2027_c_1");
  });
});
