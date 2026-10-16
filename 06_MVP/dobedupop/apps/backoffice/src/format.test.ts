import { describe, expect, it } from "vitest";
import { formatInstant, formatKrw, safeKrw, shortDigest, sumKrw } from "./format.ts";

describe("format", () => {
  it("formatKrw", () => {
    expect(formatKrw("0")).toBe("0원");
    expect(formatKrw("1234567")).toBe("1,234,567원");
    expect(formatKrw("-1234")).toBe("−1,234원");
    expect(formatKrw("12345678901234567890")).toBe("12,345,678,901,234,567,890원");
    expect(formatKrw("-12345678901234567890")).toBe("−12,345,678,901,234,567,890원");
  });
  it("safeKrw는 던지지 않는다", () => {
    expect(safeKrw("1234")).toBe("1,234원");
    expect(safeKrw("")).toBe("");
    expect(safeKrw("1.5")).toBe("1.5");
  });
  it("shortDigest", () => {
    expect(shortDigest("mdrl:sha256:abcdef0123456789ffff")).toBe("abcdef012345");
    expect(shortDigest("abcdef0123456789")).toBe("abcdef012345");
  });
  it("formatInstant shows a readable UTC minute", () => {
    expect(formatInstant("2026-03-01T10:00:05.123Z")).toBe("2026-03-01 10:00 UTC");
    expect(formatInstant("not a time")).toBe("not a time");
  });
  it("sumKrw", () => {
    expect(sumKrw(["1", "-3", "10"])).toBe("8");
    expect(sumKrw([])).toBe("0");
    expect(sumKrw(["9007199254740993", "1"])).toBe("9007199254740994");
  });
});
