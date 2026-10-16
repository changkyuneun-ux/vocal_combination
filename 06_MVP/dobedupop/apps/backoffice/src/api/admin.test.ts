import { describe, expect, it } from "vitest";
import { inviteUrl, loginState, rolesFor, type AccountRow } from "./admin.ts";

const base: AccountRow = { userId: "u", displayName: "u", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_bighit", tenantName: "빅히트", partyId: null, disabled: false, hasPassword: true, totpEnabled: false, identityVerified: false, lastLoginAt: null };

describe("onboarding helpers", () => {
  it("builds invite links to the portal for tenant accounts and to ops for platform accounts", () => {
    const sub = { protocol: "http:", hostname: "ops.dobedupop.localhost", port: "", origin: "http://ops.dobedupop.localhost" };
    expect(inviteUrl(sub, "T1", "tnt_bighit")).toBe("http://portal.dobedupop.localhost/?invite=T1");
    expect(inviteUrl(sub, "T1", "tnt_platform")).toBe("http://ops.dobedupop.localhost/?invite=T1");
    const dev = { protocol: "http:", hostname: "localhost", port: "5173", origin: "http://localhost:5173" };
    expect(inviteUrl(dev, "T 2", "tnt_bighit")).toBe("http://localhost:5173/portal/?invite=T%202");
  });
  it("offers roles by tenant kind", () => {
    expect(rolesFor("tnt_platform_default")).toEqual(["PERFORMER"]);
    expect(rolesFor("tnt_bighit")).not.toContain("SPACE_OPS");
    expect(rolesFor("tnt_platform")).toContain("SPACE_SETTLE");
  });
  it("describes login readiness", () => {
    expect(loginState({ ...base, hasPassword: false }).text).toBe("초대 수락 대기");
    expect(loginState({ ...base, tenantId: "tnt_platform" }).text).toBe("인증 앱 등록 전");
    expect(loginState({ ...base, disabled: true }).tone).toBe("bad");
    expect(loginState({ ...base, roles: ["PERFORMER"], tenantId: "tnt_platform_default", identityVerified: true }).text).toBe("본인 인증 완료");
  });
});
