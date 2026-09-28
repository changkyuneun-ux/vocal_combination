import { digestOf } from "../core/digest.ts";
import { formatRatio } from "../core/ratio.ts";
import type { Instant } from "../core/time.ts";
import type { Projection, Usage } from "./project.ts";
import type { FactsDocument } from "./types.ts";

export type ProjectionIr = {
  facts_digest: string;
  as_of: Instant;
  known_at: Instant;
  u_digest: string;
  vectors: Record<string, Record<string, string>>;
  paths: { stem: string; role: string; party: string; weight: string; claims: string[] }[];
  digest: string;
};

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function toProjectionIr(p: Projection, facts: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant): ProjectionIr {
  const vectors: Record<string, Record<string, string>> = {};
  for (const role of Object.keys(p.vectors).sort(byKey)) {
    const vec = p.vectors[role as keyof typeof p.vectors]!;
    vectors[role] = Object.fromEntries(Object.keys(vec).sort(byKey).map((party) => [party, formatRatio(vec[party]!)]));
  }
  const paths = p.paths
    .map((r) => ({ stem: r.stem, role: r.role, party: r.party, weight: formatRatio(r.weight), claims: [...r.claims] }))
    .sort((a, b) =>
      byKey(a.stem, b.stem) || byKey(a.role, b.role) || byKey(a.party, b.party) || byKey(a.claims.join(","), b.claims.join(",")));
  const body = { facts_digest: digestOf(facts), as_of: asOf, known_at: knownAt, u_digest: digestOf(usage), vectors, paths };
  return { ...body, digest: digestOf(body) };
}
