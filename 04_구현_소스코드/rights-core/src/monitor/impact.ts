import { iso, type Tx } from "../platform/db.ts";
import { DomainError, notFound } from "../platform/errors.ts";

/**
 * ⑧ 영향 분석: 동의 철회·분쟁·권리 주장 변경이 닿는 범위를 계산한다(역방향 의존성: 곡 → 팩 → 발행 조합 → 매출 → 정산 라인).
 * - 동의 철회: 그 파티의 스템을 쓴 발행 조합만.
 * - 분쟁·주장: 그 곡(facts 범위)의 모든 발행 조합(facts가 바뀌면 곡 전체의 기여 벡터가 바뀔 수 있다).
 * 미확정 매출은 보류 대상, 확정된 정산 라인은 역분개 검토 대상으로 가른다. 실제 보류·역분개는 정산 담당이 결정한다.
 */
export async function impactOf(tx: Tx, q: { consent?: string; dispute?: string; claim?: string }) {
  let subject: { kind: string; id: string; factsScopeId: string; partyId?: string };
  if (q.consent !== undefined) {
    const c = (await tx.query("SELECT facts_scope_id, party_id, revoked_at FROM consent_agreement WHERE consent_id = $1", [q.consent])).rows[0];
    if (c === undefined) throw notFound("consent", q.consent);
    subject = { kind: "consent", id: q.consent, factsScopeId: c.facts_scope_id, partyId: c.party_id };
  } else if (q.dispute !== undefined) {
    const d = (await tx.query("SELECT facts_scope_id FROM dispute WHERE dispute_id = $1", [q.dispute])).rows[0];
    if (d === undefined) throw notFound("dispute", q.dispute);
    subject = { kind: "dispute", id: q.dispute, factsScopeId: d.facts_scope_id };
  } else if (q.claim !== undefined) {
    const c = (await tx.query("SELECT facts_scope_id FROM right_claim WHERE claim_id = $1 LIMIT 1", [q.claim])).rows[0];
    if (c === undefined) throw notFound("claim", q.claim);
    subject = { kind: "claim", id: q.claim, factsScopeId: c.facts_scope_id };
  } else {
    throw new DomainError("BAD_REQUEST", 400, "one of consent, dispute or claim is required");
  }
  const combos = (await tx.query(
    `SELECT DISTINCT s.snapshot_id, s.vc_id, s.created_at FROM rights_snapshot s JOIN vocal_pack p ON p.pack_id = s.pack_id
       LEFT JOIN snapshot_stem_assignment a ON a.snapshot_id = s.snapshot_id
      WHERE p.facts_scope_id = $1 AND ($2::text IS NULL OR a.party_id = $2) ORDER BY s.created_at, s.vc_id`,
    [subject.factsScopeId, subject.partyId ?? null])).rows;
  const vcs = combos.map((c) => c.vc_id as string);
  const events = (await tx.query(
    `SELECT e.event_id, e.vc_id, e.net_amount_krw::text AS amount,
            EXISTS (SELECT 1 FROM settlement_run_event re JOIN settlement_run r ON r.run_id = re.run_id
                     WHERE re.event_id = e.event_id AND re.active AND r.status = 'CONFIRMED') AS settled
       FROM revenue_event e WHERE e.vc_id = ANY($1) AND e.event_type <> 'REFUND' ORDER BY e.occurred_at, e.event_id`, [vcs])).rows;
  const unsettled = events.filter((e) => !e.settled);
  const settledIds = events.filter((e) => e.settled).map((e) => e.event_id as string);
  const byParty = (await tx.query(
    "SELECT party_id, sum(amount_krw)::text AS amount, count(*)::int AS n FROM allocation_line WHERE event_id = ANY($1) GROUP BY party_id ORDER BY party_id", [settledIds])).rows;
  const stopped = q.consent === undefined ? [] : (await tx.query(
    "SELECT DISTINCT s.vc_id FROM exposure_hold h JOIN rights_snapshot s ON s.snapshot_id = h.snapshot_id WHERE h.consent_id = $1 AND h.released_at IS NULL ORDER BY s.vc_id", [q.consent])).rows.map((r) => r.vc_id as string);
  const sum = (rows: { amount: string }[]) => rows.reduce((a, r) => a + BigInt(r.amount), 0n).toString();
  return {
    subject,
    combinations: combos.map((c) => ({ vcId: c.vc_id as string, snapshotId: c.snapshot_id as string, issuedAt: iso(c.created_at)! })),
    exposure: { reason: "이 동의 철회로 노출이 멈춘 조합(다시 동의하면 풀린다)", stopped },
    hold: { reason: "미확정 매출: 다음 정산에서 보류", count: unsettled.length, amountKrw: sum(unsettled), events: unsettled.map((e) => e.event_id as string) },
    reverseReview: {
      reason: "확정된 정산 라인: 권리자 판정에 따라 역분개 검토", count: settledIds.length, amountKrw: sum(events.filter((e) => e.settled)),
      byParty: byParty.map((r) => ({ partyId: r.party_id as string, lines: r.n as number, amountKrw: r.amount as string })),
    },
  };
}
