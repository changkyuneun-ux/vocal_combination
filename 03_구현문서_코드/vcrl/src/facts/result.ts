import { digestOf } from "../core/digest.ts";
import { err, ok, type Result } from "../core/errors.ts";
import { formatRatio, ratio } from "../core/ratio.ts";
import type { Instant } from "../core/time.ts";
import { projectVectors, type Projection, type Usage } from "./project.ts";
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

/** 사용량을 비율 `"n/d"`로 정규화한다(0 제외). 같은 비율의 사용량은 같은 u_digest를 갖는다. projectVectors가 검증한 입력만 받는다. */
function normalizedUsage(usage: Usage): Record<string, string> {
  const ms = Object.entries(usage).filter(([, v]) => v !== "0").map(([stem, v]) => [stem, BigInt(v)] as const);
  const total = ms.reduce((acc, [, v]) => acc + v, 0n);
  return Object.fromEntries(ms.map(([stem, v]) => [stem, formatRatio(ratio(v, total))]));
}

/** 투영 IR의 유일한 생성 경로: 같은 입력으로 투영하고 IR을 만든다(입력과 결과의 불일치 방지). */
export function projectToIr(doc: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant): Result<ProjectionIr> {
  const r = projectVectors(doc, usage, asOf, knownAt);
  return r.ok ? ok(toProjectionIr(r.value, doc, usage, asOf, knownAt)) : err(r.errors);
}

function toProjectionIr(p: Projection, facts: FactsDocument, usage: Usage, asOf: Instant, knownAt: Instant): ProjectionIr {
  const vectors: Record<string, Record<string, string>> = {};
  for (const role of Object.keys(p.vectors).sort(byKey)) {
    const vec = p.vectors[role as keyof typeof p.vectors]!;
    vectors[role] = Object.fromEntries(Object.keys(vec).sort(byKey).map((party) => [party, formatRatio(vec[party]!)]));
  }
  const paths = p.paths
    .map((r) => ({ stem: r.stem, role: r.role, party: r.party, weight: formatRatio(r.weight), claims: [...r.claims] }))
    .sort((a, b) =>
      byKey(a.stem, b.stem) || byKey(a.role, b.role) || byKey(a.party, b.party) || byKey(a.claims.join(","), b.claims.join(",")));
  const body = { facts_digest: digestOf(facts), as_of: asOf, known_at: knownAt, u_digest: digestOf(normalizedUsage(usage)), vectors, paths };
  return { ...body, digest: digestOf(body) };
}
