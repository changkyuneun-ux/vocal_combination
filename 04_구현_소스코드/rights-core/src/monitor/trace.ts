import { iso, type Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";

/**
 * ⑧ 한 건 추적: 원곡 → 녹음·스템 → 조합(발행 봉인) → 매출 → 정산 run·라인 → 지급을 한 응답에 잇는다.
 * 단계마다 봉인 digest·정책 버전·기준 시점을 붙여 금액의 근거를 설명한다. 플랫폼 범위(운영 채널)에서 쓴다.
 */
export async function traceCombination(tx: Tx, vcId: string, onlyEvent?: string) {
  const s = (await tx.query(
    `SELECT s.snapshot_id, s.pack_id, s.policy_id, s.policy_version, s.created_at, i.facts_digest, i.policy_digest, i.projection_digest, i.members_digest, i.as_of,
            p.facts_scope_id, f.work_id, w.title
       FROM rights_snapshot s JOIN issue_seal i ON i.snapshot_id = s.snapshot_id JOIN vocal_pack p ON p.pack_id = s.pack_id
       JOIN facts_scope f ON f.facts_scope_id = p.facts_scope_id JOIN work w ON w.work_id = f.work_id
      WHERE s.vc_id = $1`, [vcId])).rows[0];
  if (s === undefined) throw notFound("combination", vcId);
  const assignments = (await tx.query(
    `SELECT a.slot_id, a.stem_id, a.party_id, a.duration_ms, a.rights_bearing, st.recording_id
       FROM snapshot_stem_assignment a JOIN stem st ON st.stem_id = a.stem_id WHERE a.snapshot_id = $1 ORDER BY a.start_ms, a.slot_id`, [s.snapshot_id])).rows;
  const members = (await tx.query("SELECT party_id, pct_bps FROM snapshot_member_pct WHERE snapshot_id = $1 ORDER BY party_id", [s.snapshot_id])).rows;
  const events = (await tx.query(
    `SELECT event_id, event_type, net_amount_krw::text AS amount, integrity_status, occurred_at FROM revenue_event
      WHERE vc_id = $1 AND ($2::text IS NULL OR event_id = $2) ORDER BY occurred_at, event_id`, [vcId, onlyEvent ?? null])).rows;
  const revenue = [];
  const payees = new Set<string>();
  for (const e of events) {
    const run = (await tx.query(
      `SELECT r.run_id, r.batch_id, r.status, r.result_digest FROM settlement_run_event re JOIN settlement_run r ON r.run_id = re.run_id
        WHERE re.event_id = $1 AND re.active`, [e.event_id])).rows[0];
    const lines = (await tx.query(
      "SELECT party_id, role, bucket, line_kind, amount_krw::text AS amount FROM allocation_line WHERE event_id = $1 ORDER BY line_id", [e.event_id])).rows;
    const holdings = (await tx.query("SELECT reason, bucket, amount_krw::text AS amount FROM unallocated_holding WHERE event_id = $1 ORDER BY holding_id", [e.event_id])).rows;
    const refunds = (await tx.query("SELECT event_id, net_amount_krw::text AS amount, occurred_at FROM revenue_event WHERE related_event_id = $1 ORDER BY occurred_at", [e.event_id])).rows;
    for (const l of lines) payees.add(l.party_id as string);
    revenue.push({
      eventId: e.event_id as string, type: e.event_type as string, amountKrw: e.amount as string, integrity: e.integrity_status as string, occurredAt: iso(e.occurred_at)!,
      ...(run && { run: { runId: run.run_id as string, batchId: run.batch_id as string, status: run.status as string, resultDigest: run.result_digest as string | null } }),
      lines: lines.map((l) => ({ partyId: l.party_id as string, role: l.role as string, bucket: l.bucket as string, kind: l.line_kind as string, amountKrw: l.amount as string })),
      holdings: holdings.map((h) => ({ reason: h.reason as string, bucket: h.bucket as string, amountKrw: h.amount as string })),
      refunds: refunds.map((r) => ({ eventId: r.event_id as string, amountKrw: r.amount as string, occurredAt: iso(r.occurred_at)! })),
    });
  }
  const payouts = (await tx.query(
    `SELECT party_id, instruction_id, payout_run_id, status, net_krw::text AS net FROM payout_instruction WHERE party_id = ANY($1) ORDER BY party_id, created_at`, [[...payees]])).rows;
  return {
    vcId,
    song: { workId: s.work_id as string, title: s.title as string, factsScopeId: s.facts_scope_id as string },
    issue: {
      snapshotId: s.snapshot_id as string, packId: s.pack_id as string, policy: `${s.policy_id}@${s.policy_version}`, issuedAt: iso(s.created_at)!, asOf: iso(s.as_of)!,
      seal: { facts: s.facts_digest as string, policy: s.policy_digest as string, projection: s.projection_digest as string, members: s.members_digest as string },
    },
    assignments: assignments.map((a) => ({ slotId: a.slot_id as string, stemId: a.stem_id as string, recordingId: a.recording_id as string, performer: a.party_id as string | null, durationMs: a.duration_ms as number, rightsBearing: a.rights_bearing as boolean })),
    members: members.map((m) => ({ partyId: m.party_id as string, bps: m.pct_bps as number })),
    revenue,
    payouts: payouts.map((p) => ({ partyId: p.party_id as string, instructionId: p.instruction_id as string, payoutRunId: p.payout_run_id as string, status: p.status as string, netKrw: p.net as string })),
  };
}

/** 매출 이벤트 한 건에서 시작한다(환불이면 원 구매로 거슬러 간다). */
export async function traceEvent(tx: Tx, eventId: string) {
  const e = (await tx.query("SELECT event_id, vc_id, related_event_id FROM revenue_event WHERE event_id = $1", [eventId])).rows[0];
  if (e === undefined) throw notFound("revenue event", eventId);
  const origin = e.related_event_id === null ? e : (await tx.query("SELECT event_id, vc_id FROM revenue_event WHERE event_id = $1", [e.related_event_id])).rows[0];
  return { start: { eventId }, ...(await traceCombination(tx, origin.vc_id as string, origin.event_id as string)) };
}

/** 파티에서 시작한다: 이 파티가 부른 조합, 받은 정산 라인 합계, 지급. */
export async function traceParty(tx: Tx, partyId: string) {
  const p = (await tx.query("SELECT party_id, party_type, display_name, tenant_id FROM party WHERE party_id = $1", [partyId])).rows[0];
  if (p === undefined) throw notFound("party", partyId);
  const performed = (await tx.query(
    `SELECT DISTINCT s.vc_id, s.snapshot_id, s.created_at FROM snapshot_stem_assignment a JOIN rights_snapshot s ON s.snapshot_id = a.snapshot_id
      WHERE a.party_id = $1 ORDER BY s.created_at, s.vc_id`, [partyId])).rows;
  const lines = (await tx.query(
    "SELECT line_kind, role, count(*)::int AS n, sum(amount_krw)::text AS amount FROM allocation_line WHERE party_id = $1 GROUP BY line_kind, role ORDER BY line_kind, role", [partyId])).rows;
  const payouts = (await tx.query(
    "SELECT instruction_id, payout_run_id, status, gross_krw::text AS gross, net_krw::text AS net FROM payout_instruction WHERE party_id = $1 ORDER BY created_at", [partyId])).rows;
  return {
    party: { partyId, partyType: p.party_type as string, displayName: p.display_name as string, tenantId: p.tenant_id as string },
    performedIn: performed.map((r) => ({ vcId: r.vc_id as string, snapshotId: r.snapshot_id as string, issuedAt: iso(r.created_at)! })),
    lines: lines.map((l) => ({ kind: l.line_kind as string, role: l.role as string, count: l.n as number, amountKrw: l.amount as string })),
    payouts: payouts.map((r) => ({ instructionId: r.instruction_id as string, payoutRunId: r.payout_run_id as string, status: r.status as string, grossKrw: r.gross as string, netKrw: r.net as string })),
  };
}
