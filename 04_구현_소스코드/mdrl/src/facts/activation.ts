import { diag, type Diagnostic } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import type { Instant } from "../core/time.ts";
import { checkClaimantCoverage, deriveClaimants, ROLE_RIGHT, type ClaimantEntry } from "./mandate.ts";
import { HOLD, projectVectors, type PartyVector, type Usage } from "./project.ts";
import { isEffective } from "./temporal.ts";
import { MAX_MANDATE_HOPS, type ClaimantRole, type FactsDocument, type Mandate } from "./types.ts";

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
  const declaredErrors = checkDeclaredShape(declared);
  if (declaredErrors.length > 0) return declaredErrors;
  const projection = projectVectors(facts, usage, asOf, knownAt);
  if (!projection.ok) return projection.errors;

  const status = new Map(facts.body.claims.map((c) => [c.id, c.status]));
  const disputedClaims = projection.value.paths
    .filter((r) => r.party === HOLD)
    .flatMap((r) => r.claims)
    .filter((id) => status.get(id) === "DISPUTED");

  const out: Diagnostic[] = [];
  const derived = deriveClaimants(facts, projection.value, asOf, knownAt);

  const disputedMandateIds = new Set<string>();
  for (const [role, vec] of Object.entries(projection.value.vectors) as [ClaimantRole, PartyVector][]) {
    const right = ROLE_RIGHT[role];
    if (right === undefined) continue;
    const byFrom = new Map<string, Mandate[]>();
    for (const m of facts.body.mandates) {
      if (m.right !== right || !isEffective(m, asOf, knownAt)) continue;
      byFrom.set(m.from, [...(byFrom.get(m.from) ?? []), m]);
    }
    const visited = new Set<string>();
    let frontier = Object.entries(vec ?? {})
      .filter(([party, w]) => party !== HOLD && w.n !== 0n)
      .map(([party]) => party);
    for (let hop = 0; hop < MAX_MANDATE_HOPS && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const party of frontier) {
        if (visited.has(party)) continue;
        visited.add(party);
        for (const m of byFrom.get(party) ?? []) {
          if (m.status === "DISPUTED") disputedMandateIds.add(m.id);
          next.push(m.to);
        }
      }
      frontier = next;
    }
  }

  const ids = [...new Set([...disputedClaims, ...disputedMandateIds])].sort(byKey);
  if (ids.length > 0) out.push(diag("FACTS_DISPUTE_OPEN", "$.activation", ids.join(",")));
  if (!derived.ok) return [...out, ...derived.errors];
  return [...out, ...checkClaimantCoverage(derived.value, declared)];
}

/** `declared`는 신뢰할 수 없는(JSON에서 온) 입력일 수 있다: role·party가 string인 plain object 배열인지 먼저 본다. */
function checkDeclaredShape(declared: unknown): Diagnostic[] {
  if (!Array.isArray(declared)) return [diag("CORE_TYPE_ERROR", "$.declared", "must be an array")];
  const out: Diagnostic[] = [];
  declared.forEach((e, i) => {
    const p = `$.declared[${i}]`;
    if (!isPlainObject(e)) {
      out.push(diag("CORE_TYPE_ERROR", p, "must be an object"));
    } else {
      if (typeof e.role !== "string") out.push(diag("CORE_TYPE_ERROR", `${p}.role`, "must be a string"));
      if (typeof e.party !== "string") out.push(diag("CORE_TYPE_ERROR", `${p}.party`, "must be a string"));
    }
  });
  return out;
}
