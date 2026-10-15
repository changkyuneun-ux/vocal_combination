import { checkActivation, deriveClaimants, projectVectors, type ClaimantEntry } from "mdrl/facts";
import type { Tx } from "../platform/db.ts";
import { invalid, type Diagnostic } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadFacts } from "./facts.ts";

export type Declared = { role: string; party: string };

/** 활성화 검사용 사용량: 정산 대상 스템 전부를 같은 가중치로 쓴다(모든 권리 경로를 본다). */
export function fullUsage(stems: readonly { id: string; rights_bearing: boolean }[]): Record<string, string> {
  return Object.fromEntries(stems.filter((s) => s.rights_bearing).map((s) => [s.id, "1"]));
}

/** 팩·정책 활성화 판정(코어 규격 12.20): 분쟁 경로와 청구권자 커버리지. 빈 배열이면 활성화할 수 있다. */
export async function checkPackActivation(ctx: BridgeCtx, tx: Tx, input: { factsDigest: string; declared: Declared[]; at: string }): Promise<Diagnostic[]> {
  const facts = await loadFacts(ctx, tx, input.factsDigest);
  return checkActivation({
    facts, usage: fullUsage(facts.body.stems), asOf: input.at, knownAt: input.at, declared: input.declared as ClaimantEntry[],
  });
}

/** 조합 지분에서 파생한 청구권자 집합(정렬된 "ROLE:party"). 재고정 판정에 쓴다(통합 설계 3.3). */
export async function claimantSet(ctx: BridgeCtx, tx: Tx, factsDigest: string, at: string): Promise<string[]> {
  const facts = await loadFacts(ctx, tx, factsDigest);
  const projection = projectVectors(facts, fullUsage(facts.body.stems), at, at);
  if (!projection.ok) throw invalid("PROJECTION_FAILED", "projection failed", projection.errors);
  const derived = deriveClaimants(facts, projection.value, at, at);
  if (!derived.ok) throw invalid("PROJECTION_FAILED", "claimant derivation failed", derived.errors);
  return derived.value.map((e) => `${e.role}:${e.party}`).sort();
}
