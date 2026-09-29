import { BPS_TOTAL, parseBps } from "../core/bps.ts";
import { describe, diag, err, ok, type Diagnostic, type Result } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { ONE, ZERO, add, div, fromBps, mul, ratio, type Ratio } from "../core/ratio.ts";
import { isInstant, type Instant } from "../core/time.ts";
import { groupClaims, groupKey, isEffective, type ClaimGroup } from "./temporal.ts";
import type { Claim, ClaimantRole, FactsDocument } from "./types.ts";
import { validateFactsStructure } from "./validate.ts";

export const HOLD = "@hold";
export type PartyVector = Record<string, Ratio>;
export type Usage = Readonly<Record<string, string>>;
export type PathRow = { stem: string; role: ClaimantRole; party: string; weight: Ratio; claims: string[] };
export type Projection = { vectors: Partial<Record<ClaimantRole, PartyVector>>; paths: PathRow[] };

const MS_RE = /^(0|[1-9]\d*)$/;
const PERFORMER_ROLE = { FEATURED: "PERFORMER_FEATURED", NON_FEATURED: "PERFORMER_NON_FEATURED" } as const;
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function projectVectors(doc: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant): Result<Projection> {
  const structural = [
    ...validateFactsStructure(doc),
    ...(isInstant(asOf) ? [] : [diag("CORE_TYPE_ERROR", "$.as_of", describe(asOf))]),
    ...(isInstant(knownAt) ? [] : [diag("CORE_TYPE_ERROR", "$.known_at", describe(knownAt))]),
  ];
  if (structural.length > 0) return err(structural);
  if (!isPlainObject(usage)) {
    return err([diag("FACTS_USAGE_INVALID", "$.usage", "must be an object of stem → ms strings")]);
  }
  const b = doc.body;
  const stems = new Map(b.stems.map((s) => [s.id, s]));
  const recordings = new Map(b.recordings.map((r) => [r.id, r]));
  const voices = new Map(b.voices.map((v) => [v.id, v]));
  const errors: Diagnostic[] = [];

  const ms = new Map<string, bigint>();
  for (const [stemId, raw] of Object.entries(usage)) {
    const stem = stems.get(stemId);
    if (!stem || !stem.rights_bearing || typeof raw !== "string" || !MS_RE.test(raw)) {
      errors.push(diag("FACTS_USAGE_INVALID", `$.usage.${stemId}`, describe(raw)));
    } else if (raw !== "0") {
      ms.set(stemId, BigInt(raw));
    }
  }
  if (errors.length === 0 && ms.size === 0) errors.push(diag("FACTS_USAGE_INVALID", "$.usage", "no stem with positive usage"));
  if (errors.length > 0) return err(errors);

  const groups = groupClaims(b.claims.filter((c) => isEffective(c, asOf, knownAt)));
  for (const g of groups.values()) {
    if (!g.disputed && g.sumBps !== BPS_TOTAL) {
      errors.push(diag("FACTS_SUM_MISMATCH", `$.body.claims[${g.key}]`, `${g.sumBps}bps at ${asOf}`));
    }
  }
  if (errors.length > 0) return err(errors);

  const group = (source: string, edge: Claim["edge"], performerRole?: string): ClaimGroup | undefined =>
    groups.get(groupKey(source, edge, performerRole));
  const share = (c: Claim): Ratio => fromBps(parseBps(c.share));
  const rows: PathRow[] = [];

  const direct = (stem: string, role: ClaimantRole, g: ClaimGroup | undefined, required: boolean, path: string) => {
    if (!g) {
      if (required) errors.push(diag("FACTS_PATH_MISSING", path));
      return;
    }
    if (g.disputed) {
      rows.push({ stem, role, party: HOLD, weight: ONE, claims: g.claims.map((c) => c.id) });
      return;
    }
    for (const c of g.claims) rows.push({ stem, role, party: c.target, weight: share(c), claims: [c.id] });
  };

  for (const stemId of ms.keys()) {
    const stem = stems.get(stemId)!;
    const rec = recordings.get(stem.of)!;
    const p = `$.stems.${stemId}`;
    direct(stemId, "MASTER_OWNER", group(rec.id, "CONTROLLED_BY"), true, `${p}->${rec.id}.CONTROLLED_BY`);
    direct(stemId, "WORK_AUTHOR", group(rec.of, "WRITTEN_BY"), true, `${p}->${rec.of}.WRITTEN_BY`);
    direct(stemId, "RECORDING_CONTRIBUTOR", group(rec.id, "CONTRIBUTED_BY"), false, `${p}->${rec.id}.CONTRIBUTED_BY`);

    for (const pr of ["FEATURED", "NON_FEATURED"] as const) {
      const g = group(stemId, "PERFORMED_BY", pr);
      if (!g) continue;
      const total = BigInt(g.sumBps);
      for (const c of g.claims) {
        const voice = voices.get(c.target)!;
        const role: ClaimantRole = voice.kind === "AI" ? "AI_PROVIDER" : PERFORMER_ROLE[pr];
        if (g.disputed) {
          const w = total === 0n ? ratio(1n, BigInt(g.claims.length)) : ratio(BigInt(parseBps(c.share)), total);
          rows.push({ stem: stemId, role, party: HOLD, weight: w, claims: [c.id] });
          continue;
        }
        const w1 = share(c);
        const og = group(voice.id, "OWNED_BY");
        if (!og) {
          errors.push(diag("FACTS_PATH_MISSING", `${p}->${voice.id}.OWNED_BY`));
          continue;
        }
        if (og.disputed) {
          rows.push({ stem: stemId, role, party: HOLD, weight: w1, claims: [c.id, ...og.claims.map((x) => x.id)] });
          continue;
        }
        for (const oc of og.claims) {
          rows.push({ stem: stemId, role, party: oc.target, weight: mul(w1, share(oc)), claims: [c.id, oc.id] });
        }
      }
    }
  }
  if (errors.length > 0) return err(errors);

  const num = new Map<ClaimantRole, Map<string, Ratio>>();
  const den = new Map<ClaimantRole, Ratio>();
  for (const r of rows) {
    const contrib = mul(ratio(ms.get(r.stem)!), r.weight);
    const m = num.get(r.role) ?? new Map<string, Ratio>();
    m.set(r.party, add(m.get(r.party) ?? ZERO, contrib));
    num.set(r.role, m);
    den.set(r.role, add(den.get(r.role) ?? ZERO, contrib));
  }
  const vectors: Partial<Record<ClaimantRole, PartyVector>> = {};
  for (const [role, m] of num) {
    const d = den.get(role)!;
    if (d.n === 0n) continue;
    const v: PartyVector = {};
    for (const party of [...m.keys()].sort(byKey)) v[party] = div(m.get(party)!, d);
    vectors[role] = v;
  }
  return ok({ vectors, paths: rows });
}
