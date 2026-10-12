import { parseBps } from "../core/bps.ts";
import { MdrlError, fail } from "../core/errors.ts";
import { ONE, fromBps, type Ratio } from "../core/ratio.ts";
import type { Instant } from "../core/time.ts";
import { ROLE_RIGHT, routeVector } from "../facts/mandate.ts";
import type { PartyVector } from "../facts/project.ts";
import type { ClaimantRole, FactsDocument } from "../facts/types.ts";
import type { VectorExpr } from "./types.ts";
import { capVector, fixedVector, floorGuarantee, mixVectors, usageVector } from "./vectors.ts";

export type ExprContext = {
  facts: FactsDocument;
  parties: ReadonlySet<string>;
  vectors: Partial<Record<ClaimantRole, PartyVector>>;
  members: PartyVector;
  asOf: Instant;
  knownAt: Instant;
};

type PoolExpr = Extract<VectorExpr, { fn: "performance_pool" }>;

const bps = (v: unknown, path: string): Ratio => fromBps(parseBps(v, path));

/** 벡터 식을 평가한다. 정책은 validateAllocation을 통과했다고 가정하며, 실패는 MdrlError로 던진다. */
export function evalVector(e: VectorExpr, ctx: ExprContext, path: string): PartyVector {
  switch (e.fn) {
    case "graph":
      return graphVector(e.role, e.via_mandate === true, ctx, path);
    case "contract":
      if (!ctx.parties.has(e.party)) return fail("FACTS_UNKNOWN_PARTY", `${path}.party`, e.party);
      return { [e.party]: ONE };
    case "member_pct":
      return ctx.members;
    case "performance_pool":
      return poolVector(e, ctx, path);
    case "mix":
      return mixVectors(e.parts.map((p, i) => ({
        weight: bps(p.weight, `${path}.parts[${i}].weight`),
        vec: evalVector(p.of, ctx, `${path}.parts[${i}].of`),
      })));
    case "cap":
      return capVector(evalVector(e.of, ctx, `${path}.of`), bps(e.max, `${path}.max`), path);
    case "floor_guarantee":
      return floorGuarantee(evalVector(e.of, ctx, `${path}.of`), Object.keys(ctx.members), bps(e.min, `${path}.min`), path);
  }
}

function graphVector(role: ClaimantRole, viaMandate: boolean, ctx: ExprContext, path: string): PartyVector {
  const vec = ctx.vectors[role];
  if (vec === undefined) return fail("ALLOC_EMPTY_VECTOR", path, `no ${role} vector in projection`);
  if (!viaMandate) return vec;
  const right = ROLE_RIGHT[role];
  if (right === undefined) return fail("CORE_TYPE_ERROR", `${path}.via_mandate`, `${role} has no mandate right`);
  const routed = routeVector(ctx.facts, vec, right, ctx.asOf, ctx.knownAt);
  if (!routed.ok) throw new MdrlError(routed.errors);
  return routed.value;
}

function poolVector(e: PoolExpr, ctx: ExprContext, path: string): PartyVector {
  const fixed = () => fixedVector(Object.keys(ctx.members), path);
  const usage = () => usageVector(
    ctx.vectors.PERFORMER_FEATURED, ctx.vectors.PERFORMER_NON_FEATURED, bps(e.featured_weight, `${path}.featured_weight`), path,
  );
  switch (e.mode) {
    case "MEMBER_PCT":
      return ctx.members;
    case "FIXED":
      return fixed();
    case "USAGE_WEIGHTED":
      return usage();
    case "HYBRID":
      return mixVectors([
        { weight: bps(e.fixed, `${path}.fixed`), vec: fixed() },
        { weight: bps(e.usage, `${path}.usage`), vec: usage() },
      ]);
  }
}
