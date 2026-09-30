import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, notFound } from "../platform/errors.ts";
import { poolAccountFor } from "../ledger/accounts.ts";
import { postEntry, type PostingInput } from "../ledger/journal.ts";
import type { SettleDeps } from "./service.ts";

const SYSTEM = "sys_settler";

/** run의 권리 풀 버킷 이름(발행 봉인의 정책). */
async function rightsBucket(tx: Tx, runId: string): Promise<string> {
  const r = (await tx.query(
    `SELECT d.content->'body'->'tier1'->>'rights' AS rights FROM settlement_run r JOIN issue_seal s ON s.snapshot_id = r.snapshot_id
       JOIN sealed_document d ON d.digest = s.policy_digest WHERE r.run_id = $1`, [runId])).rows[0];
  if (r === undefined || r.rights === null) throw notFound("run policy", runId);
  return r.rights;
}

/** 확정 run 하나의 SETTLEMENT 분개(통합 설계 11.2-4). run이 CONFIRMED가 아니면 409. 멱등. */
export async function postConfirmedRun(tx: Tx, clock: Clock, runId: string): Promise<void> {
  const run = (await tx.query("SELECT status FROM settlement_run WHERE run_id = $1 FOR SHARE", [runId])).rows[0];
  if (run === undefined) throw notFound("run", runId);
  if (run.status !== "CONFIRMED") throw conflict("INVALID_STATE", `run ${runId} is ${run.status}`);
  const rights = await rightsBucket(tx, runId);
  const postings: PostingInput[] = [];
  for (const e of (await tx.query("SELECT event_id, net_amount_krw::text AS net FROM settlement_run_event WHERE run_id = $1 ORDER BY event_id", [runId])).rows) {
    postings.push({ account: { kind: "RECEIVABLE" }, amount: BigInt(e.net), eventId: e.event_id, runId });
  }
  for (const p of (await tx.query("SELECT event_id, bucket, amount_krw::text AS a FROM pool_line WHERE run_id = $1 AND line_seq = 1 ORDER BY event_id, bucket", [runId])).rows) {
    if (p.bucket !== rights) postings.push({ account: poolAccountFor(p.bucket), amount: -BigInt(p.a), eventId: p.event_id, runId });
  }
  for (const l of (await tx.query("SELECT event_id, party_id, amount_krw::text AS a FROM allocation_line WHERE run_id = $1 AND line_seq = 1 ORDER BY line_id", [runId])).rows) {
    postings.push({ account: { kind: "PARTY_PAYABLE", partyId: l.party_id }, amount: -BigInt(l.a), eventId: l.event_id, runId });
  }
  for (const h of (await tx.query("SELECT event_id, reason, amount_krw::text AS a FROM unallocated_holding WHERE run_id = $1 AND line_seq = 1 ORDER BY holding_id", [runId])).rows) {
    postings.push({ account: { kind: "HOLD", reason: h.reason }, amount: -BigInt(h.a), eventId: h.event_id, runId });
  }
  await postEntry(tx, clock, { kind: "SETTLEMENT", sourceRef: `run:${runId}`, createdBy: SYSTEM, postings });
}

/**
 * 역분개의 REVERSAL 분개(통합 설계 11.2-4·5). 역분개 행의 금액은 음수이므로 부호를 뒤집어 쓴다.
 * 이미 해제된 보류의 역분개는 Task 2가 이 함수를 확장해 해제 배분 비율로 권리자 미지급금에서 뺀다.
 */
export async function postReversal(tx: Tx, clock: Clock, reversalId: string): Promise<void> {
  const rv = (await tx.query("SELECT original_run_id, event_id, sequence FROM reversal_run WHERE reversal_id = $1", [reversalId])).rows[0];
  if (rv === undefined) throw notFound("reversal", reversalId);
  const runId = rv.original_run_id as string;
  const rights = await rightsBucket(tx, runId);
  const postings: PostingInput[] = [];
  const pool = (await tx.query("SELECT bucket, amount_krw::text AS a FROM pool_line WHERE reversal_id = $1 ORDER BY bucket", [reversalId])).rows;
  const total = pool.reduce((a, p) => a + BigInt(p.a), 0n);   // 음수
  postings.push({ account: { kind: "RECEIVABLE" }, amount: total, eventId: rv.event_id, runId });
  for (const p of pool) if (p.bucket !== rights) postings.push({ account: poolAccountFor(p.bucket), amount: -BigInt(p.a), eventId: rv.event_id, runId });
  for (const l of (await tx.query("SELECT party_id, amount_krw::text AS a FROM allocation_line WHERE reversal_id = $1 ORDER BY line_id", [reversalId])).rows) {
    postings.push({ account: { kind: "PARTY_PAYABLE", partyId: l.party_id }, amount: -BigInt(l.a), eventId: rv.event_id, runId });
  }
  for (const h of (await tx.query("SELECT reason, amount_krw::text AS a FROM unallocated_holding WHERE reversal_id = $1 ORDER BY holding_id", [reversalId])).rows) {
    postings.push({ account: { kind: "HOLD", reason: h.reason }, amount: -BigInt(h.a), eventId: rv.event_id, runId });
  }
  await postEntry(tx, clock, { kind: "REVERSAL", sourceRef: `rev:${reversalId}`, createdBy: SYSTEM, postings });
}

/** post-batch 처리기: 배치의 CONFIRMED run마다 분개(멱등). */
export async function postBatch(d: SettleDeps, data: { batchId: string }): Promise<void> {
  const runs = (await d.db.pool.query("SELECT run_id FROM settlement_run WHERE batch_id = $1 AND status = 'CONFIRMED' ORDER BY run_id", [data.batchId])).rows;
  for (const r of runs) await d.db.tx((tx) => postConfirmedRun(tx, d.clock, r.run_id));
}
