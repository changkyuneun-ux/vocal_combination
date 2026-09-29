import type { EnumValue } from "../core/enums.ts";
import type { IrDocument } from "../core/envelope.ts";
import type { ClaimantRole } from "../facts/types.ts";

/** 벡터 식. 비율 인자는 bps 문자열이다. */
export type VectorExpr =
  | { fn: "graph"; role: ClaimantRole; via_mandate?: boolean }
  | { fn: "contract"; party: string }
  | { fn: "member_pct" }
  | { fn: "performance_pool"; mode: EnumValue<"pool_mode">; fixed?: string; usage?: string; featured_weight?: string }
  | { fn: "mix"; parts: { weight: string; of: VectorExpr }[] }
  | { fn: "cap"; max: string; of: VectorExpr }
  | { fn: "floor_guarantee"; min: string; of: VectorExpr };

export type Tier1Bucket = { name: string; bps: string };
export type SplitBucket = { name: string; bps: string; role: ClaimantRole; vector: VectorExpr };

export type AllocationBody = {
  scope: { pack: string; events: EnumValue<"event_type">[]; currency: string };
  bind: { time: EnumValue<"binding_time"> };
  tier1: { buckets: Tier1Bucket[]; rights: string };
  tier2: { split: SplitBucket[] };
  rounding: { method: EnumValue<"rounding_method">; tie: "party_id_asc" };
};

export type AllocationDocument = IrDocument<AllocationBody>;

/** 발행 스냅샷: 실연 풀 멤버와 팬 빌더 멤버 비율(`"n/d"`, 합 1). */
export type Snapshot = { members: Record<string, string> };

export type RevenueEvent = {
  id: string;
  type: EnumValue<"event_type">;
  amount: string;
  currency: string;
  integrity: EnumValue<"integrity_status">;
};

export type PoolLine = { event_id: string; bucket: string; amount: string };
export type AllocationLine = { event_id: string; party: string; role: ClaimantRole; bucket: string; line_seq: string; amount: string };
export type Holding = { event_id: string; bucket: string; reason: EnumValue<"holding_reason">; amount: string };
export type TraceEntry = { event_id: string; level: string; total: string; parts: { key: string; weight: string; amount: string }[] };

/** 안분 결과 형식 태그(스펙 12.48). result_digest 계산에 포함된다. */
export const ALLOCATION_RESULT_FORMAT = "vcrl-alloc-result/1" as const;

export type AllocationResult = {
  format: typeof ALLOCATION_RESULT_FORMAT;
  run_id: string;
  policy_digest: string;
  projection_digest: string;
  snapshot_digest: string;
  events_digest: string;
  bind_time: EnumValue<"binding_time">;
  pool_lines: PoolLine[];
  lines: AllocationLine[];
  holdings: Holding[];
  trace: TraceEntry[];
  result_digest: string;
};
