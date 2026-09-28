import { diag, type Diagnostic } from "../core/errors.ts";
import type { Instant } from "../core/time.ts";
import { checkClaimantCoverage, deriveClaimants, type ClaimantEntry } from "./mandate.ts";
import { HOLD, projectVectors, type Usage } from "./project.ts";
import { isEffective } from "./temporal.ts";
import type { FactsDocument } from "./types.ts";

export type ActivationInput = {
  facts: FactsDocument;
  usage: Usage;
  asOf: Instant;
  knownAt: Instant;
  declared: readonly ClaimantEntry[];
};

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 팩 활성화 판정(스펙 12.20): 사용 스템의 권리 경로에 분쟁 중인 claim·mandate가 있으면 FACTS_DISPUTE_OPEN,
 * 그리고 청구권자 커버리지 결과를 함께 보고한다. 빈 배열이면 활성화할 수 있다.
 */
export function checkActivation(input: ActivationInput): Diagnostic[] {
  const { facts, usage, asOf, knownAt, declared } = input;
  const projection = projectVectors(facts, usage, asOf, knownAt);
  if (!projection.ok) return projection.errors;

  const status = new Map(facts.body.claims.map((c) => [c.id, c.status]));
  const disputedClaims = projection.value.paths
    .filter((r) => r.party === HOLD)
    .flatMap((r) => r.claims)
    .filter((id) => status.get(id) === "DISPUTED");

  const out: Diagnostic[] = [];
  const derived = deriveClaimants(facts, projection.value, asOf, knownAt);
  const involved = new Set([
    ...Object.values(projection.value.vectors).flatMap((v) => Object.keys(v ?? {})),
    ...(derived.ok ? derived.value.map((c) => c.party) : []),
  ]);
  const disputedMandates = facts.body.mandates
    .filter((m) => m.status === "DISPUTED" && isEffective(m, asOf, knownAt) && involved.has(m.from))
    .map((m) => m.id);

  const ids = [...new Set([...disputedClaims, ...disputedMandates])].sort(byKey);
  if (ids.length > 0) out.push(diag("FACTS_DISPUTE_OPEN", "$.activation", ids.join(",")));
  if (!derived.ok) return [...out, ...derived.errors];
  return [...out, ...checkClaimantCoverage(derived.value, declared)];
}
