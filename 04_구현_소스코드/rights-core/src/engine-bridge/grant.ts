import { evaluateGrant, validateGrantRule, type GrantDecisionOutput, type GrantEvaluationInput, type GrantRule, type Requirement } from "mdrl/grant";
import type { Diagnostic } from "mdrl/core";
import { iso, type Tx } from "../platform/db.ts";

export type { GrantRule, Requirement };

/** consent_agreement 한 행. knownAt 기준 상태는 signed_at·revoked_at으로 정한다. */
export type ConsentRow = {
  consent_id: string; party_id: string; right_type: string; asset_id: string;
  scope_actions: string[]; territories: string[]; media: string[]; audience: string[];
  valid_from: Date; valid_to: Date; signed_at: Date; revoked_at: Date | null;
};

/** 동의 행 → 엔진 GrantRule. knownAt에 이미 철회됐으면 REVOKED, 아니면 VERIFIED(서명된 원천 동의). */
export function consentToRule(r: ConsentRow, knownAt?: string): GrantRule {
  const revoked = r.revoked_at !== null && (knownAt === undefined || iso(r.revoked_at)! <= knownAt);
  const period = { from: iso(r.valid_from)!, to: iso(r.valid_to)! };
  return {
    id: r.consent_id, grantor: r.party_id, asset: r.asset_id, right_type: r.right_type,
    scope: { actions: [...r.scope_actions].sort(), territories: [...r.territories].sort(), media: [...r.media].sort(), audience: [...r.audience].sort(), period },
    status: revoked ? "REVOKED" : "VERIFIED", valid: period, recorded_at: iso(r.signed_at)!,
  };
}

/** 저장 전 검사: 엔진이 받아들이는 GrantRule인지(id·범위·기간 형식). */
export function validateConsentRule(rule: GrantRule): Diagnostic[] {
  return validateGrantRule(rule, "$.consent");
}

/** 범위(곡)의 동의를 knownAt 시점으로 읽어 GrantRule로 돌려준다. knownAt 이후 서명된 동의는 뺀다. 순서는 consent_id. */
export async function loadGrantRules(tx: Tx, factsScopeId: string, knownAt: string): Promise<GrantRule[]> {
  const rows = (await tx.query(
    "SELECT * FROM consent_agreement WHERE facts_scope_id = $1 AND signed_at <= $2 ORDER BY consent_id", [factsScopeId, knownAt],
  )).rows as ConsentRow[];
  return rows.map((r) => consentToRule(r, knownAt));
}

/** mdrl 이용허락 판정(불확실하면 거부). */
export function decideGrant(input: GrantEvaluationInput): GrantDecisionOutput {
  return evaluateGrant(input);
}
