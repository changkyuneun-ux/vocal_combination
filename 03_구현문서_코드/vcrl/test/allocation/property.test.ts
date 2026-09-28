import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/allocation/evaluate.ts";
import { projectToIr } from "../../src/facts/result.ts";
import { evaluationInput, loadAllocationCase, loadBasic } from "../helpers.ts";
import { int, rng, shuffle } from "../prop.ts";
import type { PoolLine, RevenueEvent } from "../../src/allocation/types.ts";

test("property: every event conserves money and results are reproducible", () => {
  const r = rng(1234);
  for (let round = 0; round < 40; round++) {
    const c = loadAllocationCase();
    const n = int(r, 1, 6);
    const events: RevenueEvent[] = Array.from({ length: n }, (_, k) => ({
      id: `ev_${String(k).padStart(3, "0")}`,
      type: "PRIMARY" as const,
      amount: String(int(r, 1, 50_000_000)),
      currency: "KRW",
      integrity: int(r, 0, 9) === 0 ? ("FLAGGED" as const) : ("CLEAR" as const),
    }));
    c.events = events;
    const first = evaluate(evaluationInput(c));
    assert.ok(first.ok);
    for (const ev of c.events) {
      const pool: PoolLine[] = first.value.pool_lines.filter((l) => l.event_id === ev.id);
      assert.equal(pool.reduce((a, l) => a + BigInt(l.amount), 0n), BigInt(ev.amount));
      const rights = BigInt(pool.find((l) => l.bucket === "rights")!.amount);
      const paid: bigint = [...first.value.lines, ...first.value.holdings]
        .filter((l) => l.event_id === ev.id)
        .reduce((a, l) => a + BigInt(l.amount), 0n);
      assert.equal(paid, rights);
    }
    const second = evaluate(evaluationInput(c));
    assert.ok(second.ok);
    assert.equal(second.value.result_digest, first.value.result_digest);
  }
});

test("property: projection digest ignores usage scale and key order", () => {
  const r = rng(99);
  const i = loadBasic();
  const base = projectToIr(i.facts, i.usage, i.as_of, i.known_at);
  assert.ok(base.ok);
  for (let round = 0; round < 20; round++) {
    const k = BigInt(int(r, 1, 1000));
    const scaled = Object.fromEntries(shuffle(r, Object.entries(i.usage)).map(([s, v]) => [s, (BigInt(v) * k).toString()]));
    const p = projectToIr(i.facts, scaled, i.as_of, i.known_at);
    assert.ok(p.ok);
    assert.equal(p.value.digest, base.value.digest);
  }
});
