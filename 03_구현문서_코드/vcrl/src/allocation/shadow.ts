import { digestOf } from "../core/digest.ts";
import { attempt, describe, diag, err, ok, underPath, type Diagnostic, type Result } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import type { ClaimantRole } from "../facts/types.ts";
import { evaluate, type EvaluationInput } from "./evaluate.ts";
import type { AllocationResult } from "./types.ts";

/** 섀도 리포트 형식 태그. report_digest 계산에 포함된다. */
export const SHADOW_REPORT_FORMAT = "vcrl-shadow-report/1" as const;

export type ShadowPair = { baseline: EvaluationInput; candidate: EvaluationInput };
export type Comparison = { baseline: string; candidate: string; delta: string };
export type ShadowReport = {
  format: typeof SHADOW_REPORT_FORMAT;
  pairs: {
    events_digest: string; baseline_policy_digest: string; candidate_policy_digest: string;
    baseline_result_digest: string; candidate_result_digest: string;
  }[];
  parties: ({ party: string; role: ClaimantRole } & Comparison)[];
  buckets: ({ level: "tier1" | "tier2"; bucket: string } & Comparison)[];
  holdings: ({ reason: string } & Comparison)[];
  totals: { events: string; amount: string };
  report_digest: string;
};

/** 키 성분 구분자. 가장 작은 코드 유닛이라 결합 키의 정렬이 성분별 정렬과 같다. */
const SEP = "\u0000";
type Tally = Map<string, [bigint, bigint]>;

function add(t: Tally, key: string, side: 0 | 1, amount: string): void {
  const cur = t.get(key) ?? [0n, 0n];
  cur[side] += BigInt(amount);
  t.set(key, cur);
}

function rows<T>(t: Tally, build: (parts: string[], c: Comparison) => T): T[] {
  return [...t.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => {
    const [b, c] = t.get(k)!;
    return build(k.split(SEP), { baseline: b.toString(), candidate: c.toString(), delta: (c - b).toString() });
  });
}

/** 같은 이벤트를 두 입력으로 평가해 당사자·버킷·보류별 차액을 집계한다(설계 결정 8·9). */
export function shadowReport(pairs: readonly ShadowPair[]): Result<ShadowReport> {
  if (!Array.isArray(pairs) || pairs.length === 0) return err([diag("CORE_TYPE_ERROR", "$.pairs", "non-empty array required")]);
  const errors: Diagnostic[] = [];
  const results: [AllocationResult, AllocationResult][] = [];
  const seen = new Set<string>();
  pairs.forEach((pair: unknown, i: number) => {
    const p = `$.pairs[${i}]`;
    if (!isPlainObject(pair) || !isPlainObject(pair.baseline) || !isPlainObject(pair.candidate)) {
      errors.push(diag("CORE_TYPE_ERROR", p, "baseline and candidate evaluation inputs required"));
      return;
    }
    const b = evaluate(pair.baseline as unknown as EvaluationInput);
    const c = evaluate(pair.candidate as unknown as EvaluationInput);
    if (!b.ok) errors.push(...underPath(`${p}.baseline`, b.errors));
    if (!c.ok) errors.push(...underPath(`${p}.candidate`, c.errors));
    if (!b.ok || !c.ok) return;
    if (b.value.events_digest !== c.value.events_digest) {
      errors.push(diag("SHADOW_EVENTS_MISMATCH", p));
      return;
    }
    for (const id of new Set(b.value.pool_lines.map((l) => l.event_id))) {
      if (seen.has(id)) errors.push(diag("SHADOW_DUPLICATE_EVENT", p, id));
      seen.add(id);
    }
    results.push([b.value, c.value]);
  });
  if (errors.length > 0) return err(errors);

  const parties: Tally = new Map();
  const buckets: Tally = new Map();
  const holdings: Tally = new Map();
  let amount = 0n;
  for (const pair of results) {
    pair.forEach((r, side) => {
      const s = side as 0 | 1;
      for (const l of r.pool_lines) {
        add(buckets, ["tier1", l.bucket].join(SEP), s, l.amount);
        if (s === 0) amount += BigInt(l.amount);
      }
      for (const l of r.lines) {
        add(parties, [l.party, l.role].join(SEP), s, l.amount);
        add(buckets, ["tier2", l.bucket].join(SEP), s, l.amount);
      }
      for (const h of r.holdings) add(holdings, h.reason, s, h.amount);
    });
  }
  const report: Omit<ShadowReport, "report_digest"> = {
    format: SHADOW_REPORT_FORMAT,
    pairs: results.map(([b, c]) => ({
      events_digest: b.events_digest, baseline_policy_digest: b.policy_digest, candidate_policy_digest: c.policy_digest,
      baseline_result_digest: b.result_digest, candidate_result_digest: c.result_digest,
    })),
    parties: rows(parties, ([party, role], c) => ({ party: party!, role: role as ClaimantRole, ...c })),
    buckets: rows(buckets, ([level, bucket], c) => ({ level: level as "tier1" | "tier2", bucket: bucket!, ...c })),
    holdings: rows(holdings, ([reason], c) => ({ reason: reason!, ...c })),
    totals: { events: String(seen.size), amount: amount.toString() },
  };
  return ok({ ...report, report_digest: digestOf(report) });
}

/** 제공된 섀도 리포트를 신뢰하지 않고 다시 계산해 대조한다. */
export function verifyShadowReport(pairs: readonly ShadowPair[], given: unknown): Diagnostic[] {
  if (!isPlainObject(given)) return [diag("CORE_TYPE_ERROR", "$.result", "must be an object")];
  if (given.format !== SHADOW_REPORT_FORMAT) return [diag("CORE_TYPE_ERROR", "$.result.format", describe(given.format))];
  const r = shadowReport(pairs);
  if (!r.ok) return r.errors;
  const self = attempt(() => digestOf({ ...given, report_digest: undefined }));
  if (!self.ok) return underPath("$.result", self.errors);
  if (r.value.report_digest !== given.report_digest || self.value !== given.report_digest) return [diag("CORE_DIGEST_MISMATCH", "$.result")];
  return [];
}
