import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestionFrom } from "../../src/engine-bridge/fraud-release.ts";

const line = (event_id: string, party: string, amount: string) => ({ event_id, party, role: "MASTER_OWNER" as const, bucket: "master", line_seq: "1", amount });

test("suggestionFrom sums lines per party for the event and scales to the remaining hold", () => {
  const r = { lines: [line("ev_1", "pty_b", "400"), line("ev_1", "pty_a", "200"), line("ev_1", "pty_a", "100"), line("ev_2", "pty_c", "999")], holdings: [] };
  assert.deepEqual(suggestionFrom(r, "ev_1", 700n), { pty_a: "300", pty_b: "400" });
  assert.deepEqual(suggestionFrom(r, "ev_1", 10n), { pty_a: "4", pty_b: "6" });   // 4.28 / 5.71 → 남는 1은 나머지가 큰 pty_b
  assert.deepEqual(suggestionFrom(r, "ev_1", 0n), {});
});

test("suggestionFrom refuses when the CLEAR re-evaluation holds part of the event for RIGHTS_DISPUTE", () => {
  const r = {
    lines: [line("ev_1", "pty_a", "600")],
    holdings: [{ event_id: "ev_1", bucket: "work", reason: "RIGHTS_DISPUTE" as const, amount: "100" }],
  };
  assert.throws(() => suggestionFrom(r, "ev_1", 700n), { code: "SUGGESTION_HAS_DISPUTE", status: 409 });
  const other = { ...r, holdings: [{ ...r.holdings[0]!, event_id: "ev_2" }] };
  assert.deepEqual(suggestionFrom(other, "ev_1", 600n), { pty_a: "600" });
});
