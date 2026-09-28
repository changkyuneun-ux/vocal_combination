import { parseBps } from "../core/bps.ts";
import type { EnumValue } from "../core/enums.ts";
import { diag, err, ok, type Diagnostic, type Result } from "../core/errors.ts";
import { ONE, ZERO, add, cmp, fromBps, mul, sub, sum, type Ratio } from "../core/ratio.ts";
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
    const shares = ms.map((m) => fromBps(parseBps(m.share)));
    const routed = sum(shares);
    if (cmp(routed, ONE) > 0) {
      errors.push(diag("FACTS_SUM_MISMATCH", `$.route.${right}`, party));
      return;
    }
    ms.forEach((m, k) => {
      const part = mul(w, shares[k]!);
      if (m.status === "DISPUTED") put(HOLD, part);
      else route(m.to, part, hops + 1, `${chain} -> ${m.to}`);
    });
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

  /** `@hold`와 가중치 0인 party는 청구권자가 아니다. */
  const claimantsOf = (vec: PartyVector, roleFor: (party: string) => ClaimantRole) => {
    for (const [party, w] of Object.entries(vec)) if (party !== HOLD && w.n !== 0n) put(roleFor(party), party);
  };

  for (const [role, vec] of Object.entries(projection.vectors) as [ClaimantRole, PartyVector][]) {
    claimantsOf(vec, () => role);
    const right = ROLE_RIGHT[role];
    if (right === undefined) continue;
    const routed = routeVector(doc, vec, right, asOf, knownAt);
    if (!routed.ok) {
      errors.push(...routed.errors);
      continue;
    }
    // 위임 수령인: CMO·AGENCY는 그 역할, 그 외(예: PUBLISHER)는 원래 벡터의 역할로 청구한다.
    claimantsOf(routed.value, (party) => {
      const kind = kinds.get(party);
      return kind === "CMO" || kind === "AGENCY" ? kind : role;
    });
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
