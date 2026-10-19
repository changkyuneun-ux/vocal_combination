import { describe, expect, it } from "vitest";
import { inviteUrl, loginState, rolesFor, type AccountRow } from "./admin.ts";

const base: AccountRow = { userId: "u", displayName: "u", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_bighit", tenantName: "빅히트", partyId: null, disabled: false, hasPassword: true, totpEnabled: false, identityVerified: false, lastLoginAt: null };

describe("onboarding helpers", () => {
  it("builds invite links to the app of the organization: portal, participant screen, or ops", () => {
    const sub = { protocol: "http:", hostname: "ops.dobedupop.localhost", port: "", origin: "http://ops.dobedupop.localhost" };
    expect(inviteUrl(sub, "T1", "RIGHTS")).toBe("http://portal.dobedupop.localhost/?invite=T1");
    expect(inviteUrl(sub, "T1", "PARTICIPANT")).toBe("http://partner.dobedupop.localhost/?invite=T1");
    expect(inviteUrl(sub, "T1", "PLATFORM")).toBe("http://ops.dobedupop.localhost/?invite=T1");
    const fromPortal = { protocol: "http:", hostname: "portal.dobedupop.localhost", port: "", origin: "http://portal.dobedupop.localhost" };
    expect(inviteUrl(fromPortal, "T3", "RIGHTS")).toBe("http://portal.dobedupop.localhost/?invite=T3");
    const dev = { protocol: "http:", hostname: "localhost", port: "5173", origin: "http://localhost:5173" };
    expect(inviteUrl(dev, "T 2", "RIGHTS")).toBe("http://localhost:5173/portal/?invite=T%202");
    expect(inviteUrl(dev, "T", "PARTICIPANT")).toBe("http://localhost:5173/partner/?invite=T");
  });
  it("offers roles by organization class; operators get no rights-decision roles", () => {
    expect(rolesFor("INDIVIDUAL")).toEqual(["PERFORMER"]);
    expect(rolesFor("RIGHTS")).not.toContain("SPACE_OPS");
    expect(rolesFor("PLATFORM")).toContain("ONBOARDING");
    expect(rolesFor("PLATFORM")).not.toContain("EDITOR");
    expect(rolesFor("PARTICIPANT", "CMO")).toEqual(["TENANT_ADMIN", "TRUST_OFFICER"]);
    expect(rolesFor("PARTICIPANT", "B2B_PARTNER")).toEqual(["TENANT_ADMIN", "PARTNER_INTEGRATION"]);
  });
  it("describes login readiness", () => {
    expect(loginState({ ...base, hasPassword: false }).text).toBe("초대 수락 대기");
    expect(loginState({ ...base, tenantId: "tnt_platform" }).text).toBe("인증 앱 등록 전");
    expect(loginState({ ...base, disabled: true }).tone).toBe("bad");
    expect(loginState({ ...base, roles: ["PERFORMER"], tenantId: "tnt_platform_default", identityVerified: true }).text).toBe("본인 인증 완료");
  });
});
