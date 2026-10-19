import { describe, expect, it } from "vitest";
import { appKind } from "./apps.ts";
import { menuFor, routesFor } from "./routes.tsx";

describe("three web apps from one codebase", () => {
  it("the build decides the app; on the dev server /portal is the portal and /partner the participant screen", () => {
    expect(appKind("/settlement/batches", "portal")).toBe("portal");
    expect(appKind("/portal/registry/parties", "ops")).toBe("ops");
    expect(appKind("/portal/registry/parties", undefined)).toBe("portal");
    expect(appKind("/portal", undefined)).toBe("portal");
    expect(appKind("/partner/links", undefined)).toBe("partner");
    expect(appKind("/", "partner")).toBe("partner");
    expect(appKind("/portaling", undefined)).toBe("ops");
    expect(appKind("/", undefined)).toBe("ops");
  });
  it("the portal has rights screens only: no revenue, settlement, ledger, payout or dev tools", () => {
    const paths = routesFor("portal").map((r) => r.path);
    for (const p of paths) expect(p).not.toMatch(/^\/(revenue|settlement|ledger|payout|dev|admin)/);
    for (const p of ["/registry/parties", "/statements", "/accounts", "/links", "/delegation"]) expect(paths).toContain(p);
    expect(menuFor("portal").flatMap((g) => g.items.map((i) => i.to))).not.toContain("/settlement/batches");
  });
  it("participants do not register rights: no registry, policy or issuance screens", () => {
    const paths = routesFor("partner").map((r) => r.path);
    for (const p of paths) expect(p).not.toMatch(/^\/(registry|policy|packs|issues|documents|contracts|admin|revenue|settlement)/);
    for (const p of ["/", "/links", "/trust/works", "/statements", "/accounts"]) expect(paths).toContain(p);
  });
  it("the ops back office has everything; onboarding splits rights tenants, participants, people and staff; dev tools only on the dev server", () => {
    const paths = routesFor("ops").map((r) => r.path);
    for (const p of ["/", "/dashboard", "/control", "/revenue", "/settlement/batches", "/ledger", "/payout/runs", "/registry/parties",
      "/admin/tenants", "/admin/participants", "/admin/people", "/admin/staff", "/admin/links", "/admin/orgs/:tenantId"]) expect(paths).toContain(p);
    expect(paths.includes("/dev/psp")).toBe(import.meta.env.DEV);
  });
});
