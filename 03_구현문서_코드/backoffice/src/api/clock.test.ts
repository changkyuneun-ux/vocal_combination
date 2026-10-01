import { describe, expect, it } from "vitest";
import { CLOCK_KEY, editedOr } from "./clock.ts";
import { nowStamp, toLocalInput } from "./revenue.ts";

describe("editedOr", () => {
  it("편집하지 않았으면 시계에서 파생한 값을 따른다", () => {
    const at = (now: string, edit: string | null) => editedOr(edit, toLocalInput(now));
    expect(at("2026-01-01T00:00:00.000Z", null)).toBe("2026-01-01T00:00:00");
    expect(at("2026-01-31T00:00:00.000Z", null)).toBe("2026-01-31T00:00:00");
  });
  it("편집했으면 시계가 움직여도 사용자 값을 유지한다", () => {
    expect(editedOr("2026-01-05T00:00", toLocalInput("2026-01-31T00:00:00.000Z"))).toBe("2026-01-05T00:00");
  });
  it("빈 문자열도 사용자가 지운 값으로 존중한다", () => {
    expect(editedOr("", "x")).toBe("");
  });
  it("eventId 스탬프도 시계를 따른다", () => {
    expect(nowStamp("2026-01-31T00:00:00.000Z")).not.toBe(nowStamp("2026-01-01T00:00:00.000Z"));
  });
  it("시계 키는 사용자와 무관하고 ['clock'] 접두를 가진다", () => {
    expect(CLOCK_KEY[0]).toBe("clock");
    expect(CLOCK_KEY).not.toContain("usr_editor");
  });
});
