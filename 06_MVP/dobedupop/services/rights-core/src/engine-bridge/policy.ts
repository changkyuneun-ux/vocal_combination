import { validateAllocation, type AllocationDocument } from "mdrl/allocation";
import { formatAllocation, parseAllocation } from "mdrl/text";
import type { Tx } from "../platform/db.ts";
import { invalid } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadSealed, sealDocument, type Sealed } from "./seal-store.ts";

/** 정책 IR의 id·version·depends_on을 레지스트리 값으로 고정하고 검증·봉인한다(통합 설계 9.3-2). */
async function pinAndSeal(ctx: BridgeCtx, tx: Tx, ir: AllocationDocument, policyId: string, version: number, facts: Sealed) {
  const pinned: AllocationDocument = {
    ...ir,
    id: policyId,
    version: String(version),
    depends_on: [{ ref: `vc:facts/${facts.docId}@${facts.docVersion}`, digest: facts.digest }],
  };
  const errors = validateAllocation(pinned);
  if (errors.length > 0) throw invalid("POLICY_INVALID", `policy ${policyId} failed MDRL validation`, errors);
  const sealed = await sealDocument(ctx, tx, { kind: "allocation", value: pinned, docId: policyId, docVersion: String(version) });
  return { sealed, canonicalText: formatAllocation(pinned), ir: pinned };
}

export async function compilePolicyText(
  ctx: BridgeCtx, tx: Tx, input: { sourceText: string; policyId: string; version: number; packId: string; facts: Sealed },
): Promise<{ sealed: Sealed; canonicalText: string }> {
  const parsed = parseAllocation(input.sourceText);
  if (!parsed.ok) throw invalid("POLICY_INVALID", "policy text failed to parse", parsed.errors);
  if (parsed.value.body.scope.pack !== input.packId) {
    throw invalid("POLICY_PACK_MISMATCH", `policy scope.pack ${parsed.value.body.scope.pack} is not ${input.packId}`);
  }
  const { sealed, canonicalText } = await pinAndSeal(ctx, tx, parsed.value, input.policyId, input.version, input.facts);
  return { sealed, canonicalText };
}

/** 가벼운 재고정: 봉인된 정책 본문은 그대로 두고 facts 고정과 version만 바꾼다(통합 설계 3.3). */
export async function repinPolicy(
  ctx: BridgeCtx, tx: Tx, input: { policyDigest: string; version: number; facts: Sealed },
): Promise<{ sealed: Sealed; canonicalText: string }> {
  const old = (await loadSealed(ctx, tx, input.policyDigest)) as AllocationDocument;
  const { sealed, canonicalText } = await pinAndSeal(ctx, tx, old, old.id, input.version, input.facts);
  return { sealed, canonicalText };
}
