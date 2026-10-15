import { describe, expect, it } from "vitest";
import { newConsentId, revocable, won, yearPeriod } from "./logic.ts";

describe("performer app logic", () => {
  it("formats won with separators and a real minus sign", () => {
    expect(won("1234567")).toBe("1,234,567원");
    expect(won("-1040")).toBe("−1,040원");
    expect(won("0")).toBe("0원");
  });
  it("statement period is the calendar year of now (UTC)", () => {
    expect(yearPeriod("2026-10-15T09:00:00.000Z")).toEqual({ from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
  });
  it("the latest signed consent of a voice is the one to revoke", () => {
    const v = { voiceId: "vo_b", factsScopeId: "f", workId: "w", title: "t", consent: "SIGNED" as const };
    const c = (id: string, at: string, status: "SIGNED" | "REVOKED") => ({ consentId: id, factsScopeId: "f", assetId: "vo_b", status, signedAt: at, validTo: "2027-01-01T00:00:00.000Z" });
    expect(revocable(v, [c("old", "2026-01-01T00:00:00.000Z", "SIGNED"), c("new", "2026-02-01T00:00:00.000Z", "SIGNED"), c("gone", "2026-03-01T00:00:00.000Z", "REVOKED")])?.consentId).toBe("new");
    expect(revocable(v, [c("gone", "2026-03-01T00:00:00.000Z", "REVOKED")])).toBeUndefined();
  });
  it("consent ids are MDRL ids", () => {
    expect(newConsentId("vo_b", 1_700_000_000_000)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
