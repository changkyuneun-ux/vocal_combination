import { describe, expect, it } from "vitest";
import { violations, type InvariantReport } from "./invariants.ts";

const ok: InvariantReport = {
  unreflectedRefunds: [],
  unreflectedRevisions: [],
  ledger: {
    entriesUnbalanced: 0, receivableMatchesSettlement: true, rightsConserved: true,
    unpostedConfirmedRuns: [], unpostedReversals: [], poolMismatches: [],
    receivable: "0", settledReceivable: "0", rightsBalance: "0", rightsPooled: "0",
  },
  stuckRuns: [],
  payouts: {
    stuck: [], resultConflicts: [], clearingMatchesOpen: true, cashMatchesPaid: true, withholdingMatches: true,
    unprocessedWebhooks: 0,
    amounts: { clearing: "0", openNet: "0", cash: "0", paidNet: "0", withholding: "0", withheld: "0" },
  },
};

describe("violations", () => {
  it("empty for OK report", () => {
    expect(violations(ok)).toEqual([]);
  });
  it("unpostedConfirmedRuns is reported separately (not a violation)", () => {
    const r = { ...ok, ledger: { ...ok.ledger, unpostedConfirmedRuns: ["run_1"] } };
    expect(violations(r)).toEqual([]);
  });
  it("lists every violating item", () => {
    const bad: InvariantReport = {
      ...ok,
      unreflectedRefunds: [{ refundEventId: "e2", originalEventId: "e1", runId: "r1", rejected: false }],
      unreflectedRevisions: [{ newEventId: "e4", oldEventId: "e3", runId: "r1", remaining: "100", rejected: true }],
      ledger: {
        ...ok.ledger, entriesUnbalanced: 2, receivableMatchesSettlement: false, rightsConserved: false,
        unpostedReversals: ["rv1"],
        poolMismatches: [{ kind: "RUN", id: "r1", expected: "10", actual: "9" }],
      },
      stuckRuns: [{ runId: "r9", status: "PENDING", since: "2026-01-01T00:00:00.000Z" }],
      payouts: {
        ...ok.payouts,
        stuck: [{ instructionId: "pi1", since: "2026-01-01T00:00:00.000Z" }],
        resultConflicts: [{ instructionId: "pi2" }],
        clearingMatchesOpen: false, cashMatchesPaid: false, withholdingMatches: false, unprocessedWebhooks: 3,
      },
    };
    const v = violations(bad);
    expect(v.map((x) => x.key)).toEqual([
      "unreflectedRefunds", "unreflectedRevisions", "entriesUnbalanced", "receivableMatchesSettlement", "rightsConserved",
      "unpostedReversals", "poolMismatches", "stuckRuns", "payoutStuck", "payoutResultConflicts",
      "clearingMatchesOpen", "cashMatchesPaid", "withholdingMatches", "unprocessedWebhooks",
    ]);
    expect(v.find((x) => x.key === "entriesUnbalanced")!.detail).toContain("2");
  });
});
