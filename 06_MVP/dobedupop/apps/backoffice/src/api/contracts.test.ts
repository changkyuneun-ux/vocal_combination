import { describe, expect, it } from "vitest";
import { toAnswers, usableTemplates, type Template } from "./contracts.ts";

const t = (templateId: string, version: number, status: string, title = templateId): Template =>
  ({ templateId, version, status, title, kind: "PUBLISHING", recordKind: "NONE", variables: [], clauses: [], signerVars: [] });

describe("contract wizard helpers", () => {
  it("picks the newest approved version of each template", () => {
    expect(usableTemplates([t("a", 1, "RETIRED"), t("a", 2, "APPROVED"), t("a", 3, "DRAFT"), t("b", 1, "APPROVED")]).map((x) => `${x.templateId}@${x.version}`))
      .toEqual(["a@2", "b@1"]);
  });
  it("drops empty answers and turns percent into basis points", () => {
    const vars = [{ name: "who", label: "누구", type: "party" as const }, { name: "share", label: "비율", type: "bps" as const }, { name: "acts", label: "행위", type: "multi" as const }];
    expect(toAnswers(vars, { who: "pty_x", share: "30", acts: [] })).toEqual({ who: "pty_x", share: 3000 });
  });
});
