import { describe, expect, it } from "vitest";
import { pageNumbers, paginate, rangeText } from "./paged.ts";

describe("쪽 나눔(3부-A, 가이드 5절)", () => {
  it("paginate cuts 10 rows per page and keeps the total", () => {
    const rows = Array.from({ length: 13 }, (_, i) => i + 1);
    expect(paginate(rows, 1)).toEqual({ rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], total: 13 });
    expect(paginate(rows, 2)).toEqual({ rows: [11, 12, 13], total: 13 });
    expect(paginate(rows, 9)).toEqual({ rows: [], total: 13 });
    expect(paginate([], 1)).toEqual({ rows: [], total: 0 });
  });
  it("range text: 1–10 / 13, last page, empty", () => {
    expect(rangeText(1, 10, 13)).toBe("1–10 / 13");
    expect(rangeText(2, 10, 13)).toBe("11–13 / 13");
    expect(rangeText(1, 10, 9)).toBe("1–9 / 9");
    expect(rangeText(1, 10, 0)).toBe("0 / 0");
  });
  it("page numbers: all when few, else first · current ±2 · last with …", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, "…", 20]);
    expect(pageNumbers(10, 20)).toEqual([1, "…", 8, 9, 10, 11, 12, "…", 20]);
    expect(pageNumbers(20, 20)).toEqual([1, "…", 18, 19, 20]);
    expect(pageNumbers(4, 20)).toEqual([1, 2, 3, 4, 5, 6, "…", 20]);
  });
});
