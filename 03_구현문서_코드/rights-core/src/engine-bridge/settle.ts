import { evaluate, verifyAllocationResult, type AllocationDocument, type AllocationResult, type RevenueEvent, type Snapshot } from "vcrl/allocation";
import type { ProjectionIr } from "vcrl/facts";
import type { Tx } from "../platform/db.ts";
import { notFound, type Diagnostic } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadFacts } from "./facts.ts";
import { loadSealed, sealDocument } from "./seal-store.ts";
import { iso } from "../platform/db.ts";

export type RunEvent = { eventId: string; type: "PRIMARY" | "RESALE"; amount: bigint; integrity: "CLEAR" | "FLAGGED" };
export type RunRows = {
  pool: { eventId: string; bucket: string; amount: bigint }[];
  lines: { eventId: string; party: string; role: string; bucket: string; lineSeq: number; amount: bigint }[];
  holdings: { eventId: string; bucket: string; reason: "RIGHTS_DISPUTE" | "FRAUD_REVIEW"; amount: bigint }[];
};
export type RunEvaluation = { ok: true; eventsDigest: string; resultDigest: string; rows: RunRows } | { ok: false; diagnostics: Diagnostic[] };

type SealInputs = { policy: AllocationDocument; facts: Awaited<ReturnType<typeof loadFacts>>; projection: ProjectionIr; snapshot: Snapshot; asOf: string; knownAt: string };

export async function sealInputs(ctx: BridgeCtx, tx: Tx, snapshotId: string): Promise<SealInputs> {
  const s = (await tx.query("SELECT * FROM issue_seal WHERE snapshot_id = $1", [snapshotId])).rows[0];
  if (s === undefined) throw notFound("issue seal", snapshotId);
  return {
    policy: (await loadSealed(ctx, tx, s.policy_digest)) as AllocationDocument,
    facts: await loadFacts(ctx, tx, s.facts_digest),
    projection: (await loadSealed(ctx, tx, s.projection_digest)) as ProjectionIr,
    snapshot: (await loadSealed(ctx, tx, s.members_digest)) as Snapshot,
    asOf: iso(s.as_of)!, knownAt: iso(s.known_at)!,
  };
}

const toIr = (events: readonly RunEvent[], currency: string): RevenueEvent[] =>
  [...events].sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)).map((e) => ({
    id: e.eventId, type: e.type, amount: e.amount.toString(), currency, integrity: e.integrity,
  }));

function rowsOf(r: AllocationResult): RunRows {
  return {
    pool: r.pool_lines.map((p) => ({ eventId: p.event_id, bucket: p.bucket, amount: BigInt(p.amount) })),
    lines: r.lines.map((l) => ({ eventId: l.event_id, party: l.party, role: l.role, bucket: l.bucket, lineSeq: Number(l.line_seq), amount: BigInt(l.amount) })),
    holdings: r.holdings.map((h) => ({ eventId: h.event_id, bucket: h.bucket, reason: h.reason, amount: BigInt(h.amount) })),
  };
}

/** 발행 봉인의 입력과 고정된 순액 이벤트로 vcrl evaluate를 돌리고 events·결과를 봉인한다(통합 설계 10.2-5). */
export async function evaluateRun(ctx: BridgeCtx, tx: Tx, input: { runId: string; snapshotId: string; events: RunEvent[] }): Promise<RunEvaluation> {
  const s = await sealInputs(ctx, tx, input.snapshotId);
  const events = toIr(input.events, s.policy.body.scope.currency);
  const r = evaluate({ policy: s.policy, facts: s.facts, projection: s.projection, snapshot: s.snapshot, events, runId: input.runId });
  if (!r.ok) return { ok: false, diagnostics: r.errors };
  const ev = await sealDocument(ctx, tx, { kind: "events", value: events, docId: input.runId });
  const res = await sealDocument(ctx, tx, { kind: "allocation_result", value: r.value, docId: input.runId, format: r.value.format });
  return { ok: true, eventsDigest: ev.digest, resultDigest: res.digest, rows: rowsOf(r.value) };
}

/** 봉인된 입력·스냅샷 사용량·발행 봉인 기준 시점으로 vcrl verifyAllocationResult를 돌린다(통합 설계 10.2-6). */
export async function verifyRun(ctx: BridgeCtx, tx: Tx, input: { runId: string; snapshotId: string; eventsDigest: string; resultDigest: string }): Promise<Diagnostic[]> {
  const s = await sealInputs(ctx, tx, input.snapshotId);
  const events = (await loadSealed(ctx, tx, input.eventsDigest)) as RevenueEvent[];
  const given = await loadSealed(ctx, tx, input.resultDigest);
  const usage: Record<string, string> = {};
  const rows = (await tx.query(
    "SELECT stem_id, SUM(duration_ms)::text AS ms FROM snapshot_stem_assignment WHERE snapshot_id = $1 AND rights_bearing GROUP BY stem_id ORDER BY stem_id",
    [input.snapshotId],
  )).rows;
  for (const r of rows) usage[r.stem_id] = r.ms;
  return verifyAllocationResult({ policy: s.policy, facts: s.facts, snapshot: s.snapshot, events: [...events], runId: input.runId, usage, asOf: s.asOf, knownAt: s.knownAt }, given);
}
