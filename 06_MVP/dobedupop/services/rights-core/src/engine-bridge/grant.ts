import { evaluateGrant, validateGrantRule, type GrantDecisionOutput, type GrantEvaluationInput, type GrantRule, type Requirement } from "mdrl/grant";
import type { Diagnostic } from "mdrl/core";
import { withSystemScope } from "../platform/actor.ts";
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

/**
 * 범위(곡)의 동의를 knownAt 시점으로 읽어 GrantRule로 돌려준다. knownAt 이후 서명된 동의는 뺀다. 순서는 consent_id.
 * 재동의: 엔진은 같은 자산에 철회된 허락이 하나라도 있으면 거부한다(불확실하면 거부). 같은 파티·자산·권리 종류에서
 * 철회 뒤에 새로 서명한 동의가 있으면 그 철회는 재동의로 대체된 것이므로 판정 입력에서 뺀다(철회 기록 자체는 남는다).
 */
export async function loadGrantRules(tx: Tx, factsScopeId: string, knownAt: string): Promise<GrantRule[]> {
  const rows = (await tx.query(
    "SELECT * FROM consent_agreement WHERE facts_scope_id = $1 AND signed_at <= $2 ORDER BY consent_id", [factsScopeId, knownAt],
  )).rows as ConsentRow[];
  const key = (r: ConsentRow) => `${r.party_id}\u0000${r.asset_id}\u0000${r.right_type}`;
  const lastSigned = new Map<string, number>();
  for (const r of rows) lastSigned.set(key(r), Math.max(lastSigned.get(key(r)) ?? 0, r.signed_at.getTime()));
  const rules = rows.map((r) => ({ r, rule: consentToRule(r, knownAt) }));
  return rules
    .filter(({ r, rule }) => !(rule.status === "REVOKED" && r.revoked_at !== null && lastSigned.get(key(r))! > r.revoked_at.getTime()))
    .map(({ rule }) => rule);
}

/** mdrl 이용허락 판정(불확실하면 거부). */
export function decideGrant(input: GrantEvaluationInput): GrantDecisionOutput {
  return evaluateGrant(input);
}

/** 조합이 쓰려는 이용 범위(기간 제외). 기간은 발행 시각 한 순간이다. */
export type Usage = { actions: string[]; territories: string[]; media: string[]; audience: string[] };

/**
 * 발행 게이트의 이용허락 판정(다음 작업 3). 조합이 쓰는 작품(WORK)·녹음(MASTER)·정산 대상 스템의 보이스(PERFORMER)마다
 * 요구를 만들고, 발행 시각(as_of = known_at)에 유효한 동의로 판정한다. 곡 전체를 봐야 하므로 system 범위로 읽는다.
 */
export async function decideIssueLicense(
  tx: Tx, input: { factsScopeId: string; stemIds: string[]; rightsBearingStemIds: string[]; usage: Usage; at: string },
): Promise<{ decision: GrantDecisionOutput; requirements: Requirement[] }> {
  return withSystemScope(tx, async () => {
    const work = (await tx.query("SELECT work_id FROM facts_scope WHERE facts_scope_id = $1", [input.factsScopeId])).rows[0].work_id as string;
    const recordings = (await tx.query("SELECT DISTINCT recording_id FROM stem WHERE stem_id = ANY($1) ORDER BY recording_id", [input.stemIds])).rows.map((r) => r.recording_id as string);
    const voices = (await tx.query(
      `SELECT DISTINCT target_id FROM right_claim
        WHERE facts_scope_id = $1 AND edge = 'PERFORMED_BY' AND source_id = ANY($2) AND superseded_at IS NULL AND status IN ('VERIFIED','ASSERTED')
        ORDER BY target_id`, [input.factsScopeId, input.rightsBearingStemIds],
    )).rows.map((r) => r.target_id as string);
    const to = new Date(Date.parse(input.at) + 1).toISOString();
    const scope = { ...input.usage, period: { from: input.at, to } };
    const requirements: Requirement[] = [
      { id: `r_work_${work}`, asset: work, right_type: "WORK", scope },
      ...recordings.map((r) => ({ id: `r_master_${r}`, asset: r, right_type: "MASTER", scope })),
      ...voices.map((v) => ({ id: `r_performer_${v}`, asset: v, right_type: "PERFORMER", scope })),
    ];
    const grants = await loadGrantRules(tx, input.factsScopeId, input.at);
    return { decision: evaluateGrant({ requirements, grants, as_of: input.at, known_at: input.at }), requirements };
  });
}

/** 거부·검토 판정의 요구별 사유를 진단으로 바꾼다(422 응답의 diagnostics). */
export function licenseDiagnostics(d: GrantDecisionOutput): Diagnostic[] {
  return d.trace.filter((t) => t.decision !== "PERMIT" && t.decision !== "PERMIT_WITH_OBLIGATION").flatMap((t) =>
    (t.reason_codes.length > 0 ? t.reason_codes : ["GRANT_REQUIREMENT_UNMET" as const]).map((code) => ({
      code, path: `$.license.${t.right_type}.${t.asset}`, message: `${t.right_type} ${t.asset}: ${t.decision}`,
    })));
}
