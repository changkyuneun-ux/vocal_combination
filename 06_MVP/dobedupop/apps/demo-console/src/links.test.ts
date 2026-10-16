import { describe, expect, it } from "vitest";
import { appUrl } from "./links.ts";

describe("demo console links", () => {
  it("opens sibling subdomains with a persona", () => {
    expect(appUrl({ protocol: "http:", hostname: "demo.dobedupop.localhost", port: "" }, "portal", "usr_bh_rights", "/contracts"))
      .toBe("http://portal.dobedupop.localhost/contracts?persona=usr_bh_rights");
    expect(appUrl({ protocol: "https:", hostname: "demo.example.com", port: "8443" }, "ops")).toBe("https://ops.example.com:8443/");
  });
});
