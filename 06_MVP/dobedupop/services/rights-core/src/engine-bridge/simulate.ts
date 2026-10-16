import { evaluate, type AllocationDocument, type AllocationResult, type RevenueEvent } from "mdrl/allocation";
import type { Result } from "mdrl/core";
import type { Tx } from "../platform/db.ts";
import type { BridgeCtx } from "./context.ts";
import { sealInputs } from "./settle.ts";

export { decideGrant, type GrantRule, type Requirement } from "./grant.ts";

/**
 * 발행 봉인의 입력으로 mdrl evaluate를 돌리되 아무것도 봉인하지 않는다. 코어가 아직 수집하지 않는 이벤트 유형
 * (예: 감상 매출 TRAFFIC)의 계산이나 정책 변형의 비교(예: 위임 라우팅 전 기여분)를 보여 주는 시뮬레이션용이며,
 * 정산 run·원장에는 쓰지 않는다. variant는 봉인된 정책의 사본을 받아 바꾼 사본을 돌려준다.
 */
export async function simulateEvents(
  ctx: BridgeCtx, tx: Tx,
  input: { snapshotId: string; runId: string; events: RevenueEvent[]; variant?: (policy: AllocationDocument) => AllocationDocument },
): Promise<Result<AllocationResult>> {
  const s = await sealInputs(ctx, tx, input.snapshotId);
  const policy = input.variant === undefined ? s.policy : input.variant(structuredClone(s.policy));
  return evaluate({ policy, facts: s.facts, projection: s.projection, snapshot: s.snapshot, events: input.events, runId: input.runId });
}

/** 정책 변형: 위임 라우팅(via mandate)을 뺀다. 소속사로 보내기 전의 실연자별 기여분을 볼 때 쓴다(다음 작업 16). */
export function withoutMandateRouting(policy: AllocationDocument): AllocationDocument {
  for (const b of policy.body.tier2.split) delete b.via_mandate;
  return policy;
}
