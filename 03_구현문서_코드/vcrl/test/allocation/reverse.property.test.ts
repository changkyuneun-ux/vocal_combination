import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../../src/allocation/evaluate.ts";
import { reverse, type ReversalResult } from "../../src/allocation/reverse.ts";
import { evaluationInput, loadAllocationCase } from "../helpers.ts";
import { int, rng } from "../prop.ts";

/** 원 금액 total을 1~maxParts개의 양의 정수로 나눈다. */
function parts(r: () => number, total: bigint, maxParts: number): bigint[] {
  const n = Math.min(int(r, 1, maxParts), Number(total));
  const cuts = new Set<bigint>();
  while (cuts.size < n - 1) cuts.add(BigInt(int(r, 1, Number(total) - 1)));
  const bounds = [0n, ...[...cuts].sort((a, b) => (a < b ? -1 : 1)), total];
  return bounds.slice(1).map((b, i) => b - bounds[i]!);
}

for (const name of ["001-basic", "002-disputed-master", "003-fraud-hold"]) {
  test(`property: random refund sequences on ${name} keep every invariant and end at zero`, () => {
    const r = rng(20260929 + name.length);
    for (let trial = 0; trial < 60; trial++) {
      const c = loadAllocationCase(name);
      const amount = String(int(r, 1, 5_000_000));
      const events = c.events.map((e, i) => (i === 0 ? { ...e, amount } : e));
      const ev = evaluate(evaluationInput({ ...c, events }));
      assert.ok(ev.ok, JSON.stringify(ev));
      const original = ev.value;
      const eventId = events[0]!.id;
      const total = original.pool_lines.filter((p) => p.event_id === eventId).reduce((a, p) => a + BigInt(p.amount), 0n);
      const remaining = new Map<string, bigint>();
      const key = (o: { bucket: string; party?: string; reason?: string }, kind: string) => `${kind}/${o.bucket}/${o.party ?? o.reason ?? ""}`;
      for (const p of original.pool_lines.filter((x) => x.event_id === eventId)) remaining.set(key(p, "pool"), BigInt(p.amount));
      for (const l of original.lines.filter((x) => x.event_id === eventId)) remaining.set(key(l, "line"), BigInt(l.amount));
      for (const h of original.holdings.filter((x) => x.event_id === eventId)) remaining.set(key(h, "hold"), BigInt(h.amount));
      const priors: ReversalResult[] = [];
      for (const [k, a] of parts(r, total, 5).entries()) {
        const rv = reverse({ original, policy: c.policy, eventId, refund: { id: `rf_${k}`, reason: "REFUND", amount: a.toString() }, priors, runId: `run_${k}` });
        assert.ok(rv.ok, JSON.stringify(rv));
        const v = rv.value;
        const rightsInc = -BigInt(v.pool_lines.find((p) => p.bucket === c.policy.body.tier1.rights)?.amount ?? "0");
        const childInc = [...v.lines, ...v.holdings].reduce((acc, x) => acc - BigInt(x.amount), 0n);
        assert.equal(rightsInc, childInc, "rights pool increment = lines + holdings increment");
        assert.equal(v.pool_lines.reduce((acc, p) => acc - BigInt(p.amount), 0n), a, "pool increments sum to the refund");
        for (const [kind, rows] of [["pool", v.pool_lines], ["line", v.lines], ["hold", v.holdings]] as const) {
          for (const x of rows as readonly { bucket: string; party?: string; reason?: string; amount: string }[]) {
            const inc = -BigInt(x.amount);
            assert.ok(inc > 0n, "only positive increments are emitted");
            const kk = key(x, kind);
            const left = remaining.get(kk)! - inc;
            assert.ok(left >= 0n, `never exceeds remaining: ${kk}`);
            remaining.set(kk, left);
          }
        }
        priors.push(v);
      }
      assert.ok([...remaining.values()].every((x) => x === 0n), "full refund nets every item to zero");
    }
  });
}
