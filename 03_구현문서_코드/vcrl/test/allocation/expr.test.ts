import { test } from "node:test";
import assert from "node:assert/strict";
import { evalVector, type ExprContext } from "../../src/allocation/expr.ts";
import type { VectorExpr } from "../../src/allocation/types.ts";
import { projectVectors } from "../../src/facts/project.ts";
import { ONE, ratio } from "../../src/core/ratio.ts";
import { VcrlError } from "../../src/core/errors.ts";
import { loadBasic } from "../helpers.ts";

const r = (n: bigint, d: bigint) => ratio(n, d);
const code = (c: string) => (e: unknown) => e instanceof VcrlError && e.diagnostics[0]?.code === c;

function ctx(): ExprContext {
  const i = loadBasic();
  const p = projectVectors(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(p.ok);
  return {
    facts: i.facts,
    parties: new Set(i.facts.body.parties.map((x) => x.id)),
    vectors: p.value.vectors,
    members: { pty_member_a: r(1n, 2n), pty_member_b: r(1n, 2n) },
    asOf: i.as_of,
    knownAt: i.known_at,
  };
}
const ev = (e: unknown, c: ExprContext = ctx()) => evalVector(e as VectorExpr, c, "$.v");

test("graph uses the projection vector, optionally routed through mandates", () => {
  assert.deepEqual(ev({ fn: "graph", role: "MASTER_OWNER" }), { pty_label_x: ONE });
  assert.deepEqual(ev({ fn: "graph", role: "WORK_AUTHOR", via_mandate: true }), { pty_author_c: r(2n, 5n), pty_komca: r(3n, 5n) });
  assert.throws(() => ev({ fn: "graph", role: "RECORDING_CONTRIBUTOR" }), code("ALLOC_EMPTY_VECTOR"));
  const c = ctx();
  c.vectors.AI_PROVIDER = { pty_member_a: ONE };
  assert.throws(() => ev({ fn: "graph", role: "AI_PROVIDER", via_mandate: true }, c), code("CORE_TYPE_ERROR"));
});

test("contract and member_pct", () => {
  assert.deepEqual(ev({ fn: "contract", party: "pty_agency_s" }), { pty_agency_s: ONE });
  assert.throws(() => ev({ fn: "contract", party: "pty_ghost" }), code("FACTS_UNKNOWN_PARTY"));
  assert.deepEqual(ev({ fn: "member_pct" }), { pty_member_a: r(1n, 2n), pty_member_b: r(1n, 2n) });
});

test("performance_pool modes", () => {
  const half = { pty_member_a: r(1n, 2n), pty_member_b: r(1n, 2n) };
  assert.deepEqual(ev({ fn: "performance_pool", mode: "MEMBER_PCT" }), half);
  assert.deepEqual(ev({ fn: "performance_pool", mode: "FIXED" }), half);
  assert.deepEqual(ev({ fn: "performance_pool", mode: "USAGE_WEIGHTED", featured_weight: "7000" }), {
    pty_member_a: r(2n, 3n), pty_member_b: r(1n, 3n),
  });
  assert.deepEqual(ev({ fn: "performance_pool", mode: "HYBRID", fixed: "4000", usage: "6000", featured_weight: "7000" }), {
    pty_member_a: r(3n, 5n), pty_member_b: r(2n, 5n),
  });
});

test("mix, cap and floor_guarantee compose", () => {
  assert.deepEqual(
    ev({ fn: "mix", parts: [{ weight: "5000", of: { fn: "graph", role: "MASTER_OWNER" } }, { weight: "5000", of: { fn: "contract", party: "pty_komca" } }] }),
    { pty_komca: r(1n, 2n), pty_label_x: r(1n, 2n) },
  );
  assert.deepEqual(ev({ fn: "cap", max: "6000", of: { fn: "performance_pool", mode: "USAGE_WEIGHTED", featured_weight: "7000" } }), {
    pty_member_a: r(3n, 5n), pty_member_b: r(2n, 5n),
  });
  assert.deepEqual(ev({ fn: "floor_guarantee", min: "1000", of: { fn: "graph", role: "MASTER_OWNER" } }), {
    pty_label_x: r(4n, 5n), pty_member_a: r(1n, 10n), pty_member_b: r(1n, 10n),
  });
});
