import { describe, expect, it } from "vitest";
import { appKind } from "./apps.ts";
import { menuFor, routesFor } from "./routes.tsx";

describe("two web apps from one codebase", () => {
  it("the build decides the app; on the dev server /portal is the rights-holder portal", () => {
    expect(appKind("/settlement/batches", "portal")).toBe("portal");
    expect(appKind("/portal/registry/parties", "ops")).toBe("ops");
    expect(appKind("/portal/registry/parties", undefined)).toBe("portal");
    expect(appKind("/portal", undefined)).toBe("portal");
    expect(appKind("/portaling", undefined)).toBe("ops");
    expect(appKind("/", undefined)).toBe("ops");
  });
  it("the portal has rights screens only: no revenue, settlement, ledger, payout or dev tools", () => {
    const paths = routesFor("portal").map((r) => r.path);
    for (const p of paths) expect(p).not.toMatch(/^\/(revenue|settlement|ledger|payout|dev)/);
    expect(paths).toContain("/registry/parties");
    expect(paths).toContain("/statements");
    expect(menuFor("portal").flatMap((g) => g.items.map((i) => i.to))).not.toContain("/settlement/batches");
  });
  it("the ops back office has everything; dev tools only on the dev server", () => {
    const paths = routesFor("ops").map((r) => r.path);
    for (const p of ["/", "/revenue", "/settlement/batches", "/ledger", "/payout/runs", "/registry/parties"]) expect(paths).toContain(p);
    expect(paths.includes("/dev/psp")).toBe(import.meta.env.DEV);
  });
});
