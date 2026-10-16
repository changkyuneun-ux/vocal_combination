import { describe, expect, it } from "vitest";
import { defaultForm, formDiff, pct, toBps } from "./policyForm.ts";

describe("policy form helpers", () => {
  it("percent text and bps", () => {
    expect(pct(4500)).toBe("45%");
    expect(pct(1250)).toBe("12.5%");
    expect(pct(undefined)).toBe("없음");
    expect(toBps("12.5")).toBe(1250);
  });
  it("lists only what changed, in plain words", () => {
    const a = defaultForm("pak_x");
    const b = structuredClone(a);
    b.performer.capBps = 6000;
    b.events = ["PRIMARY", "TRAFFIC"];
    expect(formDiff(a, b)).toEqual([
      { label: "대상 매출", before: "구매", after: "구매·감상" },
      { label: "실연 1인 상한", before: "50%", after: "60%" },
    ]);
    expect(formDiff(a, a)).toEqual([]);
  });
});
