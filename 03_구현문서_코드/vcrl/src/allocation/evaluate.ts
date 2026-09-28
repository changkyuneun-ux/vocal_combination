import { parseBps } from "../core/bps.ts";
import { digestOf, isDigest } from "../core/digest.ts";
import { isEnumValue } from "../core/enums.ts";
import { attempt, diag, err, ok, underPath, VcrlError, type Diagnostic, type Result } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { formatRatio, fromBps } from "../core/ratio.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";
import { isInstant } from "../core/time.ts";
import { HOLD, type PartyVector } from "../facts/project.ts";
import type { ProjectionIr } from "../facts/result.ts";
import type { ClaimantRole, FactsDocument } from "../facts/types.ts";
import { validateFactsStructure } from "../facts/validate.ts";
import { evalVector, type ExprContext } from "./expr.ts";
import { splitLrm, type Allotment, type Share } from "./lrm.ts";
import type {
  AllocationBody, AllocationDocument, AllocationLine, AllocationResult, Holding, PoolLine,
  RevenueEvent, Snapshot, SplitBucket, TraceEntry, VectorExpr,
} from "./types.ts";
import { PERFORMER_ROLES, validateAllocation } from "./validate.ts";
import { parseVector, sortedEntries } from "./vectors.ts";

export type EvaluationInput = {
  policy: AllocationDocument;
  facts: FactsDocument;
  projection: ProjectionIr;
  snapshot: Snapshot;
  events: RevenueEvent[];
  runId: string;
};

type Output = { pool_lines: PoolLine[]; lines: AllocationLine[]; holdings: Holding[]; trace: TraceEntry[] };
type Vectors = Partial<Record<ClaimantRole, PartyVector>>;

const AMOUNT_RE = /^[1-9]\d*$/;
const EVENT_KEYS = ["id", "type", "amount", "currency", "integrity"] as const;
const PROJECTION_FIELDS: readonly [string, (v: unknown) => boolean][] = [
  ["as_of", isInstant], ["known_at", isInstant], ["digest", isDigest], ["facts_digest", isDigest], ["u_digest", isDigest],
];

/** evaluate 본문이 facts·snapshot·projection을 역참조하기 전에, 그것들이 최소한의 모양을 갖췄는지 본다. */
function checkInputShapes(facts: unknown, snapshot: unknown, projection: unknown): Diagnostic[] {
  const out: Diagnostic[] = underPath("$.facts", validateFactsStructure(facts));
  if (!isPlainObject(snapshot)) out.push(diag("CORE_TYPE_ERROR", "$.snapshot", "must be an object"));
  else out.push(...rejectUnknownKeys(snapshot, ["members"], "$.snapshot"));
  if (!isPlainObject(projection)) {
    out.push(diag("CORE_TYPE_ERROR", "$.projection", "must be an object"));
    return out;
  }
  for (const [k, valid] of PROJECTION_FIELDS) {
    if (!valid(projection[k])) out.push(diag("CORE_TYPE_ERROR", `$.projection.${k}`, String(projection[k])));
  }
  if (!isPlainObject(projection.vectors)) out.push(diag("CORE_TYPE_ERROR", "$.projection.vectors", "must be an object"));
  return out;
}

/** 결정적 안분 평가기(스펙 5.6). 같은 입력은 같은 result_digest를 낸다. */
export function evaluate(input: EvaluationInput): Result<AllocationResult> {
  const { policy, facts, projection, snapshot, events, runId } = input;
  const policyErrors = validateAllocation(policy);
  if (policyErrors.length > 0) return err(policyErrors);
  const shapeErrors = checkInputShapes(facts, snapshot, projection);
  if (shapeErrors.length > 0) return err(shapeErrors);

  const body = policy.body;
  const parties = new Set(facts.body.parties.map((p) => p.id));
  const kinds = new Map(facts.body.parties.map((p) => [p.id, p.kind]));

  const errors: Diagnostic[] = [];
  if (!isId(runId)) errors.push(diag("CORE_TYPE_ERROR", "$.run_id", String(runId)));
  errors.push(...checkDigests(policy, facts, projection), ...checkEvents(events, body));
  const members = attempt(() => parseVector(snapshot.members, "$.snapshot.members"));
  if (!members.ok) errors.push(...members.errors);
  else for (const k of Object.keys(members.value)) if (!parties.has(k)) errors.push(diag("FACTS_UNKNOWN_PARTY", `$.snapshot.members.${k}`, k));
  const vectors = attempt(() => parseProjectionVectors(projection));
  if (!vectors.ok) errors.push(...vectors.errors);
  if (!members.ok || !vectors.ok || errors.length > 0) return err(errors);

  errors.push(...checkCoverage(body.tier2.split, vectors.value, members.value));
  const ctx: ExprContext = {
    facts, parties, vectors: vectors.value, members: members.value, asOf: projection.as_of, knownAt: projection.known_at,
  };
  const bucketVectors: PartyVector[] = [];
  body.tier2.split.forEach((b, i) => {
    const r = attempt(() => evalVector(b.vector, ctx, `$.body.tier2.split[${i}].vector`));
    if (r.ok) bucketVectors.push(r.value);
    else errors.push(...r.errors);
  });
  if (errors.length > 0) return err(errors);

  const out: Output = { pool_lines: [], lines: [], holdings: [], trace: [] };
  const lineRole = lineRoles(kinds, vectors.value);
  const allocated = attempt(() => {
    events.forEach((ev, i) => allocateEvent(ev, `$.events[${i}]`, body, bucketVectors, lineRole, out));
  });
  if (!allocated.ok) return err(allocated.errors);
  const result = {
    run_id: runId,
    policy_digest: digestOf(policy),
    projection_digest: projection.digest,
    snapshot_digest: digestOf(snapshot),
    events_digest: digestOf(events),
    bind_time: body.bind.time,
    ...out,
  };
  return ok({ ...result, result_digest: digestOf(result) });
}

/** 입력의 digest를 계산한다. 계산 오류(예: JSON number)는 그 입력의 경로 접두사를 붙여 out에 모은다. */
function digestIn(value: unknown, prefix: string, out: Diagnostic[]): string | undefined {
  const r = attempt(() => digestOf(value));
  if (r.ok) return r.value;
  out.push(...underPath(prefix, r.errors));
  return undefined;
}

function checkDigests(policy: AllocationDocument, facts: FactsDocument, projection: ProjectionIr): Diagnostic[] {
  const out: Diagnostic[] = [];
  const factsDigest = digestIn(facts, "$.facts", out);
  const selfDigest = digestIn({ ...projection, digest: undefined }, "$.projection", out);
  if (factsDigest !== undefined) {
    const factsRef = `vc:facts/${facts.id}@${facts.version}`;
    if (!policy.depends_on.some((d) => d.ref === factsRef && d.digest === factsDigest)) {
      out.push(diag("CORE_DIGEST_MISMATCH", "$.policy.depends_on", `${factsRef} ${factsDigest}`));
    }
    if (projection.facts_digest !== factsDigest) out.push(diag("CORE_DIGEST_MISMATCH", "$.projection.facts_digest", factsDigest));
  }
  if (selfDigest !== undefined && selfDigest !== projection.digest) out.push(diag("CORE_DIGEST_MISMATCH", "$.projection.digest"));
  return out;
}

function checkEvents(events: unknown, body: AllocationBody): Diagnostic[] {
  if (!Array.isArray(events) || events.length === 0) return [diag("CORE_TYPE_ERROR", "$.events", "non-empty array required")];
  const out: Diagnostic[] = [];
  let prev: string | undefined;
  let orderReported = false;
  events.forEach((e: unknown, i: number) => {
    const p = `$.events[${i}]`;
    if (!isPlainObject(e)) {
      out.push(diag("CORE_TYPE_ERROR", p, "must be an object"));
      return;
    }
    out.push(...rejectUnknownKeys(e, EVENT_KEYS, p));
    if (!isId(e.id)) {
      out.push(diag("CORE_TYPE_ERROR", `${p}.id`, String(e.id)));
    } else {
      if (!orderReported && prev !== undefined && prev >= e.id) {
        out.push(diag("CORE_TYPE_ERROR", "$.events", "not sorted by id"));
        orderReported = true;
      }
      prev = e.id;
    }
    if (!isEnumValue("event_type", e.type)) out.push(diag("CORE_ENUM_UNKNOWN", `${p}.type`, String(e.type)));
    else if (!body.scope.events.includes(e.type)) out.push(diag("ALLOC_SCOPE_MISMATCH", `${p}.type`, e.type));
    if (typeof e.amount !== "string" || !AMOUNT_RE.test(e.amount)) out.push(diag("CORE_TYPE_ERROR", `${p}.amount`, String(e.amount)));
    if (typeof e.currency !== "string") out.push(diag("CORE_TYPE_ERROR", `${p}.currency`, String(e.currency)));
    else if (e.currency !== body.scope.currency) out.push(diag("ALLOC_SCOPE_MISMATCH", `${p}.currency`, e.currency));
    if (!isEnumValue("integrity_status", e.integrity)) out.push(diag("CORE_ENUM_UNKNOWN", `${p}.integrity`, String(e.integrity)));
  });
  return out;
}

function parseProjectionVectors(projection: ProjectionIr): Vectors {
  const out: Vectors = {};
  const errors: Diagnostic[] = [];
  for (const [role, vec] of Object.entries(projection.vectors)) {
    const p = `$.projection.vectors.${role}`;
    if (!isEnumValue("claimant_role", role)) {
      errors.push(diag("CORE_ENUM_UNKNOWN", p, role));
      continue;
    }
    const r = attempt(() => parseVector(vec, p));
    if (r.ok) out[role] = r.value;
    else errors.push(...r.errors);
  }
  if (errors.length > 0) throw new VcrlError(errors);
  return out;
}

/** 실제 권리자(`@hold`·가중치 0 제외) 목록. */
const claimantsOf = (vec: PartyVector | undefined): string[] =>
  vec === undefined ? [] : sortedEntries(vec).filter(([k, w]) => k !== HOLD && w.n !== 0n).map(([k]) => k);

/**
 * 커버리지(스펙 12.33): 실제 권리자가 있는 투영 역할마다 그 역할을 다루는 버킷이 있어야 하고,
 * 투영에서 지분이 있는 실연자는 스냅샷 멤버이거나 사용량 기반 실연 소스로 배분되어야 한다.
 */
function checkCoverage(split: readonly SplitBucket[], vectors: Vectors, members: PartyVector): Diagnostic[] {
  const covered = new Set<ClaimantRole>();
  let usageBased = false;
  const visit = (e: VectorExpr): void => {
    switch (e.fn) {
      case "graph":
        covered.add(e.role);
        if (PERFORMER_ROLES.includes(e.role)) usageBased = true;
        break;
      case "performance_pool":
        if (e.mode === "USAGE_WEIGHTED" || e.mode === "HYBRID") usageBased = true;
        for (const r of PERFORMER_ROLES) covered.add(r);
        break;
      case "member_pct":
        for (const r of PERFORMER_ROLES) covered.add(r);
        break;
      case "mix":
        for (const p of e.parts) visit(p.of);
        break;
      case "cap":
      case "floor_guarantee":
        visit(e.of);
        break;
      case "contract":
        break;
    }
  };
  for (const b of split) visit(b.vector);
  const out: Diagnostic[] = [];
  for (const [role, vec] of Object.entries(vectors) as [ClaimantRole, PartyVector][]) {
    if (claimantsOf(vec).length > 0 && !covered.has(role)) out.push(diag("ALLOC_UNCOVERED_CLAIMANT", "$.body.tier2.split", role));
  }
  if (usageBased) return out;
  const seen = new Set<string>();
  // 역할 자체가 다뤄지지 않으면 위에서 이미 보고했다.
  for (const role of PERFORMER_ROLES.filter((r) => covered.has(r))) {
    for (const party of claimantsOf(vectors[role])) {
      if (seen.has(party) || Object.hasOwn(members, party)) continue;
      seen.add(party);
      out.push(diag("ALLOC_UNCOVERED_CLAIMANT", "$.body.tier2.split", `${role}:${party}`));
    }
  }
  return out;
}

type LineRole = (party: string, bucketRole: ClaimantRole) => ClaimantRole;

/**
 * 라인 역할 규칙: (1) CMO·AGENCY kind는 그 역할(스펙 12.16), (2) 실연 버킷이면 투영에서 그 권리자가
 * 한 실연 역할에만 지분이 있을 때 그 역할(스펙 12.34), 둘 다이거나 없으면 버킷 역할, (3) 그 외는 버킷 역할.
 */
function lineRoles(kinds: ReadonlyMap<string, string>, vectors: Vectors): LineRole {
  const [featured, nonFeatured] = PERFORMER_ROLES.map((r) => new Set(claimantsOf(vectors[r])));
  return (party, bucketRole) => {
    const kind = kinds.get(party);
    if (kind === "CMO" || kind === "AGENCY") return kind;
    if (!PERFORMER_ROLES.includes(bucketRole)) return bucketRole;
    const f = featured!.has(party);
    if (f === nonFeatured!.has(party)) return bucketRole;
    return f ? "PERFORMER_FEATURED" : "PERFORMER_NON_FEATURED";
  };
}

/** 이벤트 한 건: id와 입력 배열에서의 진단 경로(`$.events[i]`). */
type EventAt = { id: string; path: string };

function level(out: Output, at: EventAt, name: string, total: bigint, shares: readonly Share[]): Allotment[] {
  const parts = splitLrm(total, shares, `${at.path}.${name}`);
  out.trace.push({
    event_id: at.id,
    level: name,
    total: total.toString(),
    parts: parts.map((p) => ({ key: p.key, weight: formatRatio(p.weight), amount: p.amount.toString() })),
  });
  return parts;
}

function allocateEvent(
  ev: RevenueEvent, path: string, body: AllocationBody, bucketVectors: readonly PartyVector[],
  lineRole: LineRole, out: Output,
): void {
  const at: EventAt = { id: ev.id, path };
  const tier1 = level(out, at, "tier1", BigInt(ev.amount), body.tier1.buckets.map((b) => ({ key: b.name, weight: fromBps(parseBps(b.bps)) })));
  for (const a of tier1) out.pool_lines.push({ event_id: ev.id, bucket: a.key, amount: a.amount.toString() });
  const rights = tier1.find((a) => a.key === body.tier1.rights)!.amount;
  if (ev.integrity === "FLAGGED") {
    if (rights > 0n) out.holdings.push({ event_id: ev.id, bucket: body.tier1.rights, reason: "FRAUD_REVIEW", amount: rights.toString() });
    return;
  }
  const tier2 = level(out, at, "tier2", rights, body.tier2.split.map((b) => ({ key: b.name, weight: fromBps(parseBps(b.bps)) })));
  tier2.forEach((bucketAmount, i) => {
    const bucket = body.tier2.split[i]!;
    const shares = sortedEntries(bucketVectors[i]!).map(([key, weight]) => ({ key, weight }));
    for (const p of level(out, at, `bucket:${bucket.name}`, bucketAmount.amount, shares)) {
      if (p.amount === 0n) continue;
      if (p.key === HOLD) {
        out.holdings.push({ event_id: ev.id, bucket: bucket.name, reason: "RIGHTS_DISPUTE", amount: p.amount.toString() });
      } else {
        out.lines.push({
          event_id: ev.id, party: p.key, role: lineRole(p.key, bucket.role),
          bucket: bucket.name, line_seq: "1", amount: p.amount.toString(),
        });
      }
    }
  });
}
