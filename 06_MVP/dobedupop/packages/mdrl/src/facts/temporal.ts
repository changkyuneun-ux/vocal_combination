import { contains, type Instant, type Interval } from "../core/time.ts";
import type { Claim, ClaimEdge } from "./types.ts";

type TimedRecord = {
  recorded_at: Instant;
  superseded_at?: Instant;
  status: Claim["status"];
  valid: Interval;
};

/** 기록 시간축: known_at 시점에 원장에 보였던 레코드인가. */
export function isVisible(r: TimedRecord, knownAt: Instant): boolean {
  return r.recorded_at <= knownAt && (r.superseded_at === undefined || knownAt < r.superseded_at);
}

/** 계산 대상: 두 시간축을 모두 만족하고 VERIFIED 또는 DISPUTED인 레코드. */
export function isEffective(r: TimedRecord, asOf: Instant, knownAt: Instant): boolean {
  return isVisible(r, knownAt) && contains(r.valid, asOf) && (r.status === "VERIFIED" || r.status === "DISPUTED");
}

/** 정적 검증 대상: 현재 지식(미대체) 기준으로 VERIFIED 또는 DISPUTED인 레코드. */
export function isCurrent(r: TimedRecord): boolean {
  return r.superseded_at === undefined && (r.status === "VERIFIED" || r.status === "DISPUTED");
}

/** 유효 집합이 바뀔 수 있는 모든 시점. 각 시점에서 검사하면 전 기간을 덮는다. */
export function boundaries(rs: readonly { valid: Interval }[]): Instant[] {
  const s = new Set<Instant>();
  for (const r of rs) {
    s.add(r.valid.from);
    if (r.valid.to !== undefined) s.add(r.valid.to);
  }
  return [...s].sort();
}

export function groupKey(source: string, edge: ClaimEdge, performerRole?: string): string {
  return edge === "PERFORMED_BY" ? `${source}|${edge}|${performerRole ?? ""}` : `${source}|${edge}`;
}

export function claimGroupKey(c: Claim): string {
  return groupKey(c.source, c.edge, c.performer_role);
}

export type ClaimGroup = { key: string; claims: Claim[]; disputed: boolean; sumBps: number };

export function groupClaims(claims: readonly Claim[]): Map<string, ClaimGroup> {
  const out = new Map<string, ClaimGroup>();
  for (const c of claims) {
    const key = claimGroupKey(c);
    const g = out.get(key) ?? { key, claims: [], disputed: false, sumBps: 0 };
    g.claims.push(c);
    g.disputed ||= c.status === "DISPUTED";
    g.sumBps += Number(c.share);
    out.set(key, g);
  }
  return out;
}
