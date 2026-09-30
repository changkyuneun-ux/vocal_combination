import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Db, Tx } from "../platform/db.ts";
import { conflict, invalid, notFound } from "../platform/errors.ts";
import type { Jobs } from "../platform/jobs.ts";
import { postEntry } from "../ledger/journal.ts";
import { decide, loadPayoutPolicy, TAX_TYPES, type HoldReason, type ProfileView, type TaxType } from "./policy.ts";

export type PayoutDeps = { db: Db; clock: Clock; jobs: Jobs };
export type InstructionStatus = "PENDING" | "CARRIED" | "HELD";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** '_'는 instruction_id(po_<run>_<party>)의 구분자이므로 run id에 허용하지 않는다(지시 id가 모호해지지 않도록). */
const RUN_ID = /^[A-Za-z0-9.-]{1,100}$/;

/**
 * 지급 프로필(통합 설계 11.2-6, SPACE_SETTLE): 없으면 만들고(first_payable_at = 지금), 있으면 세금 유형·계좌 토큰·KYC·수정 시각만 바꾼다.
 * payoutAccountRef를 생략하면 기존 값을 두고, null이면 지운다. 계좌 토큰은 PSP 쪽 토큰이다(원문 계좌번호가 아니다).
 */
export async function setPayoutProfile(tx: Tx, clock: Clock, actor: Actor,
  input: { partyId: string; taxType: string; payoutAccountRef?: string | null; kycVerified: boolean }) {
  requireRole(actor, "SPACE_SETTLE");
  if (!TAX_TYPES.includes(input.taxType as TaxType)) throw invalid("INVALID_TAX_TYPE", `taxType must be one of ${TAX_TYPES.join(", ")}`);
  if (typeof input.kycVerified !== "boolean") throw invalid("INVALID_KYC", "kycVerified must be a boolean");
  const ref = input.payoutAccountRef;
  if (ref !== undefined && ref !== null && (typeof ref !== "string" || ref.length === 0 || ref.length > 200)) {
    throw invalid("INVALID_ACCOUNT_REF", "payoutAccountRef must be a non-empty token of at most 200 characters, or null");
  }
  const party = (await tx.query("SELECT party_type FROM party WHERE party_id = $1", [input.partyId])).rows[0];
  if (party === undefined) throw notFound("party", input.partyId);
  if (party.party_type === "FAN" || party.party_type === "PLATFORM") throw invalid("INVALID_PARTY", `${input.partyId} is not a rights holder party`);
  const now = clock.now();
  const r = (await tx.query(
    `INSERT INTO party_payout_profile (party_id, tax_type, payout_account_ref, kyc_verified, first_payable_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (party_id) DO UPDATE SET tax_type = EXCLUDED.tax_type,
       payout_account_ref = CASE WHEN $6 THEN party_payout_profile.payout_account_ref ELSE EXCLUDED.payout_account_ref END,
       kyc_verified = EXCLUDED.kyc_verified, updated_at = EXCLUDED.updated_at
     RETURNING first_payable_at, payout_account_ref`,
    [input.partyId, input.taxType, ref ?? null, input.kycVerified, now, ref === undefined])).rows[0];
  const view = { partyId: input.partyId, taxType: input.taxType, hasAccount: r.payout_account_ref !== null, kycVerified: input.kycVerified, firstPayableAt: (r.first_payable_at as Date).toISOString() };
  await audit(tx, clock, { actor: actor.userId, action: "PAYOUT_PROFILE_SET", entityType: "party_payout_profile", entityId: input.partyId, after: view });
  return view;
}

/**
 * 지급 실행(통합 설계 11.2-6, SPACE_SETTLE): PARTY_PAYABLE 계정이 있는 권리자마다 지시 하나를 만든다. 한 트랜잭션.
 * 총액 = 미지급금 부채 잔액(asOf 이전 전기의 −합). 단 이미 쓴 PAYOUT·PAYOUT_FAILED 분개는 시각과 무관하게 넣는다 —
 * 앞선 지급의 분개가 이번 asOf보다 늦게 기록됐어도 같은 잔액을 두 번 지급하지 않는다.
 * HELD·CARRIED는 분개하지 않는다(잔액이 그대로 이월된다). PENDING은 분개 PAYOUT과 submit-payout 작업을 같은 트랜잭션에서 쓴다.
 * 동시 실행은 트랜잭션 advisory lock(payout:run)으로 직렬화한다 — 뒤 실행은 앞 실행의 PAYOUT을 본 뒤 잔액을 읽는다.
 * asOf는 이전 실행들의 최대 asOf보다 앞설 수 없다(422 AS_OF_REGRESSED — 잠금 안에서 검사).
 */
export async function createPayoutRun(d: PayoutDeps, actor: Actor, input: { payoutRunId: string; asOf: string }) {
  requireRole(actor, "SPACE_SETTLE");
  if (typeof input.payoutRunId !== "string" || !RUN_ID.test(input.payoutRunId) || input.payoutRunId === "__proto__") {
    throw invalid("INVALID_ID", "payoutRunId must match [A-Za-z0-9.-]{1,100} (no '_')");
  }
  if (typeof input.asOf !== "string" || !INSTANT.test(input.asOf) || new Date(input.asOf).toISOString() !== input.asOf) {
    throw invalid("INVALID_INSTANT", `${input.asOf} must be ms UTC ISO`);
  }
  return d.db.tx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('payout:run', 0))");
    const now = d.clock.now();
    // 미래 기준 시각은 초기 보류를 앞당기므로 거부한다.
    if (input.asOf > now) throw invalid("INVALID_AS_OF", `asOf ${input.asOf} is after now ${now}`);
    // 기준 시각은 뒤로 가지 않는다: 앞 실행의 asOf 뒤에 기록된 환수(역분개)가 이전 asOf로는 빠져 이미 환수한 돈을 다시 지급하게 된다.
    const last = (await tx.query("SELECT max(as_of) AS m FROM payout_run")).rows[0].m as Date | null;
    if (last !== null && input.asOf < last.toISOString()) {
      throw invalid("AS_OF_REGRESSED", `asOf ${input.asOf} is before the latest payout run asOf ${last.toISOString()}`);
    }
    try {
      await tx.query("INSERT INTO payout_run (payout_run_id, as_of, created_by, created_at) VALUES ($1,$2,$3,$4)", [input.payoutRunId, input.asOf, actor.userId, now]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw conflict("PAYOUT_RUN_EXISTS", `payout run ${input.payoutRunId} already exists`);
      throw err;
    }
    const policy = await loadPayoutPolicy(tx);
    const balances = (await tx.query(
      `SELECT a.party_id,
              COALESCE(SUM(p.amount_krw) FILTER (WHERE j.occurred_at < $1 OR j.kind IN ('PAYOUT','PAYOUT_FAILED')), 0)::text AS s
         FROM ledger_account a LEFT JOIN posting p USING (account_id) LEFT JOIN journal_entry j USING (entry_id)
        WHERE a.kind = 'PARTY_PAYABLE' GROUP BY a.party_id ORDER BY a.party_id`, [input.asOf])).rows;
    const parties = balances.map((b) => b.party_id as string);
    const profiles = new Map<string, ProfileView>((await tx.query(
      "SELECT party_id, tax_type, payout_account_ref, kyc_verified, first_payable_at FROM party_payout_profile WHERE party_id = ANY($1)", [parties])).rows
      .map((r) => [r.party_id as string, { taxType: r.tax_type, payoutAccountRef: r.payout_account_ref, kycVerified: r.kyc_verified, firstPayableAt: (r.first_payable_at as Date).toISOString() }]));

    const rows: { instructionId: string; partyId: string; gross: bigint; withholding: bigint; status: InstructionStatus; holdReason: HoldReason | null; entryId: string | null }[] = [];
    for (const b of balances) {
      const partyId = b.party_id as string;
      const gross = -BigInt(b.s);
      const instructionId = `po_${input.payoutRunId}_${partyId}`;
      const v = decide(policy, input.asOf, gross, profiles.get(partyId));
      if (v.status !== "PENDING") {
        rows.push({ instructionId, partyId, gross, withholding: 0n, status: v.status, holdReason: v.status === "HELD" ? v.reason : null, entryId: null });
        continue;
      }
      const e = await postEntry(tx, d.clock, {
        kind: "PAYOUT", sourceRef: `payout:${instructionId}`, createdBy: actor.userId,
        postings: [
          { account: { kind: "PARTY_PAYABLE", partyId }, amount: gross },
          { account: { kind: "WITHHOLDING_TAX" }, amount: -v.withholding },
          { account: { kind: "PSP_CLEARING" }, amount: -(gross - v.withholding) },
        ],
      });
      rows.push({ instructionId, partyId, gross, withholding: v.withholding, status: "PENDING", holdReason: null, entryId: e.entryId });
    }
    if (rows.length > 0) {
      await tx.query(
        `INSERT INTO payout_instruction (instruction_id, payout_run_id, party_id, gross_krw, withholding_krw, net_krw, status, hold_reason, idempotency_key, entry_id, created_at)
         SELECT i, $1, p, g, w, g - w, s, h, 'payout:' || i, e, $2
           FROM unnest($3::text[], $4::text[], $5::bigint[], $6::bigint[], $7::text[], $8::text[], $9::bigint[]) AS t(i, p, g, w, s, h, e)`,
        [input.payoutRunId, now, rows.map((r) => r.instructionId), rows.map((r) => r.partyId), rows.map((r) => r.gross.toString()),
          rows.map((r) => r.withholding.toString()), rows.map((r) => r.status), rows.map((r) => r.holdReason), rows.map((r) => r.entryId)],
      );
    }
    for (const r of rows) if (r.status === "PENDING") await d.jobs.send(tx, "submit-payout", { instructionId: r.instructionId });
    const counts: Record<InstructionStatus, number> = { PENDING: 0, HELD: 0, CARRIED: 0 };
    for (const r of rows) counts[r.status]++;
    const paid = rows.filter((r) => r.status === "PENDING");
    const totals = {
      grossKrw: paid.reduce((a, r) => a + r.gross, 0n).toString(),
      withholdingKrw: paid.reduce((a, r) => a + r.withholding, 0n).toString(),
    };
    await audit(tx, d.clock, { actor: actor.userId, action: "PAYOUT_RUN_CREATED", entityType: "payout_run", entityId: input.payoutRunId, after: { asOf: input.asOf, counts, ...totals } });
    return {
      payoutRunId: input.payoutRunId, asOf: input.asOf, counts, ...totals,
      instructions: rows.map((r) => ({
        instructionId: r.instructionId, partyId: r.partyId, status: r.status, holdReason: r.holdReason,
        grossKrw: r.gross.toString(), withholdingKrw: r.withholding.toString(), netKrw: (r.gross - r.withholding).toString(), entryId: r.entryId,
      })),
    };
  });
}
