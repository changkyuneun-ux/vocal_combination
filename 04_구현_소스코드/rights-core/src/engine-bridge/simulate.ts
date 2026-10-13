import { evaluate, type AllocationResult, type RevenueEvent } from "mdrl/allocation";
import type { Result } from "mdrl/core";
import { evaluateGrant, type GrantDecisionOutput, type GrantEvaluationInput } from "mdrl/grant";
import type { Tx } from "../platform/db.ts";
import type { BridgeCtx } from "./context.ts";
import { sealInputs } from "./settle.ts";

export type { GrantRule, Requirement } from "mdrl/grant";

/**
 * 발행 봉인의 입력으로 mdrl evaluate를 돌리되 아무것도 봉인하지 않는다. 코어가 아직 수집하지 않는 이벤트 유형
 * (예: 감상 매출 TRAFFIC)의 계산을 미리 보여 주는 시뮬레이션용이며, 정산 run·원장에는 쓰지 않는다.
 */
export async function simulateEvents(
  ctx: BridgeCtx, tx: Tx, input: { snapshotId: string; runId: string; events: RevenueEvent[] },
): Promise<Result<AllocationResult>> {
  const s = await sealInputs(ctx, tx, input.snapshotId);
  return evaluate({ policy: s.policy, facts: s.facts, projection: s.projection, snapshot: s.snapshot, events: input.events, runId: input.runId });
}

/** mdrl 이용허락 판정(불확실하면 거부). 코어의 발행 게이트에는 아직 연결되지 않았다. */
export function decideGrant(input: GrantEvaluationInput): GrantDecisionOutput {
  return evaluateGrant(input);
}
