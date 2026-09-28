import { parseBps } from "../core/bps.ts";
import { digestOf } from "../core/digest.ts";
import { isEnumValue } from "../core/enums.ts";
import { attempt, diag, err, ok, VcrlError, type Diagnostic, type Result } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { formatRatio, fromBps } from "../core/ratio.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";
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
import { validateAllocation } from "./validate.ts";
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
const PERFORMER_ROLES: readonly ClaimantRole[] = ["PERFORMER_FEATURED", "PERFORMER_NON_FEATURED"];

/** attempt()로 감싼 진단 목록 계산. 성공이면 그 값을, 예외로 실패하면 그 진단을 돌려준다(둘 다 던지지 않는다). */
function collectDiag(fn: () => Diagnostic[]): Diagnostic[] {
  const r = attempt(fn);
  return r.ok ? r.value : r.errors;
}

/** evaluate 본문이 facts·snapshot·projection을 역참조하기 전에, 그것들이 최소한의 모양을 갖췄는지 본다. */
function checkInputShapes(facts: unknown, snapshot: unknown, projection: unknown): Diagnostic[] {
  const out: Diagnostic[] = [...validateFactsStructure(facts)];
  if (!isPlainObject(snapshot)) out.push(diag("CORE_TYPE_ERROR", "$.snapshot", "must be an object"));
  else out.push(...rejectUnknownKeys(snapshot, ["members"], "$.snapshot"));
  if (!isPlainObject(projection)) out.push(diag("CORE_TYPE_ERROR", "$.projection", "must be an object"));
  else if (!isPlainObject(projection.vectors)) out.push(diag("CORE_TYPE_ERROR", "$.projection.vectors", "must be an object"));
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
  errors.push(...collectDiag(() => checkDigests(policy, facts, projection)), ...checkEvents(events, body));
  const members = attempt(() => parseVector(snapshot.members, "$.snapshot.members"));
  if (!members.ok) errors.push(...members.errors);
  else for (const k of Object.keys(members.value)) if (!parties.has(k)) errors.push(diag("FACTS_UNKNOWN_PARTY", `$.snapshot.members.${k}`, k));
  const vectors = attempt(() => parseProjectionVectors(projection));
  if (!vectors.ok) errors.push(...vectors.errors);
  if (!members.ok || !vectors.ok || errors.length > 0) return err(errors);

  errors.push(...checkCoverage(body.tier2.split, vectors.value));
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
  const allocated = attempt(() => {
    for (const ev of events) allocateEvent(ev, body, bucketVectors, kinds, out);
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

function checkDigests(policy: AllocationDocument, facts: FactsDocument, projection: ProjectionIr): Diagnostic[] {
  const out: Diagnostic[] = [];
  const factsDigest = digestOf(facts);
  const factsRef = `vc:facts/${facts.id}@${facts.version}`;
  if (!policy.depends_on.some((d) => d.ref === factsRef && d.digest === factsDigest)) {
    out.push(diag("CORE_DIGEST_MISMATCH", "$.policy.depends_on", `${factsRef} ${factsDigest}`));
  }
  if (projection.facts_digest !== factsDigest) out.push(diag("CORE_DIGEST_MISMATCH", "$.projection.facts_digest", factsDigest));
  if (digestOf({ ...projection, digest: undefined }) !== projection.digest) out.push(diag("CORE_DIGEST_MISMATCH", "$.projection.digest"));
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

/** 실제 권리자(`@hold`·가중치 0 제외)가 있는 투영 역할마다 그 역할을 다루는 버킷이 있어야 한다. */
function checkCoverage(split: readonly SplitBucket[], vectors: Vectors): Diagnostic[] {
  const covered = new Set<ClaimantRole>();
  const visit = (e: VectorExpr): void => {
    switch (e.fn) {
      case "graph":
        covered.add(e.role);
        break;
      case "performance_pool":
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
    const real = Object.entries(vec).some(([k, w]) => k !== HOLD && w.n !== 0n);
    if (real && !covered.has(role)) out.push(diag("ALLOC_UNCOVERED_CLAIMANT", "$.body.tier2.split", role));
  }
  return out;
}

/** 위임 수령인의 역할 규칙(스펙 12.16): CMO·AGENCY는 그 역할, 그 외는 버킷 역할. */
function lineRole(kind: string | undefined, role: ClaimantRole): ClaimantRole {
  return kind === "CMO" || kind === "AGENCY" ? kind : role;
}

function level(out: Output, eventId: string, name: string, total: bigint, shares: readonly Share[]): Allotment[] {
  const parts = splitLrm(total, shares, `$.events.${eventId}.${name}`);
  out.trace.push({
    event_id: eventId,
    level: name,
    total: total.toString(),
    parts: parts.map((p) => ({ key: p.key, weight: formatRatio(p.weight), amount: p.amount.toString() })),
  });
  return parts;
}

function allocateEvent(
  ev: RevenueEvent, body: AllocationBody, bucketVectors: readonly PartyVector[],
  kinds: ReadonlyMap<string, string>, out: Output,
): void {
  const tier1 = level(out, ev.id, "tier1", BigInt(ev.amount), body.tier1.buckets.map((b) => ({ key: b.name, weight: fromBps(parseBps(b.bps)) })));
  for (const a of tier1) out.pool_lines.push({ event_id: ev.id, bucket: a.key, amount: a.amount.toString() });
  const rights = tier1.find((a) => a.key === body.tier1.rights)!.amount;
  if (ev.integrity === "FLAGGED") {
    if (rights > 0n) out.holdings.push({ event_id: ev.id, bucket: body.tier1.rights, reason: "FRAUD_REVIEW", amount: rights.toString() });
    return;
  }
  const tier2 = level(out, ev.id, "tier2", rights, body.tier2.split.map((b) => ({ key: b.name, weight: fromBps(parseBps(b.bps)) })));
  tier2.forEach((bucketAmount, i) => {
    const bucket = body.tier2.split[i]!;
    const shares = sortedEntries(bucketVectors[i]!).map(([key, weight]) => ({ key, weight }));
    for (const p of level(out, ev.id, `bucket:${bucket.name}`, bucketAmount.amount, shares)) {
      if (p.amount === 0n) continue;
      if (p.key === HOLD) {
        out.holdings.push({ event_id: ev.id, bucket: bucket.name, reason: "RIGHTS_DISPUTE", amount: p.amount.toString() });
      } else {
        out.lines.push({
          event_id: ev.id, party: p.key, role: lineRole(kinds.get(p.key), bucket.role),
          bucket: bucket.name, line_seq: "1", amount: p.amount.toString(),
        });
      }
    }
  });
}
