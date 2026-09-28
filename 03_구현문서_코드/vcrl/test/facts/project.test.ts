import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLD, projectVectors } from "../../src/facts/project.ts";
import { ONE, ratio, sum } from "../../src/core/ratio.ts";
import { claimOf, loadBasic, sortBody, type BasicInput } from "../helpers.ts";

const run = (i: BasicInput) => projectVectors(i.facts, i.usage, i.as_of, i.known_at);
const errCodes = (i: BasicInput) => {
  const r = run(i);
  return r.ok ? [] : r.errors.map((e) => e.code).sort();
};

test("basic projection vectors", () => {
  const r = run(loadBasic());
  assert.ok(r.ok);
  const v = r.value.vectors;
  assert.deepEqual(v.MASTER_OWNER, { pty_label_x: ONE });
  assert.deepEqual(v.WORK_AUTHOR, { pty_author_b: ratio(3n, 5n), pty_author_c: ratio(2n, 5n) });
  assert.deepEqual(v.PERFORMER_FEATURED, { pty_member_a: ratio(2n, 3n), pty_member_b: ratio(1n, 3n) });
  assert.equal(v.PERFORMER_NON_FEATURED, undefined);
  assert.equal(r.value.paths.length, 11);
});

test("every vector sums to exactly 1", () => {
  const r = run(loadBasic());
  assert.ok(r.ok);
  for (const vec of Object.values(r.value.vectors)) assert.deepEqual(sum(Object.values(vec!)), ONE);
});

test("disputed group goes to @hold without renormalization", () => {
  const r = run(disputedMaster());
  assert.ok(r.ok);
  assert.deepEqual(r.value.vectors.MASTER_OWNER, { [HOLD]: ONE });
});

/** stm_v1 듀엣: vo_a 5000 + AI 보이스 vo_ai 5000. */
function aiDuet(): BasicInput {
  const i = loadBasic();
  const b = i.facts.body;
  b.parties.push({ id: "pty_ai", kind: "AI_PROVIDER" });
  b.voices.push({ id: "vo_ai", kind: "AI" });
  claimOf(i, "c1").share = "5000";
  b.claims.push({ ...claimOf(i, "c1"), id: "c1b", target: "vo_ai" });
  b.claims.push({ ...claimOf(i, "c3"), id: "c_ai", source: "vo_ai", target: "pty_ai" });
  return sortBody(i);
}

/** stm_v1 듀엣: vo_a 5000 + vo_c 5000, vo_c의 소유(OWNED_BY)는 분쟁 중. */
function disputedOwner(): BasicInput {
  const i = loadBasic();
  const b = i.facts.body;
  b.parties.push({ id: "pty_member_c", kind: "PERFORMER" });
  b.voices.push({ id: "vo_c", kind: "HUMAN" });
  claimOf(i, "c1").share = "5000";
  b.claims.push({ ...claimOf(i, "c1"), id: "c1b", target: "vo_c" });
  b.claims.push({ ...claimOf(i, "c3"), id: "c3c", source: "vo_c", target: "pty_member_c", status: "DISPUTED" });
  return sortBody(i);
}

function disputedMaster(): BasicInput {
  const i = loadBasic();
  claimOf(i, "c5").status = "DISPUTED";
  return i;
}

test("AI voice contributes to AI_PROVIDER; duet splits the stem", () => {
  const i = aiDuet();
  const r = run(i);
  assert.ok(r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.deepEqual(r.value.vectors.PERFORMER_FEATURED, { pty_member_a: ratio(1n, 2n), pty_member_b: ratio(1n, 2n) });
  assert.deepEqual(r.value.vectors.AI_PROVIDER, { pty_ai: ONE });
});

test("missing required path", () => {
  const i = loadBasic();
  i.facts.body.claims = i.facts.body.claims.filter((c) => c.id !== "c5");
  assert.deepEqual(errCodes(i), ["FACTS_PATH_MISSING", "FACTS_PATH_MISSING", "FACTS_PATH_MISSING"]);
});

test("as_of before validity breaks paths", () => {
  const i = loadBasic();
  i.as_of = "2025-12-01T00:00:00.000Z";
  assert.ok(errCodes(i).includes("FACTS_PATH_MISSING"));
});

test("known_at before recording breaks paths", () => {
  const i = loadBasic();
  claimOf(i, "c5").recorded_at = "2026-03-01T00:00:00.000Z";
  i.known_at = "2026-02-01T00:00:00.000Z";
  assert.ok(errCodes(i).includes("FACTS_PATH_MISSING"));
});

test("usage validation", () => {
  const invalidUsages: Record<string, string>[] = [{ stm_ghost: "1" }, { stm_v1: "1.5" }, { stm_v1: "0" }];
  for (const usage of invalidUsages) {
    const i = loadBasic();
    i.usage = usage;
    assert.deepEqual(errCodes(i), ["FACTS_USAGE_INVALID"], JSON.stringify(usage));
  }
  const i = loadBasic();
  i.facts.body.stems[0]!.rights_bearing = false;
  assert.deepEqual(errCodes(i), ["FACTS_USAGE_INVALID"]);
});

test("effective-time sum mismatch surfaces at projection", () => {
  const i = loadBasic();
  claimOf(i, "c7").share = "3000";
  assert.deepEqual(errCodes(i), ["FACTS_SUM_MISMATCH"]);
});

test("as_of and known_at must be instants", () => {
  const i = loadBasic();
  const r = projectVectors(i.facts, i.usage, "2026-06-01", "2026-06-01T00:00:00Z");
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.errors.map((e) => [e.code, e.path]), [
    ["CORE_TYPE_ERROR", "$.as_of"],
    ["CORE_TYPE_ERROR", "$.known_at"],
  ]);
});

test("disputed OWNED_BY holds only that voice's portion", () => {
  const r = run(disputedOwner());
  assert.ok(r.ok);
  // stm_v1 = 60000ms (vo_a 1/2 → a, vo_c 1/2 → @hold), stm_v2 = 30000ms (→ b); 분모 90000.
  assert.deepEqual(r.value.vectors.PERFORMER_FEATURED, {
    [HOLD]: ratio(1n, 3n),
    pty_member_a: ratio(1n, 3n),
    pty_member_b: ratio(1n, 3n),
  });
  const held = r.value.paths.filter((p) => p.party === HOLD);
  assert.deepEqual(held, [{ stem: "stm_v1", role: "PERFORMER_FEATURED", party: HOLD, weight: ratio(1n, 2n), claims: ["c1b", "c3c"] }]);
});

test("CONTRIBUTED_BY yields a RECORDING_CONTRIBUTOR vector", () => {
  const i = loadBasic();
  i.facts.body.parties.push({ id: "pty_session", kind: "SESSION" });
  i.facts.body.claims.push({ ...claimOf(i, "c5"), id: "c8", edge: "CONTRIBUTED_BY", target: "pty_session" });
  sortBody(i);
  const r = run(i);
  assert.ok(r.ok);
  assert.deepEqual(r.value.vectors.RECORDING_CONTRIBUTOR, { pty_session: ONE });
});

test("NON_FEATURED performance yields its own vector and leaves FEATURED unchanged", () => {
  const i = loadBasic();
  i.facts.body.claims.push({ ...claimOf(i, "c2"), id: "c8", target: "vo_a", performer_role: "NON_FEATURED" });
  sortBody(i);
  const r = run(i);
  assert.ok(r.ok);
  assert.deepEqual(r.value.vectors.PERFORMER_NON_FEATURED, { pty_member_a: ONE });
  assert.deepEqual(r.value.vectors.PERFORMER_FEATURED, { pty_member_a: ratio(2n, 3n), pty_member_b: ratio(1n, 3n) });
});

test("zero-usage stems are ignored when other stems have usage", () => {
  const i = loadBasic();
  i.usage = { stm_inst: "0", stm_v1: "60000", stm_v2: "30000" };
  const r = run(i);
  assert.ok(r.ok);
  assert.deepEqual(r.value.vectors.MASTER_OWNER, { pty_label_x: ONE });
  assert.deepEqual([...new Set(r.value.paths.map((p) => p.stem))].sort(), ["stm_v1", "stm_v2"]);
});

test("every vector sums to exactly 1 in AI/duet and disputed scenarios", () => {
  for (const [label, build] of [["aiDuet", aiDuet], ["disputedOwner", disputedOwner], ["disputedMaster", disputedMaster]] as const) {
    const r = run(build());
    assert.ok(r.ok, label);
    for (const [role, vec] of Object.entries(r.value.vectors)) assert.deepEqual(sum(Object.values(vec!)), ONE, `${label} ${role}`);
  }
});
