import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Db, Tx } from "../platform/db.ts";
import { conflict, invalid, notFound } from "../platform/errors.ts";
import type { Jobs } from "../platform/jobs.ts";
import { postEntry } from "../ledger/journal.ts";
import { PAYOUT_KEY_PREFIX } from "./provider.ts";
import { decide, loadPayoutPolicy, TAX_TYPES, type HoldReason, type ProfileView, type TaxType } from "./policy.ts";
import { requirePermission } from "../platform/permissions.ts";

export type PayoutDeps = { db: Db; clock: Clock; jobs: Jobs };
export type InstructionStatus = "PENDING" | "CARRIED" | "HELD";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** '_'는 instruction_id(po_<run>_<party>)의 구분자이므로 run id에 허용하지 않는다(지시 id가 모호해지지 않도록). */
const RUN_ID = /^[A-Za-z0-9.-]{1,100}$/;

/**
 * 지급 프로필(통합 설계 11.2-6, payout.profile_set): 없으면 만들고(first_payable_at = 지금), 있으면 세금 유형·계좌 토큰·KYC·수정 시각만 바꾼다.
 * payoutAccountRef를 생략하면 기존 값을 두고, null이면 지운다. 계좌 토큰은 PSP 쪽 토큰이다(원문 계좌번호가 아니다).
 * 계좌 토큰이 바뀌면(처음 등록·지움 포함) account_changed_at·account_changed_by를 지금·이 사용자로 쓴다 — 지급 실행의 냉각 기간
 * (ACCOUNT_COOLING)과 직무 분리(ACCOUNT_SOD) 판정에 쓴다. 감사 PAYOUT_PROFILE_SET에 이전 값과 새 값(토큰·세금 유형·KYC)을 남긴다.
 */
export async function setPayoutProfile(tx: Tx, clock: Clock, actor: Actor,
  input: { partyId: string; taxType: string; payoutAccountRef?: string | null; kycVerified: boolean; accountHolderId?: string }) {
  requirePermission(actor, "payout.profile_set");
  if (!TAX_TYPES.includes(input.taxType as TaxType)) throw invalid("INVALID_TAX_TYPE", `taxType must be one of ${TAX_TYPES.join(", ")}`);
  if (typeof input.kycVerified !== "boolean") throw invalid("INVALID_KYC", "kycVerified must be a boolean");
  const ref = input.payoutAccountRef;
  if (ref !== undefined && ref !== null && (typeof ref !== "string" || ref.length === 0 || ref.length > 200)) {
    throw invalid("INVALID_ACCOUNT_REF", "payoutAccountRef must be a non-empty token of at most 200 characters, or null");
  }
  const party = (await tx.query("SELECT party_type, legal_id FROM party WHERE party_id = $1", [input.partyId])).rows[0];
  if (party === undefined) throw notFound("party", input.partyId);
  // 계좌 예금주는 당사자와 같아야 한다(결정 TD2): PSP가 알려 준 예금주 식별값이 당사자 식별값과 다르면 받지 않는다.
  if (input.accountHolderId !== undefined && party.legal_id !== null && input.accountHolderId !== party.legal_id) {
    throw invalid("ACCOUNT_HOLDER_MISMATCH", `the account holder (${input.accountHolderId}) is not ${input.partyId} (${party.legal_id})`);
  }
  if (party.party_type === "FAN" || party.party_type === "PLATFORM") throw invalid("INVALID_PARTY", `${input.partyId} is not a rights holder party`);
  const load = async () => (await tx.query(
    "SELECT tax_type, payout_account_ref, kyc_verified FROM party_payout_profile WHERE party_id = $1 FOR UPDATE", [input.partyId])).rows[0] as
    { tax_type: string; payout_account_ref: string | null; kyc_verified: boolean } | undefined;
  let old = await load();
  // 시각은 행 잠금 뒤에 읽는다(잠금을 기다리는 동안 앞선 지급 실행이 끝나면 변경 시각이 그 실행보다 뒤가 되도록).
  const now = clock.now();
  let firstPayableAt: Date | undefined;
  let newRef: string | null = ref ?? null;
  if (old === undefined) {
    const ins = (await tx.query(
      `INSERT INTO party_payout_profile (party_id, tax_type, payout_account_ref, kyc_verified, first_payable_at, updated_at, account_changed_at, account_changed_by)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7) ON CONFLICT (party_id) DO NOTHING RETURNING first_payable_at`,
      [input.partyId, input.taxType, newRef, input.kycVerified, now, newRef === null ? null : now, newRef === null ? null : actor.userId])).rows[0];
    if (ins !== undefined) firstPayableAt = ins.first_payable_at;
    else old = await load(); // 동시에 다른 트랜잭션이 먼저 만들었다 → 갱신 경로.
  }
  if (old !== undefined) {
    newRef = ref === undefined ? old.payout_account_ref : ref;
    const changed = newRef !== old.payout_account_ref;
    firstPayableAt = (await tx.query(
      `UPDATE party_payout_profile SET tax_type = $2, payout_account_ref = $3, kyc_verified = $4, updated_at = $5,
         account_changed_at = CASE WHEN $6 THEN $5 ELSE account_changed_at END, account_changed_by = CASE WHEN $6 THEN $7 ELSE account_changed_by END
       WHERE party_id = $1 RETURNING first_payable_at`,
      [input.partyId, input.taxType, newRef, input.kycVerified, now, changed, actor.userId])).rows[0].first_payable_at;
  }
  if (input.accountHolderId !== undefined) await tx.query("UPDATE party_payout_profile SET account_holder_id = $2 WHERE party_id = $1", [input.partyId, input.accountHolderId]);
  const accountChanged = old === undefined ? newRef !== null : newRef !== old.payout_account_ref;
  const view = { partyId: input.partyId, taxType: input.taxType, hasAccount: newRef !== null, kycVerified: input.kycVerified, firstPayableAt: (firstPayableAt as Date).toISOString() };
  await audit(tx, clock, {
    actor: actor.userId, action: "PAYOUT_PROFILE_SET", entityType: "party_payout_profile", entityId: input.partyId,
    after: {
      ...view, accountChanged,
      before: old === undefined ? null : { taxType: old.tax_type, payoutAccountRef: old.payout_account_ref, kycVerified: old.kyc_verified },
      after: { taxType: input.taxType, payoutAccountRef: newRef, kycVerified: input.kycVerified },
    },
  });
  return view;
}

/**
 * 지급 실행(통합 설계 11.2-6, payout.run): PARTY_PAYABLE 계정이 있는 권리자마다 지시 하나를 만든다. 한 트랜잭션.
 * 총액 = 미지급금 부채 잔액(asOf 이전 전기의 −합). 단 이미 쓴 PAYOUT·PAYOUT_FAILED 분개는 시각과 무관하게 넣는다 —
 * 앞선 지급의 분개가 이번 asOf보다 늦게 기록됐어도 같은 잔액을 두 번 지급하지 않는다.
 * 프로필은 FOR SHARE로 읽는다: 판정하는 동안 계좌 토큰 변경(setPayoutProfile의 FOR UPDATE)은 이 실행이 끝날 때까지 기다린다.
 * PENDING 지시에는 판정한 토큰(decided_account_ref)을 적는다 — 전송 때 현재 토큰과 다르면 보내지 않는다(ACCOUNT_CHANGED).
 * 보류 판정(decide)에는 계좌 토큰 냉각 기간(ACCOUNT_COOLING)과 직무 분리(ACCOUNT_SOD — 실행자가 그 권리자의 토큰을 마지막으로 바꾼 사용자)가 있다.
 * HELD·CARRIED는 분개하지 않는다(잔액이 그대로 이월된다). PENDING은 분개 PAYOUT과 submit-payout 작업을 같은 트랜잭션에서 쓴다.
 * 동시 실행은 트랜잭션 advisory lock(payout:run)으로 직렬화한다 — 뒤 실행은 앞 실행의 PAYOUT을 본 뒤 잔액을 읽는다.
 * asOf는 이전 실행들의 최대 asOf보다 앞설 수 없다(422 AS_OF_REGRESSED — 잠금 안에서 검사).
 */
export async function createPayoutRun(d: PayoutDeps, actor: Actor, input: { payoutRunId: string; asOf: string }) {
  requirePermission(actor, "payout.run");
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
      `SELECT party_id, tax_type, payout_account_ref, kyc_verified, first_payable_at, account_changed_at, account_changed_by
         FROM party_payout_profile WHERE party_id = ANY($1) ORDER BY party_id FOR SHARE`, [parties])).rows
      .map((r) => [r.party_id as string, {
        taxType: r.tax_type, payoutAccountRef: r.payout_account_ref, kycVerified: r.kyc_verified, firstPayableAt: (r.first_payable_at as Date).toISOString(),
        accountChangedAt: r.account_changed_at === null ? null : (r.account_changed_at as Date).toISOString(), accountChangedBy: r.account_changed_by,
      }]));

    // 관리 주체 조직이 정지된 당사자는 지급을 보류한다(결정 TD7 — 정산은 계속 계산한다).
    const suspended = new Set((await tx.query(
      "SELECT p.party_id FROM party p JOIN tenant t ON t.tenant_id = p.tenant_id WHERE p.party_id = ANY($1) AND t.status = 'SUSPENDED'", [parties])).rows.map((r) => r.party_id as string));
    const rows: { instructionId: string; partyId: string; gross: bigint; withholding: bigint; status: InstructionStatus; holdReason: HoldReason | null; entryId: string | null; decidedAccountRef: string | null }[] = [];
    for (const b of balances) {
      const partyId = b.party_id as string;
      const gross = -BigInt(b.s);
      const instructionId = `po_${input.payoutRunId}_${partyId}`;
      const v = suspended.has(partyId) && gross > 0n ? { status: "HELD" as const, reason: "TENANT_SUSPENDED" as const } : decide(policy, input.asOf, gross, profiles.get(partyId), actor.userId);
      if (v.status !== "PENDING") {
        rows.push({ instructionId, partyId, gross, withholding: 0n, status: v.status, holdReason: v.status === "HELD" ? v.reason : null, entryId: null, decidedAccountRef: null });
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
      rows.push({ instructionId, partyId, gross, withholding: v.withholding, status: "PENDING", holdReason: null, entryId: e.entryId, decidedAccountRef: profiles.get(partyId)!.payoutAccountRef });
    }
    if (rows.length > 0) {
      await tx.query(
        `INSERT INTO payout_instruction (instruction_id, payout_run_id, party_id, gross_krw, withholding_krw, net_krw, status, hold_reason, idempotency_key, entry_id, decided_account_ref, created_at)
         SELECT i, $1, p, g, w, g - w, s, h, $11::text || i, e, a, $2
           FROM unnest($3::text[], $4::text[], $5::bigint[], $6::bigint[], $7::text[], $8::text[], $9::bigint[], $10::text[]) AS t(i, p, g, w, s, h, e, a)`,
        [input.payoutRunId, now, rows.map((r) => r.instructionId), rows.map((r) => r.partyId), rows.map((r) => r.gross.toString()),
          rows.map((r) => r.withholding.toString()), rows.map((r) => r.status), rows.map((r) => r.holdReason), rows.map((r) => r.entryId), rows.map((r) => r.decidedAccountRef), PAYOUT_KEY_PREFIX],
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
