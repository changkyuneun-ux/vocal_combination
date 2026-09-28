import { parseBps } from "../core/bps.ts";
import type { EnumValue } from "../core/enums.ts";
import { diag, err, ok, type Diagnostic, type Result } from "../core/errors.ts";
import { ZERO, add, fromBps, mul, sub, type Ratio } from "../core/ratio.ts";
import type { Instant } from "../core/time.ts";
import { HOLD, type PartyVector, type Projection } from "./project.ts";
import { isEffective } from "./temporal.ts";
import { MAX_MANDATE_HOPS, type ClaimantRole, type FactsDocument, type Mandate } from "./types.ts";

type MandateRight = EnumValue<"mandate_right">;

export const ROLE_RIGHT: Partial<Record<ClaimantRole, MandateRight>> = {
  MASTER_OWNER: "MASTER",
  WORK_AUTHOR: "WORK",
  PERFORMER_FEATURED: "PERFORMER",
  PERFORMER_NON_FEATURED: "PERFORMER",
};

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function routeVector(
  doc: FactsDocument, vec: PartyVector, right: MandateRight, asOf: Instant, knownAt: Instant,
): Result<PartyVector> {
  const byFrom = new Map<string, Mandate[]>();
  for (const m of doc.body.mandates) {
    if (m.right !== right || !isEffective(m, asOf, knownAt)) continue;
    byFrom.set(m.from, [...(byFrom.get(m.from) ?? []), m]);
  }
  const acc = new Map<string, Ratio>();
  const errors: Diagnostic[] = [];
  const put = (party: string, w: Ratio) => acc.set(party, add(acc.get(party) ?? ZERO, w));

  const route = (party: string, w: Ratio, hops: number, chain: string): void => {
    const ms = party === HOLD ? [] : (byFrom.get(party) ?? []);
    if (ms.length === 0) {
      put(party, w);
      return;
    }
    if (hops === MAX_MANDATE_HOPS) {
      errors.push(diag("FACTS_MANDATE_DEPTH", `$.route.${right}`, chain));
      return;
    }
    let routed = ZERO;
    for (const m of ms) {
      const s = fromBps(parseBps(m.share));
      routed = add(routed, s);
      const part = mul(w, s);
      if (m.status === "DISPUTED") put(HOLD, part);
      else route(m.to, part, hops + 1, `${chain} -> ${m.to}`);
    }
    put(party, sub(w, mul(w, routed)));
  };

  for (const [party, w] of Object.entries(vec)) route(party, w, 0, party);
  if (errors.length > 0) return err(errors);
  const out: PartyVector = {};
  for (const party of [...acc.keys()].sort(byKey)) {
    const w = acc.get(party)!;
    if (w.n !== 0n) out[party] = w;
  }
  return ok(out);
}

export type ClaimantEntry = { role: ClaimantRole; party: string };
const entryKey = (e: ClaimantEntry) => `${e.role}:${e.party}`;

export function deriveClaimants(
  doc: FactsDocument, projection: Projection, asOf: Instant, knownAt: Instant,
): Result<ClaimantEntry[]> {
  const kinds = new Map(doc.body.parties.map((p) => [p.id, p.kind]));
  const found = new Map<string, ClaimantEntry>();
  const put = (role: ClaimantRole, party: string) => found.set(entryKey({ role, party }), { role, party });
  const errors: Diagnostic[] = [];

  for (const [role, vec] of Object.entries(projection.vectors) as [ClaimantRole, PartyVector][]) {
    for (const party of Object.keys(vec)) if (party !== HOLD) put(role, party);
    const right = ROLE_RIGHT[role];
    if (right === undefined) continue;
    const routed = routeVector(doc, vec, right, asOf, knownAt);
    if (!routed.ok) {
      errors.push(...routed.errors);
      continue;
    }
    for (const party of Object.keys(routed.value)) {
      const kind = kinds.get(party);
      if (kind === "CMO" || kind === "AGENCY") put(kind, party);
    }
  }
  if (errors.length > 0) return err(errors);
  return ok([...found.values()].sort((a, b) => byKey(entryKey(a), entryKey(b))));
}

export function checkClaimantCoverage(derived: readonly ClaimantEntry[], declared: readonly ClaimantEntry[]): Diagnostic[] {
  const d = new Set(derived.map(entryKey));
  const s = new Set(declared.map(entryKey));
  const out: Diagnostic[] = [];
  for (const k of [...s].sort()) if (!d.has(k)) out.push(diag("FACTS_UNCOVERED_CLAIMANT", "$.claimants", k));
  for (const k of [...d].sort()) if (!s.has(k)) out.push(diag("FACTS_CLAIMANT_DRIFT", "$.claimants", k));
  return out;
}
