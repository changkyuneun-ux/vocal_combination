import { describe, expect, it } from "vitest";
import { toEvidence } from "./documents.ts";

describe("toEvidence", () => {
  it("turns a picked option into an evidence reference", () => {
    expect(toEvidence("doc_ab@2")).toEqual([{ documentId: "doc_ab", version: 2 }]);
    expect(toEvidence("doc.with@sign@3")).toEqual([{ documentId: "doc.with@sign", version: 3 }]);
  });
  it("no pick means no evidence", () => {
    expect(toEvidence("")).toBeUndefined();
    expect(toEvidence(undefined)).toBeUndefined();
  });
});
