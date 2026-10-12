import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, notFound } from "../platform/errors.ts";
import type { JobHandler, JobName, Jobs } from "../platform/jobs.ts";
import type { AccountKey, AccountKind } from "../ledger/accounts.ts";
import { postEntry } from "../ledger/journal.ts";
import type { PayoutProvider, ProviderResult } from "./provider.ts";
import type { PayoutDeps as RunDeps } from "./service.ts";

/**
 * 지급 작업 의존성: 지급 실행과 같은 db·clock·jobs에 PSP 어댑터. (SettleDeps도 그대로 넘길 수 있다.)
 * pollDelaySeconds: poll-payout 지연(기본 POLL_DELAY_SECONDS). 가짜 PSP로 도는 시나리오가 실제 대기 없이 재조회하도록 줄인다.
 */
export type PayoutDeps = RunDeps & { provider: PayoutProvider; pollDelaySeconds?: number };

const ACTOR = "sys_payout";
/** poll-payout 지연(초)과 최대 조회 횟수. 횟수는 pg-boss 재시도가 아니라 작업 데이터의 attempt로 센다. */
export const POLL_DELAY_SECONDS = 60;
export const MAX_POLLS = 10;

type Instruction = {
  instructionId: string; partyId: string; status: string; gross: bigint; withholding: bigint; net: bigint;
  idempotencyKey: string; providerRef: string | null; entryId: string | null; submitAttempted: boolean; submitUnknown: boolean; submittedAccountRef: string | null;
};

async function loadInstruction(tx: Tx, id: string, lock: boolean): Promise<Instruction | undefined> {
  const r = (await tx.query(
    `SELECT instruction_id, party_id, status, gross_krw::text AS g, withholding_krw::text AS w, net_krw::text AS n, idempotency_key, provider_ref, entry_id::text AS e,
            submit_attempted_at IS NOT NULL AS attempted, submitted_account_ref, submit_unknown_at IS NOT NULL AS unknown
       FROM payout_instruction WHERE instruction_id = $1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
  if (r === undefined) return undefined;
  return {
    instructionId: r.instruction_id, partyId: r.party_id, status: r.status, gross: BigInt(r.g), withholding: BigInt(r.w), net: BigInt(r.n),
    idempotencyKey: r.idempotency_key, providerRef: r.provider_ref, entryId: r.e, submitAttempted: r.attempted, submitUnknown: r.unknown, submittedAccountRef: r.submitted_account_ref,
  };
}

const isOpen = (i: Instruction) => i.status === "PENDING" || i.status === "SUBMITTED";

/**
 * provider_ref별 트랜잭션 advisory lock. webhook 저장·조회와 지시에 참조를 처음 기록하는 쪽을 직렬화해,
 * 한쪽이 커밋 전인 동안 다른 쪽이 서로를 못 보고 webhook이 영영 반영되지 않는 경합을 막는다.
 */
const lockRef = (tx: Tx, ref: string) => tx.query("SELECT pg_advisory_xact_lock(hashtextextended('psp_ref:' || $1, 0))", [ref]);

/**
 * submit-payout(통합 설계 11.2-7): (1) 짧은 트랜잭션에서 지시를 잠가 PENDING인지 보고, 전송 표식(submit_attempted_at)을 기록해
 * 커밋한다, (2) 트랜잭션 밖에서 provider.submit(멱등 키 payout:<id>), (3) 새 트랜잭션에서 다시 잠가 여전히 PENDING일 때만 반영한다.
 * 표식이 이미 있으면(앞선 시도가 PSP에 보냈을 수 있다) 다시 보내지도, 로컬로 실패시키지도 않는다: 결과 불명(submit_unknown_at)이면
 * 이미 잡힌 poll-payout에 맡기고, 아니면(전송 후 반영 전 중단) poll-payout으로 멱등 키 재조회를 시작한다.
 * 한 번도 보내지 않았고 계좌 토큰이 지워졌거나(NO_ACCOUNT) 지급 실행이 판정한 토큰(decided_account_ref)과 다르면(ACCOUNT_CHANGED — 냉각·직무 분리 판정을 거치지 않은 토큰)
 * PSP를 부르지 않고 FAILED로 끝낸다(잔액은 PAYOUT_FAILED로 복원된다).
 * provider가 예외를 던지면 작업이 실패하고, 재시도는 표식을 보고 재조회로 넘어간다.
 */
export async function submitPayout(d: PayoutDeps, data: { instructionId: string }): Promise<void> {
  const plan = await d.db.tx(async (tx) => {
    const i = await loadInstruction(tx, data.instructionId, true);
    if (i === undefined || i.status !== "PENDING") return null;
    if (i.submitAttempted) {
      if (!i.submitUnknown) await d.jobs.send(tx, "poll-payout", { instructionId: i.instructionId, attempt: "1" });
      return null;
    }
    const acct = (await tx.query(
      `SELECT p.payout_account_ref, p.payout_account_ref IS DISTINCT FROM x.decided_account_ref AS changed
         FROM payout_instruction x LEFT JOIN party_payout_profile p ON p.party_id = x.party_id WHERE x.instruction_id = $1`, [i.instructionId])).rows[0];
    const accountRef = (acct?.payout_account_ref ?? null) as string | null;
    if (accountRef === null) {
      await applyResult(tx, d.clock, i, { status: "FAILED", reason: "NO_ACCOUNT" });
      return null;
    }
    // 현재 토큰이 지급 실행이 판정한 토큰(decided_account_ref)과 다르면 냉각 기간·직무 분리 판정을 거치지 않은 토큰이므로 보내지 않는다
    // (시각 비교가 아니라 토큰 비교 — 동시 변경·시계 차이에도 안전하다. 잔액 복원, 다음 실행에서 다시 판정).
    if (acct.changed === true) {
      await applyResult(tx, d.clock, i, { status: "FAILED", reason: "ACCOUNT_CHANGED" });
      return null;
    }
    await tx.query("UPDATE payout_instruction SET submit_attempted_at = $2, submitted_account_ref = $3 WHERE instruction_id = $1", [i.instructionId, d.clock.now(), accountRef]);
    return { i, accountRef };
  });
  if (plan === null) return;
  const r = await d.provider.submit(
    { instructionId: plan.i.instructionId, partyId: plan.i.partyId, accountRef: plan.accountRef, amountKrw: plan.i.net }, plan.i.idempotencyKey);
  await d.db.tx(async (tx) => {
    const i = await loadInstruction(tx, data.instructionId, true);
    if (i === undefined || i.status !== "PENDING") return;
    if (r.status === "UNKNOWN") {
      await tx.query("UPDATE payout_instruction SET submit_unknown_at = $2 WHERE instruction_id = $1 AND submit_unknown_at IS NULL", [i.instructionId, d.clock.now()]);
      await audit(tx, d.clock, { actor: ACTOR, action: "PAYOUT_SUBMIT_UNKNOWN", entityType: "payout_instruction", entityId: i.instructionId, after: { reason: r.reason ?? null } });
    }
    await applyProviderResult(tx, d, i, r, 1);
  });
}

/**
 * 운영자 재전송(SPACE_SETTLE): 멈춘 지시(PENDING·SUBMITTED이고 submit_attempted_at이 있다 — PSP에 보냈거나 보냈을 수 있다)를
 * 같은 멱등 키로 provider.submit에 다시 보내고 결과를 보통 경로(applyProviderResult)로 반영한다. 트랜잭션 밖에서 부르며 감사 PAYOUT_RESUBMITTED를 남긴다.
 * provider가 예외를 던지면 UNKNOWN으로 보고 poll-payout을 다시 건다. 같은 키라 PSP는 한 번만 지급한다.
 */
export async function resubmitPayout(d: PayoutDeps, actor: Actor, instructionId: string): Promise<{ instructionId: string; providerStatus: ProviderResult["status"]; status: string }> {
  requireRole(actor, "SPACE_SETTLE");
  const plan = await d.db.tx(async (tx) => {
    const i = await loadInstruction(tx, instructionId, true);
    if (i === undefined) throw notFound("payout instruction", instructionId);
    if (!isOpen(i) || !i.submitAttempted) throw conflict("NOT_RESUBMITTABLE", `instruction ${instructionId} is ${i.status}${i.submitAttempted ? "" : " and was never sent"}`);
    // 처음 보낸 계좌 토큰을 쓴다(그 뒤 프로필이 바뀌어도 같은 멱등 키에 같은 계좌).
    return { i, accountRef: i.submittedAccountRef! };
  });
  let r: ProviderResult;
  try {
    r = await d.provider.submit(
      { instructionId, partyId: plan.i.partyId, accountRef: plan.accountRef, amountKrw: plan.i.net }, plan.i.idempotencyKey);
  } catch (e) {
    r = { status: "UNKNOWN", reason: `submit failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return d.db.tx(async (tx) => {
    const i = await loadInstruction(tx, instructionId, true);
    if (i === undefined) throw notFound("payout instruction", instructionId);
    await audit(tx, d.clock, { actor: actor.userId, action: "PAYOUT_RESUBMITTED", entityType: "payout_instruction", entityId: instructionId, after: { from: i.status, providerStatus: r.status, reason: r.reason ?? null } });
    if (isOpen(i)) {
      if (r.status === "UNKNOWN") await tx.query("UPDATE payout_instruction SET submit_unknown_at = $2 WHERE instruction_id = $1 AND submit_unknown_at IS NULL", [instructionId, d.clock.now()]);
      await applyProviderResult(tx, d, i, r, 1);
    }
    return { instructionId, providerStatus: r.status, status: (await loadInstruction(tx, instructionId, false))!.status };
  });
}

/**
 * poll-payout: 지시가 끝나지 않았으면 트랜잭션 밖에서 status(provider_ref, 멱등 키)를 조회하고, 새 트랜잭션에서 다시 잠가 반영한다.
 * 조회가 예외를 던지면 UNKNOWN으로 본다. 끝 상태가 아니면 attempt + 1로 다시 지연 전송하고, MAX_POLLS를 넘으면
 * 감사 PAYOUT_STUCK을 남기고 멈춘다(운영자 확인 — PSP_CLEARING에 남은 돈이 조용히 묻히지 않도록).
 */
export async function pollPayout(d: PayoutDeps, data: { instructionId: string; attempt?: number }): Promise<void> {
  const attempt = data.attempt ?? 1;
  const cur = await d.db.tx((tx) => loadInstruction(tx, data.instructionId, false));
  if (cur === undefined || !isOpen(cur)) return;
  let r: ProviderResult;
  try {
    r = await d.provider.status(cur.providerRef ?? "", cur.idempotencyKey);
  } catch (e) {
    r = { status: "UNKNOWN", reason: `status failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  await d.db.tx(async (tx) => {
    const i = await loadInstruction(tx, data.instructionId, true);
    if (i === undefined || !isOpen(i)) return;
    await applyProviderResult(tx, d, i, r, attempt + 1);
  });
}

/**
 * webhook(통합 설계 11.2-7): inbox에 저장한다. 같은 provider_event_id면 아무것도 하지 않는다(created:false).
 * provider_ref로 지시를 찾으면(행을 잠근다) apply-psp-result를 보낸다. 아직 모르는 참조면 처리하지 않은 채 남기고,
 * submit·poll이 그 참조를 기록할 때 apply-psp-result를 보낸다(참조 advisory lock으로 직렬화).
 */
export async function recordWebhook(tx: Tx, clock: Clock, jobs: Jobs,
  w: { providerEventId: string; providerRef: string; status: "PAID" | "FAILED"; payload: unknown }): Promise<{ created: boolean }> {
  if (w.status !== "PAID" && w.status !== "FAILED") throw new Error(`webhook status must be PAID or FAILED, got ${String(w.status)}`);
  await lockRef(tx, w.providerRef);
  const ins = await tx.query(
    `INSERT INTO psp_webhook_inbox (provider_event_id, provider_ref, status, payload, received_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (provider_event_id) DO NOTHING RETURNING provider_event_id`,
    [w.providerEventId, w.providerRef, w.status, JSON.stringify(w.payload ?? null), clock.now()]);
  if ((ins.rowCount ?? 0) === 0) return { created: false };
  const i = (await tx.query("SELECT instruction_id FROM payout_instruction WHERE provider_ref = $1 FOR UPDATE", [w.providerRef])).rows[0];
  if (i !== undefined) await jobs.send(tx, "apply-psp-result", { instructionId: i.instruction_id, status: w.status, providerEventId: w.providerEventId });
  return { created: true };
}

/**
 * apply-psp-result: 지시를 잠그고 이미 끝 상태면 끝(멱등 — 다른 결과면 감사 PAYOUT_RESULT_CONFLICT). 아니면 결과 분개와 상태 전이를
 * 한 트랜잭션에서 쓴다. providerEventId가 있으면 inbox 행을 처리됨으로 표시한다.
 */
export async function applyPspResult(d: PayoutDeps, data: { instructionId: string; status: "PAID" | "FAILED"; providerEventId?: string }): Promise<void> {
  if (data.status !== "PAID" && data.status !== "FAILED") throw new Error(`result status must be PAID or FAILED, got ${String(data.status)}`);
  await d.db.tx(async (tx) => {
    const i = await loadInstruction(tx, data.instructionId, true);
    if (i === undefined) return;
    if (isOpen(i)) {
      await applyResult(tx, d.clock, i, { status: data.status });
    } else if (i.status !== data.status) {
      await audit(tx, d.clock, {
        actor: ACTOR, action: "PAYOUT_RESULT_CONFLICT", entityType: "payout_instruction", entityId: i.instructionId,
        after: { current: i.status, incoming: data.status, providerEventId: data.providerEventId ?? null },
      });
    }
    if (data.providerEventId !== undefined) {
      await tx.query("UPDATE psp_webhook_inbox SET processed_at = $2 WHERE provider_event_id = $1 AND processed_at IS NULL", [data.providerEventId, d.clock.now()]);
    }
  });
}

export function payoutJobHandlers(d: PayoutDeps): Partial<Record<JobName, JobHandler>> {
  return {
    "submit-payout": (data) => submitPayout(d, { instructionId: data.instructionId! }),
    "poll-payout": (data) => {
      const n = Number(data.attempt ?? "1");
      return pollPayout(d, { instructionId: data.instructionId!, attempt: Number.isSafeInteger(n) && n >= 1 ? n : 1 });
    },
    "apply-psp-result": (data) => applyPspResult(d, {
      instructionId: data.instructionId!, status: data.status as "PAID" | "FAILED",
      ...(data.providerEventId === undefined ? {} : { providerEventId: data.providerEventId }),
    }),
  };
}

/**
 * provider가 돌려준 참조를 지시에 맞춘다. 저장된 참조가 없으면 참조 lock을 잡고 새 참조를 쓸 수 있다(true).
 * 저장된 참조와 다르면 감사 PAYOUT_REF_MISMATCH를 남기고 저장된 참조를 유지한다(다른 참조의 webhook은 넘기지 않는다).
 */
async function acceptRef(tx: Tx, clock: Clock, i: Instruction, ref: string | undefined): Promise<string | null> {
  if (ref === undefined) return null;
  if (i.providerRef === null) {
    await lockRef(tx, ref);
    return ref;
  }
  if (i.providerRef !== ref) {
    await audit(tx, clock, { actor: ACTOR, action: "PAYOUT_REF_MISMATCH", entityType: "payout_instruction", entityId: i.instructionId, after: { stored: i.providerRef, reported: ref } });
  }
  return null;
}

/** submit·poll 결과 반영(잠긴 열린 지시). nextAttempt는 다음 poll-payout의 시도 번호. */
async function applyProviderResult(tx: Tx, d: PayoutDeps, i: Instruction, r: ProviderResult, nextAttempt: number): Promise<void> {
  const { clock, jobs } = d;
  if (r.status === "PAID" || r.status === "FAILED") {
    await applyResult(tx, clock, i, { status: r.status, ...(r.providerRef === undefined ? {} : { providerRef: r.providerRef }), ...(r.reason === undefined ? {} : { reason: r.reason }) });
    return;
  }
  if (r.status === "ACCEPTED") {
    const newRef = await acceptRef(tx, clock, i, r.providerRef);
    if (i.status === "PENDING") {
      await tx.query("UPDATE payout_instruction SET status = 'SUBMITTED', provider_ref = COALESCE(provider_ref, $2) WHERE instruction_id = $1", [i.instructionId, newRef]);
      await audit(tx, clock, { actor: ACTOR, action: "PAYOUT_SUBMITTED", entityType: "payout_instruction", entityId: i.instructionId, after: { providerRef: newRef ?? i.providerRef } });
    } else if (newRef !== null) {
      await tx.query("UPDATE payout_instruction SET provider_ref = $2 WHERE instruction_id = $1 AND provider_ref IS NULL", [i.instructionId, newRef]);
    }
    if (newRef !== null) await forwardInbox(tx, jobs, i.instructionId, newRef);
  }
  if (nextAttempt > MAX_POLLS) {
    await audit(tx, clock, { actor: ACTOR, action: "PAYOUT_STUCK", entityType: "payout_instruction", entityId: i.instructionId, after: { polls: MAX_POLLS, lastStatus: r.status, reason: r.reason ?? null } });
    return;
  }
  await jobs.send(tx, "poll-payout", { instructionId: i.instructionId, attempt: String(nextAttempt) }, { startAfterSeconds: d.pollDelaySeconds ?? POLL_DELAY_SECONDS });
}

/** 참조를 방금 알게 된 열린 지시에 대해, 먼저 도착해 처리되지 않은 webhook을 apply-psp-result로 넘긴다. */
async function forwardInbox(tx: Tx, jobs: Jobs, instructionId: string, providerRef: string): Promise<void> {
  const rows = (await tx.query("SELECT provider_event_id, status FROM psp_webhook_inbox WHERE provider_ref = $1 AND processed_at IS NULL ORDER BY received_at, provider_event_id", [providerRef])).rows;
  for (const w of rows) await jobs.send(tx, "apply-psp-result", { instructionId, status: w.status, providerEventId: w.provider_event_id });
}

/**
 * 끝 결과 반영(잠긴 열린 지시). PAID → PAYOUT_SETTLED(settled:<id>: PSP_CLEARING +net, CASH −net).
 * FAILED → PAYOUT_FAILED(failed:<id>): 그 지시의 PAYOUT 분개 전기를 그대로 뒤집는다(PSP_CLEARING +net, WITHHOLDING_TAX +원천세,
 * PARTY_PAYABLE −총액) — PAYOUT 분개가 있을 때만. 상태 전이 가드와 source_ref 멱등으로 한 번만 일어난다.
 * settled_entry_id에는 결과 분개(PAYOUT_SETTLED 또는 PAYOUT_FAILED)를 기록한다. 끝난 지시 참조의 미처리 webhook은
 * 처리됨으로 표시한다(결과가 다르면 PAYOUT_RESULT_CONFLICT 감사).
 */
async function applyResult(tx: Tx, clock: Clock, i: Instruction, r: { status: "PAID" | "FAILED"; providerRef?: string; reason?: string }): Promise<void> {
  if (i.entryId === null) throw new Error(`payout_instruction ${i.instructionId} has no PAYOUT entry`);
  const newRef = await acceptRef(tx, clock, i, r.providerRef);
  let entryId: string;
  if (r.status === "PAID") {
    entryId = (await postEntry(tx, clock, {
      kind: "PAYOUT_SETTLED", sourceRef: `settled:${i.instructionId}`, createdBy: ACTOR,
      postings: [{ account: { kind: "PSP_CLEARING" }, amount: i.net }, { account: { kind: "CASH" }, amount: -i.net }],
    })).entryId;
  } else {
    const reversed = await reversePayout(tx, i);
    entryId = (await postEntry(tx, clock, { kind: "PAYOUT_FAILED", sourceRef: `failed:${i.instructionId}`, createdBy: ACTOR, postings: reversed })).entryId;
  }
  await tx.query(
    "UPDATE payout_instruction SET status = $2, provider_ref = COALESCE(provider_ref, $3), settled_entry_id = $4 WHERE instruction_id = $1",
    [i.instructionId, r.status, newRef, entryId]);
  await audit(tx, clock, {
    actor: ACTOR, action: r.status === "PAID" ? "PAYOUT_PAID" : "PAYOUT_FAILED", entityType: "payout_instruction", entityId: i.instructionId,
    after: { netKrw: i.net.toString(), entryId, reason: r.reason ?? null },
  });
  const ref = i.providerRef ?? newRef;
  if (ref === null) return;
  const pending = (await tx.query(
    "UPDATE psp_webhook_inbox SET processed_at = $2 WHERE provider_ref = $1 AND processed_at IS NULL RETURNING provider_event_id, status", [ref, clock.now()])).rows;
  for (const w of pending) {
    if (w.status !== r.status) {
      await audit(tx, clock, {
        actor: ACTOR, action: "PAYOUT_RESULT_CONFLICT", entityType: "payout_instruction", entityId: i.instructionId,
        after: { current: r.status, incoming: w.status, providerEventId: w.provider_event_id },
      });
    }
  }
}

/** 지시의 PAYOUT 분개 전기의 반대 부호. 분개가 그 지시의 것이고 금액이 지시와 맞는지 확인한다. */
async function reversePayout(tx: Tx, i: Instruction): Promise<{ account: AccountKey; amount: bigint }[]> {
  const e = (await tx.query("SELECT kind, source_ref FROM journal_entry WHERE entry_id = $1", [i.entryId])).rows[0];
  if (e === undefined || e.kind !== "PAYOUT" || e.source_ref !== `payout:${i.instructionId}`) {
    throw new Error(`payout_instruction ${i.instructionId}: entry ${i.entryId} is not its PAYOUT entry`);
  }
  const rows = (await tx.query(
    `SELECT a.kind, a.party_id, a.reason, a.bucket, p.amount_krw::text AS amt FROM posting p JOIN ledger_account a USING (account_id)
      WHERE p.entry_id = $1 ORDER BY p.posting_id`, [i.entryId])).rows;
  const out = rows.map((x) => {
    const account: AccountKey = { kind: x.kind as AccountKind };
    if (x.party_id !== null) account.partyId = x.party_id;
    if (x.reason !== null) account.reason = x.reason;
    if (x.bucket !== null) account.bucket = x.bucket;
    return { account, amount: -BigInt(x.amt) };
  });
  const sum = (k: AccountKind, party?: string) => out.filter((p) => p.account.kind === k && (party === undefined || p.account.partyId === party)).reduce((a, p) => a + p.amount, 0n);
  if (sum("PARTY_PAYABLE", i.partyId) !== -i.gross || sum("WITHHOLDING_TAX") !== i.withholding || sum("PSP_CLEARING") !== i.net
      || out.some((p) => !["PARTY_PAYABLE", "WITHHOLDING_TAX", "PSP_CLEARING"].includes(p.account.kind))) {
    throw new Error(`payout_instruction ${i.instructionId}: PAYOUT entry does not match the instruction amounts`);
  }
  return out;
}
