import { BPS_TOTAL } from "../core/bps.ts";
import { diag, type Diagnostic } from "../core/errors.ts";
import { contains } from "../core/time.ts";
import { boundaries, groupClaims, isCurrent } from "./temporal.ts";
import { MAX_MANDATE_HOPS, type FactsBody } from "./types.ts";

export function checkClaimSums(body: FactsBody): Diagnostic[] {
  const current = body.claims.filter(isCurrent);
  const reported = new Set<string>();
  const out: Diagnostic[] = [];
  for (const t of boundaries(current)) {
    for (const g of groupClaims(current.filter((c) => contains(c.valid, t))).values()) {
      if (g.sumBps !== BPS_TOTAL && !reported.has(g.key)) {
        reported.add(g.key);
        out.push(diag("FACTS_SUM_MISMATCH", `$.body.claims[${g.key}]`, `${g.sumBps}bps at ${t}`));
      }
    }
  }
  return out;
}

export function checkMandates(body: FactsBody): Diagnostic[] {
  const current = body.mandates.filter(isCurrent);
  const out: Diagnostic[] = [];
  const reported = new Set<string>();
  const report = (key: string, d: Diagnostic) => {
    if (!reported.has(key)) {
      reported.add(key);
      out.push(d);
    }
  };
  for (const t of boundaries(current)) {
    const active = current.filter((m) => contains(m.valid, t));
    const sums = new Map<string, number>();
    const next = new Map<string, string[]>();
    for (const m of active) {
      const sk = `${m.from}|${m.right}`;
      sums.set(sk, (sums.get(sk) ?? 0) + Number(m.share));
      const nk = `${m.right}|${m.from}`;
      next.set(nk, [...(next.get(nk) ?? []), m.to]);
    }
    for (const [k, s] of sums) {
      if (s > BPS_TOTAL) report(`sum|${k}`, diag("FACTS_SUM_MISMATCH", `$.body.mandates[${k}]`, `${s}bps > ${BPS_TOTAL} at ${t}`));
    }
    for (const m of active) {
      const walk = (party: string, hops: number, chain: string[]): void => {
        for (const to of next.get(`${m.right}|${party}`) ?? []) {
          const path = [...chain, to].join(" -> ");
          if (chain.includes(to)) {
            report(`cycle|${m.right}|${m.from}`, diag("FACTS_CYCLE", `$.body.mandates[${m.id}]`, path));
          } else if (hops + 1 > MAX_MANDATE_HOPS) {
            report(`depth|${m.right}|${m.from}`, diag("FACTS_MANDATE_DEPTH", `$.body.mandates[${m.id}]`, path));
          } else {
            walk(to, hops + 1, [...chain, to]);
          }
        }
      };
      walk(m.from, 0, [m.from]);
    }
  }
  return out;
}
