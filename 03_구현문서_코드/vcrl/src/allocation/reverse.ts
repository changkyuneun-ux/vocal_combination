import { digestOf } from "../core/digest.ts";
import { isEnumValue, type EnumValue } from "../core/enums.ts";
import { attempt, describe, diag, err, fail, underPath, type Diagnostic, type Result } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { ratio } from "../core/ratio.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";
import { splitLrm } from "./lrm.ts";
import {
  ALLOCATION_RESULT_FORMAT, type AllocationDocument, type AllocationLine, type AllocationResult, type Holding, type PoolLine,
} from "./types.ts";
import { validateAllocation } from "./validate.ts";

/** 역분개 결과 형식 태그. result_digest 계산에 포함된다. */
export const REVERSAL_RESULT_FORMAT = "vcrl-reversal-result/1" as const;
/** 남은 금액 비례 순차 계층 LRM(설계 결정 3). */
export const REVERSAL_METHOD = "REVERSAL_REMAINING_LRM_V1" as const;

export type ReversalReason = EnumValue<"reversal_reason">;
export type Refund = { id: string; reason: ReversalReason; amount: string };
export type ReversalLine = AllocationLine & { reverses_line_seq: string };
export type ReversalResult = {
  format: typeof REVERSAL_RESULT_FORMAT;
  run_id: string;
  original_run_id: string;
  original_result_digest: string;
  policy_digest: string;
  event_id: string;
  refund: Refund;
  sequence: string;
  cumulative: string;
  original_amount: string;
  previous_digest?: string;
  method: typeof REVERSAL_METHOD;
  pool_lines: PoolLine[];
  lines: ReversalLine[];
  holdings: Holding[];
  result_digest: string;
};
export type ReversalInput = {
  original: AllocationResult;
  policy: AllocationDocument;
  eventId: string;
  refund: Refund;
  priors: readonly ReversalResult[];
  runId: string;
};

const AMOUNT_RE = /^(0|[1-9]\d*)$/;
const POSITIVE_RE = /^[1-9]\d*$/;
const BUCKET_RE = /^[a-z][a-z0-9_]*$/;
const REFUND_KEYS = ["id", "reason", "amount"] as const;

type Pool = { key: string; row: PoolLine; remaining: bigint };
type Child = { key: string; group: string; remaining: bigint; line?: AllocationLine; holding?: Holding };
type State = { original: AllocationResult; eventId: string; rights: string; total: bigint; pools: Pool[]; children: Child[] };

function amountOf(v: unknown, path: string): bigint {
  if (typeof v !== "string" || !AMOUNT_RE.test(v)) fail("CORE_TYPE_ERROR", path, describe(v));
  return BigInt(v);
}

function rowsOf(original: AllocationResult, name: "pool_lines" | "lines" | "holdings"): Record<string, unknown>[] {
  const v: unknown = (original as unknown as Record<string, unknown>)[name];
  if (!Array.isArray(v)) fail("CORE_TYPE_ERROR", `$.original.${name}`, "must be an array");
  return v.map((row: unknown, i: number) => {
    if (!isPlainObject(row)) fail("CORE_TYPE_ERROR", `$.original.${name}[${i}]`, "must be an object");
    return row;
  });
}

function checkBucket(v: unknown, path: string): string {
  if (typeof v !== "string" || !BUCKET_RE.test(v)) fail("CORE_TYPE_ERROR", path, describe(v));
  return v;
}

/** 되돌릴 이벤트의 풀 라인·라인·보류와 남은 금액(처음에는 원 금액). */
function buildState(original: AllocationResult, rights: string, eventId: string): State {
  const pools: Pool[] = [];
  rowsOf(original, "pool_lines").forEach((p, i) => {
    if (p.event_id !== eventId) return;
    checkBucket(p.bucket, `$.original.pool_lines[${i}].bucket`);
    pools.push({ key: String(p.bucket), row: p as unknown as PoolLine, remaining: amountOf(p.amount, `$.original.pool_lines[${i}].amount`) });
  });
  if (pools.length === 0) fail("REV_UNKNOWN_EVENT", "$.event_id", eventId);
  const children: Child[] = [];
  rowsOf(original, "lines").forEach((l, i) => {
    if (l.event_id !== eventId) return;
    const lp = `$.original.lines[${i}]`;
    if (!isId(l.party)) fail("CORE_TYPE_ERROR", `${lp}.party`, describe(l.party));
    if (!isEnumValue("claimant_role", l.role)) fail("CORE_TYPE_ERROR", `${lp}.role`, describe(l.role));
    checkBucket(l.bucket, `${lp}.bucket`);
    if (typeof l.line_seq !== "string" || !POSITIVE_RE.test(l.line_seq)) fail("CORE_TYPE_ERROR", `${lp}.line_seq`, describe(l.line_seq));
    const line = l as unknown as AllocationLine;
    children.push({ key: `line:${line.party}`, group: line.bucket, line, remaining: amountOf(l.amount, `$.original.lines[${i}].amount`) });
  });
  rowsOf(original, "holdings").forEach((h, i) => {
    if (h.event_id !== eventId) return;
    const hp = `$.original.holdings[${i}]`;
    checkBucket(h.bucket, `${hp}.bucket`);
    if (!isEnumValue("holding_reason", h.reason)) fail("CORE_TYPE_ERROR", `${hp}.reason`, describe(h.reason));
    const holding = h as unknown as Holding;
    children.push({ key: `hold:${holding.reason}`, group: holding.bucket, holding, remaining: amountOf(h.amount, `$.original.holdings[${i}].amount`) });
  });
  const rightsPool = pools.find((p) => p.key === rights);
  const childSum = children.reduce((a, c) => a + c.remaining, 0n);
  if (rightsPool === undefined || rightsPool.remaining !== childSum) {
    fail("REV_ORIGINAL_INCONSISTENT", "$.original", `event ${eventId}: rights pool ${rightsPool?.remaining ?? "missing"} vs lines+holdings ${childSum}`);
  }
  return { original, eventId, rights, total: pools.reduce((a, p) => a + p.remaining, 0n), pools, children };
}

/** total을 남은 금액 비례로 LRM 분배한다. 남은 금액 0인 항목은 제외하고, 결과는 입력 순서다. */
function distribute(total: bigint, items: readonly { key: string; remaining: bigint }[], path: string): bigint[] {
  const out = items.map(() => 0n);
  if (total === 0n) return out;
  const idx = items.flatMap((it, i) => (it.remaining > 0n ? [i] : []));
  const avail = idx.reduce((a, i) => a + items[i]!.remaining, 0n);
  if (total > avail) fail("ALLOC_ROUNDING_INVARIANT", path, "increment exceeds remaining");
  const parts = splitLrm(total, idx.map((i) => ({ key: items[i]!.key, weight: ratio(items[i]!.remaining, avail) })), path);
  parts.forEach((p, j) => {
    const i = idx[j]!;
    if (p.amount > items[i]!.remaining) fail("ALLOC_ROUNDING_INVARIANT", path, "increment exceeds remaining");
    out[i] = p.amount;
  });
  return out;
}

/** seq번째 역분개 하나를 계산하고 state의 남은 금액을 줄인다. */
function step(s: State, seq: number, refund: Refund, runId: string, previous: string | undefined, before: bigint): ReversalResult {
  const amount = BigInt(refund.amount);
  if (amount > s.total - before) fail("REV_EXCEEDS_REMAINING", "$.refund.amount", `${amount} > remaining ${s.total - before}`);
  const path = `$.reversal[${seq}]`;
  const poolInc = distribute(amount, s.pools, `${path}.tier1`);
  const rightsInc = poolInc[s.pools.findIndex((p) => p.key === s.rights)]!;
  const groups = [...new Set(s.children.map((c) => c.group))];
  const groupInc = distribute(rightsInc, groups.map((g) => ({
    key: g, remaining: s.children.filter((c) => c.group === g).reduce((a, c) => a + c.remaining, 0n),
  })), `${path}.tier2`);
  const childInc = s.children.map(() => 0n);
  groups.forEach((g, gi) => {
    const idx = s.children.flatMap((c, i) => (c.group === g ? [i] : []));
    const inc = distribute(groupInc[gi]!, idx.map((i) => s.children[i]!), `${path}.bucket:${g}`);
    idx.forEach((i, j) => { childInc[i] = inc[j]!; });
  });
  s.pools.forEach((p, i) => { p.remaining -= poolInc[i]!; });
  s.children.forEach((c, i) => { c.remaining -= childInc[i]!; });

  const neg = (v: bigint) => (-v).toString();
  const lineSeq = String(seq + 1);
  const body: Omit<ReversalResult, "result_digest"> = {
    format: REVERSAL_RESULT_FORMAT,
    run_id: runId,
    original_run_id: s.original.run_id,
    original_result_digest: s.original.result_digest,
    policy_digest: s.original.policy_digest,
    event_id: s.eventId,
    refund: { id: refund.id, reason: refund.reason, amount: refund.amount },
    sequence: String(seq),
    cumulative: (before + amount).toString(),
    original_amount: s.total.toString(),
    ...(previous !== undefined && { previous_digest: previous }),
    method: REVERSAL_METHOD,
    pool_lines: s.pools.flatMap((p, i) => (poolInc[i] === 0n ? [] : [{ event_id: s.eventId, bucket: p.row.bucket, amount: neg(poolInc[i]!) }])),
    lines: s.children.flatMap((c, i) => (c.line === undefined || childInc[i] === 0n ? [] : [{
      event_id: s.eventId, party: c.line.party, role: c.line.role, bucket: c.line.bucket,
      line_seq: lineSeq, reverses_line_seq: c.line.line_seq, amount: neg(childInc[i]!),
    }])),
    holdings: s.children.flatMap((c, i) => (c.holding === undefined || childInc[i] === 0n ? [] : [{
      event_id: s.eventId, bucket: c.holding.bucket, reason: c.holding.reason, amount: neg(childInc[i]!),
    }])),
  };
  return { ...body, result_digest: digestOf(body) };
}

function checkRefund(r: unknown, path: string): Diagnostic[] {
  if (!isPlainObject(r)) return [diag("CORE_TYPE_ERROR", path, "must be an object")];
  const out = rejectUnknownKeys(r, REFUND_KEYS, path);
  if (!isId(r.id)) out.push(diag("CORE_TYPE_ERROR", `${path}.id`, describe(r.id)));
  if (!isEnumValue("reversal_reason", r.reason)) out.push(diag("CORE_ENUM_UNKNOWN", `${path}.reason`, describe(r.reason)));
  if (typeof r.amount !== "string" || !POSITIVE_RE.test(r.amount)) out.push(diag("REV_AMOUNT", `${path}.amount`, describe(r.amount)));
  return out;
}

/** 원 안분 결과의 한 이벤트를 refund만큼 역분개한다(설계 결정 1~6). 같은 입력은 같은 result_digest를 낸다. */
export function reverse(input: ReversalInput): Result<ReversalResult> {
  const { original, policy, eventId, refund, priors, runId } = input;
  if (!isPlainObject(original)) return err([diag("CORE_TYPE_ERROR", "$.original", "must be an object")]);
  const errors: Diagnostic[] = [];
  if (original.format !== ALLOCATION_RESULT_FORMAT) errors.push(diag("CORE_TYPE_ERROR", "$.original.format", describe(original.format)));
  const own = attempt(() => digestOf({ ...original, trace: undefined, result_digest: undefined }));
  if (!own.ok) errors.push(...underPath("$.original", own.errors));
  else if (own.value !== original.result_digest) errors.push(diag("REV_ORIGINAL_DIGEST", "$.original.result_digest"));
  const policyErrors = validateAllocation(policy);
  if (policyErrors.length > 0) errors.push(...underPath("$.policy", policyErrors));
  else if (digestOf(policy) !== original.policy_digest) errors.push(diag("CORE_DIGEST_MISMATCH", "$.policy", "not the policy the original was evaluated with"));
  if (!isId(eventId)) errors.push(diag("CORE_TYPE_ERROR", "$.event_id", describe(eventId)));
  if (!isId(runId)) errors.push(diag("CORE_TYPE_ERROR", "$.run_id", describe(runId)));
  errors.push(...checkRefund(refund, "$.refund"));
  if (!Array.isArray(priors)) errors.push(diag("CORE_TYPE_ERROR", "$.priors", "must be an array"));
  if (errors.length > 0) return err(errors);

  return attempt(() => {
    const s = buildState(original, policy.body.tier1.rights, eventId);
    let previous: string | undefined;
    let before = 0n;
    (priors as readonly unknown[]).forEach((p, k) => {
      const path = `$.priors[${k}]`;
      if (!isPlainObject(p) || checkRefund(p.refund, `${path}.refund`).length > 0 || !isId(p.run_id) || p.event_id !== eventId) {
        fail("REV_CHAIN_BROKEN", path, "not a reversal of this event");
      }
      const prior = p as unknown as ReversalResult;
      const expected = attempt(() => step(s, k + 1, prior.refund, prior.run_id, previous, before));
      const self = attempt(() => digestOf({ ...prior, result_digest: undefined }));
      if (!expected.ok || !self.ok || expected.value.result_digest !== prior.result_digest || self.value !== prior.result_digest) {
        fail("REV_CHAIN_BROKEN", path, "does not re-derive from the original and the earlier reversals");
      }
      previous = prior.result_digest;
      before += BigInt(prior.refund.amount);
    });
    return step(s, priors.length + 1, refund, runId, previous, before);
  });
}

export type ReversalVerificationInput = Omit<ReversalInput, "eventId" | "refund" | "runId">;

/** 제공된 역분개 결과를 신뢰하지 않고 원 결과·이전 역분개로 다시 계산해 대조한다(설계 결정 7). */
export function verifyReversal(input: ReversalVerificationInput, given: unknown): Diagnostic[] {
  if (!isPlainObject(given)) return [diag("CORE_TYPE_ERROR", "$.result", "must be an object")];
  if (given.format !== REVERSAL_RESULT_FORMAT) return [diag("CORE_TYPE_ERROR", "$.result.format", describe(given.format))];
  const r = reverse({ ...input, eventId: given.event_id as string, refund: given.refund as Refund, runId: given.run_id as string });
  if (!r.ok) return r.errors;
  const self = attempt(() => digestOf({ ...given, result_digest: undefined }));
  if (!self.ok) return underPath("$.result", self.errors);
  if (r.value.result_digest !== given.result_digest || self.value !== given.result_digest) return [diag("CORE_DIGEST_MISMATCH", "$.result")];
  return [];
}
