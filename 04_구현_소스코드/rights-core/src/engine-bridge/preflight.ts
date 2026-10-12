import { evaluate, type AllocationDocument, type Snapshot } from "mdrl/allocation";
import type { ProjectionIr } from "mdrl/facts";
import type { Tx } from "../platform/db.ts";
import type { Diagnostic } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadFacts } from "./facts.ts";
import type { IssueSeal } from "./issue.ts";
import { loadSealed, readSealedUncached } from "./seal-store.ts";

/**
 * 발행 사전 검사(통합 설계 11.2-1): 발행 봉인의 정책·facts·투영·멤버로 가상 이벤트(정책 범위의 첫 이벤트 유형, 1,000,000)를
 * mdrl evaluate로 평가해 진단을 돌려준다. 결과는 봉인하지 않는다. 봉인된 입력에 대한 진단은 결정적이다.
 * 투영·멤버는 같은 발행 트랜잭션에서 방금 봉인됐을 수 있으므로 캐시를 채우지 않고 읽는다(롤백되면 캐시에 남지 않도록).
 */
export async function preflightIssue(ctx: BridgeCtx, tx: Tx, seal: IssueSeal): Promise<Diagnostic[]> {
  const policy = (await loadSealed(ctx, tx, seal.policyDigest)) as AllocationDocument;
  const facts = await loadFacts(ctx, tx, seal.factsDigest);
  const projection = (await readSealedUncached(ctx, tx, seal.projectionDigest)) as ProjectionIr;
  const snapshot = (await readSealedUncached(ctx, tx, seal.membersDigest)) as Snapshot;
  const r = evaluate({
    policy, facts, projection, snapshot, runId: "preflight",
    events: [{ id: "preflight", type: policy.body.scope.events[0]!, amount: "1000000", currency: policy.body.scope.currency, integrity: "CLEAR" }],
  });
  return r.ok ? [] : [...r.errors];
}
