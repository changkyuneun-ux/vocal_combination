import type { Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { cursorKey, pageOf, ts, type Page } from "../platform/paging.ts";

const INSTRUCTION_STATUSES = ["PENDING", "SUBMITTED", "PAID", "FAILED", "CARRIED", "HELD"] as const;
const numOrNull = (v: unknown): number | null => (v === null ? null : Number(v));

export async function getPayoutPolicy(tx: Tx) {
  const r = (await tx.query("SELECT * FROM payout_policy WHERE policy_id = 'default'")).rows[0];
  if (r === undefined) throw notFound("payout policy", "default");
  return {
    policyId: r.policy_id as string, minPayoutKrw: String(r.min_payout_krw), initialHoldDays: r.initial_hold_days as number,
    taxBps: r.tax_bps as unknown, accountCoolingHours: r.account_cooling_hours as number,
  };
}

/** coolingUntil = account_changed_at + account_cooling_hours (계좌를 바꾼 적이 없으면 null). */
export async function getPayoutProfile(tx: Tx, partyId: string) {
  const r = (await tx.query(
    `SELECT f.*, f.account_changed_at + make_interval(hours => p.account_cooling_hours) AS cooling_until
       FROM party_payout_profile f CROSS JOIN payout_policy p WHERE f.party_id = $1 AND p.policy_id = 'default'`, [partyId],
  )).rows[0];
  if (r === undefined) throw notFound("payout profile", partyId);
  return {
    partyId: r.party_id as string, taxType: r.tax_type as string, payoutAccountRef: r.payout_account_ref as string | null,
    kycVerified: r.kyc_verified as boolean, firstPayableAt: ts(r.first_payable_at)!, updatedAt: ts(r.updated_at)!,
    accountChangedAt: ts(r.account_changed_at), accountChangedBy: r.account_changed_by as string | null, coolingUntil: ts(r.cooling_until),
  };
}

/** created_at DESC, payout_run_id ASC. statusCounts는 지시 상태별 개수(모든 상태 키, 0 포함). */
export async function listPayoutRuns(tx: Tx, page: Page) {
  const after = cursorKey(page, ["t", "s"]);
  const p: unknown[] = [];
  let where = "";
  if (after) {
    p.push(after[0], after[1]);
    where = `WHERE (r.created_at < $1::timestamptz OR (r.created_at = $1::timestamptz AND r.payout_run_id > $2))`;
  }
  p.push(page.limit + 1);
  const counts = INSTRUCTION_STATUSES.map((s) => `count(*) FILTER (WHERE i.status = '${s}')::int AS "${s}"`).join(", ");
  const rows = (await tx.query(
    `SELECT r.*, c.* FROM payout_run r CROSS JOIN LATERAL (SELECT ${counts} FROM payout_instruction i WHERE i.payout_run_id = r.payout_run_id) c
      ${where} ORDER BY r.created_at DESC, r.payout_run_id LIMIT $${p.length}`, p,
  )).rows;
  return pageOf(rows.map((r) => ({
    payoutRunId: r.payout_run_id as string, asOf: ts(r.as_of)!, createdBy: r.created_by as string, createdAt: ts(r.created_at)!,
    statusCounts: Object.fromEntries(INSTRUCTION_STATUSES.map((s) => [s, r[s] as number])) as Record<(typeof INSTRUCTION_STATUSES)[number], number>,
  })), page, (r) => [r.createdAt, r.payoutRunId]);
}

const instructionOut = (r: Record<string, any>) => ({
  instructionId: r.instruction_id as string, payoutRunId: r.payout_run_id as string, partyId: r.party_id as string,
  grossKrw: String(r.gross_krw), withholdingKrw: String(r.withholding_krw), netKrw: String(r.net_krw), status: r.status as string,
  holdReason: r.hold_reason as string | null, idempotencyKey: r.idempotency_key as string, providerRef: r.provider_ref as string | null,
  entryId: numOrNull(r.entry_id), settledEntryId: numOrNull(r.settled_entry_id), submitAttemptedAt: ts(r.submit_attempted_at),
  submitUnknownAt: ts(r.submit_unknown_at), submittedAccountRef: r.submitted_account_ref as string | null,
  decidedAccountRef: r.decided_account_ref as string | null, createdAt: ts(r.created_at)!,
});

/** instruction_id ASC. 지급 실행이 없으면 404. */
export async function listInstructions(tx: Tx, runId: string, f: { status?: string }, page: Page) {
  const after = cursorKey(page, ["s"]);
  const r0 = await tx.query("SELECT 1 FROM payout_run WHERE payout_run_id = $1", [runId]);
  if (r0.rowCount === 0) throw notFound("payout run", runId);
  const p: unknown[] = [runId];
  const w: string[] = ["payout_run_id = $1"];
  if (f.status !== undefined) { p.push(f.status); w.push(`status = $${p.length}`); }
  if (after) { p.push(after[0]); w.push(`instruction_id > $${p.length}`); }
  p.push(page.limit + 1);
  const rows = (await tx.query(`SELECT * FROM payout_instruction WHERE ${w.join(" AND ")} ORDER BY instruction_id LIMIT $${p.length}`, p)).rows;
  return pageOf(rows.map(instructionOut), page, (r) => [r.instructionId]);
}

/** 지시 + PSP webhook(provider_ref 일치, received_at 순) + 감사 행(entity_id = 지시 id, audit_id 순). */
export async function getPayout(tx: Tx, instructionId: string) {
  const r = (await tx.query("SELECT * FROM payout_instruction WHERE instruction_id = $1", [instructionId])).rows[0];
  if (r === undefined) throw notFound("payout instruction", instructionId);
  const hooks = r.provider_ref === null ? [] : (await tx.query(
    "SELECT * FROM psp_webhook_inbox WHERE provider_ref = $1 ORDER BY received_at, provider_event_id", [r.provider_ref],
  )).rows;
  const audits = (await tx.query("SELECT * FROM audit_log WHERE entity_id = $1 ORDER BY audit_id", [instructionId])).rows;
  return {
    ...instructionOut(r),
    webhooks: hooks.map((h) => ({
      providerEventId: h.provider_event_id as string, providerRef: h.provider_ref as string, status: h.status as string,
      payload: h.payload as unknown, receivedAt: ts(h.received_at)!, processedAt: ts(h.processed_at),
    })),
    audit: audits.map((a) => ({
      auditId: Number(a.audit_id), occurredAt: ts(a.occurred_at)!, actor: a.actor_user_id as string, action: a.action_name as string,
      entityType: a.entity_type as string, entityId: a.entity_id as string, after: a.after_json as unknown,
    })),
  };
}
