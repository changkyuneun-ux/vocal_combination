import { randomBytes } from "node:crypto";
import { canonicalSha256 } from "../engine-bridge/seal-store.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { withSystemScope, type Actor } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError, type Diagnostic } from "../platform/errors.ts";
import { activePolicyForPack } from "../policy/service.ts";
import * as issuance from "../issuance/service.ts";

/** 캐시 항목 수명. 동의 유효기간처럼 시각에 따라 바뀌는 판정이 있어 짧게 둔다. */
export const DECISION_TTL_MS = 5 * 60_000;

export type CheckInput = { packId: string; assignments: { slotId: string; stemId: string }[]; members?: Record<string, number>; usage?: issuance.Usage };
export type Decision = { issuable: boolean; code?: string; message?: string; diagnostics: Diagnostic[]; members: Record<string, number> };
export type CheckResult = Decision & { cached: boolean };

/** 비율을 주지 않으면 발행과 같은 기본값(부른 슬롯 수 비례)을 쓴다. */
export async function defaultMembers(tx: Tx, assignments: CheckInput["assignments"]): Promise<Record<string, number>> {
  const rows = (await tx.query(
    "SELECT stem_id, performer_party_id FROM stem WHERE stem_id = ANY($1) AND rights_bearing AND performer_party_id IS NOT NULL", [assignments.map((a) => a.stemId)],
  )).rows;
  const byStem = new Map(rows.map((r) => [r.stem_id as string, r.performer_party_id as string]));
  return issuance.slotShareBps(assignments.map((a) => byStem.get(a.stemId)).filter((p): p is string => p !== undefined));
}

/**
 * 팬 앱 조합 판정(다음 작업 12): 이 배치가 지금 발행될 수 있는지와 그 사유. 실제 발행(issuance.issue)을 SAVEPOINT 안에서 돌리고
 * 되돌리므로 게이트(팩 상태·분쟁·스템 오디오·이용허락·정산 사전 검사)가 실제 발행과 똑같다. 아무 행도 남지 않는다.
 * 같은 키(팩·활성 정책 digest·배치·멤버 비율·이용 범위)의 판정은 캐시에서 돌려준다. 캐시는 안내용이고 실제 발행은 게이트를 다시 돈다.
 */
export async function checkCombination(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, input: CheckInput): Promise<CheckResult> {
  return withSystemScope(tx, async () => {
    const pack = await issuance.packRow(tx, input.packId);
    const policy = await activePolicyForPack(tx, input.packId);
    const members = input.members ?? (await defaultMembers(tx, input.assignments));
    const usage = input.usage ?? issuance.FAN_APP_USAGE;
    const assignments = [...input.assignments].sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : a.stemId < b.stemId ? -1 : 1));
    const key = canonicalSha256({ packId: input.packId, policyDigest: policy?.policyDigest ?? null, assignments, members: Object.fromEntries(Object.entries(members).map(([k, v]) => [k, String(v)])), usage });
    const now = clock.now();

    const hit = (await tx.query(
      "UPDATE decision_cache SET hits = hits + 1, last_hit_at = $2 WHERE cache_key = $1 AND expires_at > $2 RETURNING result", [key, now],
    )).rows[0];
    if (hit !== undefined) return { ...(hit.result as Decision), cached: true };

    // 계산 시작 시점의 세대. 계산 중 무효화가 있었으면 저장하지 않는다.
    await tx.query("INSERT INTO decision_epoch (facts_scope_id, epoch) VALUES ($1, 1) ON CONFLICT DO NOTHING", [pack.factsScopeId]);
    const epoch = (await tx.query("SELECT epoch FROM decision_epoch WHERE facts_scope_id = $1", [pack.factsScopeId])).rows[0].epoch as string;

    const decision = await dryRunIssue(ctx, tx, clock, actor, { packId: input.packId, assignments: input.assignments, members, usage });

    const stems = [...new Set(input.assignments.map((a) => a.stemId))].sort();
    const voices = (await tx.query(
      `SELECT DISTINCT target_id FROM right_claim WHERE facts_scope_id = $1 AND edge = 'PERFORMED_BY' AND source_id = ANY($2) AND superseded_at IS NULL ORDER BY target_id`,
      [pack.factsScopeId, stems],
    )).rows.map((r) => r.target_id as string);
    // 세대 행을 잠가 겹치는 무효화가 이 저장의 커밋 뒤에 지우도록 한다.
    const cur = (await tx.query("SELECT epoch FROM decision_epoch WHERE facts_scope_id = $1 FOR SHARE", [pack.factsScopeId])).rows[0].epoch as string;
    if (cur === epoch && policy !== undefined) {
      await tx.query(
        `INSERT INTO decision_cache (cache_key, facts_scope_id, pack_id, policy_digest, voices, stems, result, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (cache_key) DO NOTHING`,
        [key, pack.factsScopeId, input.packId, policy.policyDigest, voices, stems, JSON.stringify(decision), now, new Date(Date.parse(now) + DECISION_TTL_MS).toISOString()],
      );
    }
    return { ...decision, cached: false };
  });
}

/** 실제 발행을 SAVEPOINT 안에서 돌리고 되돌린다. 게이트 거부(DomainError)는 판정 결과가 되고, 그 밖의 오류는 그대로 던진다. */
async function dryRunIssue(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, input: Omit<issuance.IssueInput, "vcId">): Promise<Decision> {
  const onBehalf: Actor = { ...actor, roles: new Set([...actor.roles, "ISSUER"]) };
  // 동시에 도는 판정끼리 같은 스냅샷 id로 서로 기다리지 않게 무작위 id를 쓴다(되돌리므로 남지 않는다).
  const vcId = `vc_check_${randomBytes(8).toString("hex")}`;
  await tx.query("SAVEPOINT fan_check");
  let decision: Decision;
  try {
    await issuance.issue(ctx, tx, clock, onBehalf, { ...input, vcId });
    decision = { issuable: true, diagnostics: [], members: input.members };
  } catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT fan_check");
    if (!(e instanceof DomainError) || e.status >= 500 || e.status === 403) throw e;
    return { issuable: false, code: e.code, message: e.message.replaceAll(vcId, "this combination"), diagnostics: [...(e.diagnostics ?? [])], members: input.members };
  }
  await tx.query("ROLLBACK TO SAVEPOINT fan_check");
  return decision;
}
