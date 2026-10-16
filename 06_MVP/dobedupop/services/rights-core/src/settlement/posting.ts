import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, DomainError, notFound } from "../platform/errors.ts";
import { poolAccountFor } from "../ledger/accounts.ts";
import { postEntry, type PostingInput } from "../ledger/journal.ts";
import { splitByWeights } from "../ledger/split.ts";
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
  // 이미 쓴 분개면 run 행을 다시 읽지 않는다(역분개·보류 해제가 매번 부르는 보장 호출 — 통합 설계 11.4).
  if (((await tx.query("SELECT 1 FROM journal_entry WHERE source_ref = $1", [`run:${runId}`])).rowCount ?? 0) > 0) return;
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
 * 원 보류가 이미 해제됐으면(hold_release) 그 보류의 역분개 금액은 권리자별 남은 해제액 비율로 권리자 미지급금에 전기하고
 * 진행을 hold_release_reversal에 남긴다.
 */
export async function postReversal(tx: Tx, clock: Clock, reversalId: string): Promise<void> {
  const rv = (await tx.query("SELECT original_run_id, event_id, sequence FROM reversal_run WHERE reversal_id = $1", [reversalId])).rows[0];
  if (rv === undefined) throw notFound("reversal", reversalId);
  // 이미 쓴 역분개면 아무것도 계산하지 않는다(멱등, 해제 진행 기록도 한 번만).
  if (((await tx.query("SELECT 1 FROM journal_entry WHERE source_ref = $1", [`rev:${reversalId}`])).rowCount ?? 0) > 0) return;
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
  const holds = (await tx.query(
    `SELECT h.reason, h.amount_krw::text AS a, hr.release_id::text AS release_id, hr.allocation
       FROM unallocated_holding h
       LEFT JOIN unallocated_holding o ON o.run_id = h.run_id AND o.event_id = h.event_id AND o.bucket = h.bucket AND o.reason = h.reason AND o.line_seq = 1
       LEFT JOIN hold_release hr ON hr.holding_id = o.holding_id
      WHERE h.reversal_id = $1 ORDER BY h.holding_id`, [reversalId])).rows;
  const progress: { releaseId: string; partyId: string; amount: bigint }[] = [];
  for (const h of holds) {
    const amount = -BigInt(h.a);   // 양수: 되돌릴 금액
    if (h.release_id === null) {
      postings.push({ account: { kind: "HOLD", reason: h.reason }, amount, eventId: rv.event_id, runId });
      continue;
    }
    // 해제된 보류(통합 설계 11.2-5): 보류 계정 대신 권리자 미지급금에서 뺀다. 가중치는 권리자별 남은 해제액
    // (배분 − 이 해제에서 이미 되돌린 금액)이다 — 부분 역분개가 반복돼도 반올림이 쌓이지 않고, 누구도 남은 몫을 넘지 않으며,
    // 보류 전액이 역분개되면 권리자별 순합이 정확히 0이 된다(최대 잔여법, 동률 party_id 오름차순).
    const done = new Map((await tx.query(
      "SELECT party_id, SUM(amount_krw)::text AS s FROM hold_release_reversal WHERE release_id = $1 GROUP BY party_id", [h.release_id],
    )).rows.map((r) => [r.party_id as string, BigInt(r.s)]));
    const weights = Object.entries(h.allocation as Record<string, string>)
      .map(([key, v]) => ({ key, weight: BigInt(v) - (done.get(key) ?? 0n) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const left = weights.reduce((a, w) => a + w.weight, 0n);
    if (amount > left) throw new DomainError("LEDGER_RELEASE_EXCEEDED", 500, `reversal ${reversalId} takes ${amount} from release ${h.release_id} with ${left} left`);
    if (amount === 0n) continue;
    for (const [partyId, part] of splitByWeights(amount, weights)) {
      if (part === 0n) continue;
      postings.push({ account: { kind: "PARTY_PAYABLE", partyId }, amount: part, eventId: rv.event_id, runId });
      progress.push({ releaseId: h.release_id, partyId, amount: part });
    }
  }
  const e = await postEntry(tx, clock, { kind: "REVERSAL", sourceRef: `rev:${reversalId}`, createdBy: SYSTEM, postings });
  if (e.created && progress.length > 0) {
    await tx.query(
      `INSERT INTO hold_release_reversal (release_id, reversal_id, party_id, amount_krw)
       SELECT r, $2, p, a FROM unnest($1::bigint[], $3::text[], $4::bigint[]) AS t(r, p, a)`,
      [progress.map((x) => x.releaseId), reversalId, progress.map((x) => x.partyId), progress.map((x) => x.amount.toString())],
    );
  }
}

/** post-batch에서 동시에 분개하는 run 수(run마다 자기 트랜잭션). 풀(기본 10)의 일부만 쓴다. */
export const POST_CONCURRENCY = 4;

/**
 * post-batch 처리기: 배치의 CONFIRMED run마다 분개(멱등). run 분개는 서로 독립이므로 POST_CONCURRENCY개 트랜잭션으로 나눠 쓴다
 * (한 줄로 쓰면 run 9490개에 21.6초 — 통합 설계 11.4). 한 run이 실패하면 남은 run을 더 시작하지 않고 작업을 실패시킨다(재시도는 멱등).
 */
export async function postBatch(d: SettleDeps, data: { batchId: string }): Promise<void> {
  const runs = (await d.db.pool.query("SELECT run_id FROM settlement_run WHERE batch_id = $1 AND status = 'CONFIRMED' ORDER BY run_id", [data.batchId])).rows.map((r) => r.run_id as string);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < runs.length) {
      const runId = runs[next++]!;
      try {
        await d.db.tx((tx) => postConfirmedRun(tx, d.clock, runId));
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POST_CONCURRENCY, runs.length) }, worker));
}
