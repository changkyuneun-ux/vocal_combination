import { test, after } from "node:test";
import assert from "node:assert/strict";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

// INSERT 경로 가드(통합 설계 11.2-12): 가드는 BEFORE INSERT 트리거이고 위반은 RC001이다.
const w = await settlementWorld();
after(() => w.drop());
const seal = await issueCombo(w, "vc_1");
const D1 = seal.projectionDigest;
const D2 = seal.membersDigest;
const q = (sql: string, params: unknown[] = []) => w.db.pool.query(sql, params);
const rc001 = (e: { code?: string }) => e.code === "RC001";
const AT = "2026-04-01T00:00:00.000Z";
const PERIOD = ["2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"];

let n = 0;
const newBatch = async () => {
  n += 1;
  const batchId = `bat_${n}`;
  await q("INSERT INTO settlement_batch (batch_id, period_start, period_end, executed_by, created_at) VALUES ($1,$2,$3,'usr_ops',$4)", [batchId, ...PERIOD, AT]);
  return batchId;
};
/** 배치 + PENDING run + 이벤트 1개를 만들고 요청한 상태까지 UPDATE로 옮긴다. */
async function runIn(state: "PENDING" | "CALCULATED" | "VERIFIED" | "CONFIRMED" | "VOIDED"): Promise<{ batchId: string; runId: string; eventId: string }> {
  const batchId = await newBatch();
  const runId = `run_${n}`, eventId = `ev_${n}`;
  await q("INSERT INTO settlement_run (run_id, batch_id, snapshot_id, created_at) VALUES ($1,$2,$3,$4)", [runId, batchId, seal.snapshotId, AT]);
  await purchase(w, eventId, "vc_1", "1000");
  await q("INSERT INTO settlement_run_event (run_id, event_id, net_amount_krw, refunds_included_krw) VALUES ($1,$2,1000,0)", [runId, eventId]);
  if (state === "VOIDED") await q("UPDATE settlement_run SET status = 'VOIDED', diagnostics = '[]' WHERE run_id = $1", [runId]);
  if (state === "CALCULATED" || state === "VERIFIED" || state === "CONFIRMED") {
    await q("UPDATE settlement_run SET status = 'CALCULATED', events_digest = $2, result_digest = $3 WHERE run_id = $1", [runId, D1, D2]);
  }
  if (state === "VERIFIED" || state === "CONFIRMED") {
    await q("UPDATE settlement_run SET status = 'VERIFIED', verified_by = 'sys_verifier', verified_at = $2 WHERE run_id = $1", [runId, AT]);
  }
  if (state === "CONFIRMED") await q("UPDATE settlement_run SET status = 'CONFIRMED' WHERE run_id = $1", [runId]);
  return { batchId, runId, eventId };
}
const confirmBatch = (batchId: string) =>
  q("UPDATE settlement_batch SET status = 'CONFIRMED', confirmed_by = 'usr_settle', confirmed_at = $2, batch_manifest_digest = $3 WHERE batch_id = $1", [batchId, AT, D1]);

let revs = 0;
const reversal = async (runId: string, eventId: string) => {
  revs += 1;
  const reversalId = `rev_${revs}`, refundId = `rf_${revs}`;
  await q(`INSERT INTO revenue_event (event_id, source_system, source_event_id, event_type, related_event_id, net_amount_krw, currency, occurred_at, recorded_at)
           VALUES ($1, 'app', $4, 'REFUND', $2, 10, 'KRW', $3, $3)`, [refundId, eventId, AT, refundId]);
  await q("INSERT INTO reversal_run (reversal_id, original_run_id, event_id, sequence, refund_event_id, result_digest, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [reversalId, runId, eventId, revs, refundId, D1, AT]);
  return { reversalId, seq: revs + 1 };
};
const poolLine = (runId: string, eventId: string, seq: number, reversalId: string | null, bucket = "rights") =>
  q("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw, reversal_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [runId, eventId, bucket, seq, seq === 1 ? 1000 : -10, reversalId]);
const allocLine = (runId: string, eventId: string, seq: number, reversalId: string | null, ofLine: string | null = null) =>
  q(`INSERT INTO allocation_line (run_id, event_id, party_id, role, bucket, line_seq, line_kind, amount_krw, reversal_of_line_id, reversal_id)
     VALUES ($1,$2,'pty_label','LABEL','rights',$3,$4,$5,$6,$7) RETURNING line_id::text AS id`,
  [runId, eventId, seq, seq === 1 ? "SETTLE" : "REVERSAL", seq === 1 ? 1000 : -10, ofLine, reversalId]);
const holding = (runId: string, eventId: string, seq: number, reversalId: string | null) =>
  q("INSERT INTO unallocated_holding (run_id, event_id, bucket, reason, line_seq, amount_krw, reversal_id) VALUES ($1,$2,'rights','FRAUD_REVIEW',$3,$4,$5)",
    [runId, eventId, seq, seq === 1 ? 1000 : -10, reversalId]);

test("settlement_batch is inserted only as OPEN", async () => {
  await assert.rejects(q(
    `INSERT INTO settlement_batch (batch_id, period_start, period_end, status, executed_by, created_at, confirmed_by, confirmed_at, batch_manifest_digest)
     VALUES ('bat_confirmed', $1, $2, 'CONFIRMED', 'usr_ops', $3, 'usr_settle', $3, $4)`, [...PERIOD, AT, D1]), rc001);
  await newBatch();
});

test("settlement_run is inserted only as PENDING with no digests or verification, into an OPEN batch", async () => {
  const batchId = await newBatch();
  const ins = (runId: string, cols: string, vals: string, params: unknown[]) =>
    q(`INSERT INTO settlement_run (run_id, batch_id, snapshot_id, created_at${cols}) VALUES ($1,$2,$3,$4${vals})`, [runId, batchId, seal.snapshotId, AT, ...params]);
  await assert.rejects(ins("run_calc", ", status, events_digest, result_digest", ",'CALCULATED',$5,$6", [D1, D2]), rc001, "non-PENDING run");
  await assert.rejects(ins("run_ev", ", events_digest", ",$5", [D1]), rc001, "PENDING run with an events digest");
  await assert.rejects(ins("run_res", ", result_digest", ",$5", [D2]), rc001, "PENDING run with a result digest");
  await assert.rejects(ins("run_vb", ", verified_by", ",$5", ["sys_verifier"]), rc001, "PENDING run with a verifier");
  await assert.rejects(ins("run_va", ", verified_at", ",$5", [AT]), rc001, "PENDING run with a verification time");
  await assert.rejects(ins("run_diag", ", diagnostics", ",$5", ["[]"]), rc001, "PENDING run with diagnostics");
  await ins("run_ok", "", "", []);
  const confirmed = await newBatch();
  await confirmBatch(confirmed);
  await assert.rejects(q("INSERT INTO settlement_run (run_id, batch_id, snapshot_id, created_at) VALUES ('run_late', $1, $2, $3)", [confirmed, seal.snapshotId, AT]), rc001,
    "run added to a CONFIRMED batch");
});

test("settlement_run_event is inserted only while its run is PENDING", async () => {
  for (const state of ["CALCULATED", "VERIFIED", "CONFIRMED", "VOIDED"] as const) {
    const { runId } = await runIn(state);
    await purchase(w, `ev_extra_${n}`, "vc_1", "500");
    await assert.rejects(q("INSERT INTO settlement_run_event (run_id, event_id, net_amount_krw, refunds_included_krw) VALUES ($1,$2,500,0)", [runId, `ev_extra_${n}`]),
      rc001, `event added to a ${state} run`);
  }
});

test("line_seq = 1 lines and holdings are inserted only while the run is PENDING", async () => {
  const p = await runIn("PENDING");
  await poolLine(p.runId, p.eventId, 1, null);
  await allocLine(p.runId, p.eventId, 1, null);
  await holding(p.runId, p.eventId, 1, null);
  for (const state of ["CALCULATED", "VERIFIED", "CONFIRMED", "VOIDED"] as const) {
    const r = await runIn(state);
    await assert.rejects(poolLine(r.runId, r.eventId, 1, null), rc001, `pool line on a ${state} run`);
    await assert.rejects(allocLine(r.runId, r.eventId, 1, null), rc001, `allocation line on a ${state} run`);
    await assert.rejects(holding(r.runId, r.eventId, 1, null), rc001, `holding on a ${state} run`);
  }
});

test("line_seq > 1 (reversal) lines and holdings are inserted only when the run is CONFIRMED", async () => {
  // PENDING run에 line_seq = 2: 역분개 행은 확정 run에만.
  const p = await runIn("PENDING");
  await poolLine(p.runId, p.eventId, 1, null);
  const pl = await allocLine(p.runId, p.eventId, 1, null);
  await holding(p.runId, p.eventId, 1, null);
  const pr = await reversal(p.runId, p.eventId);
  await assert.rejects(poolLine(p.runId, p.eventId, pr.seq, pr.reversalId), rc001, "reversal pool line on a PENDING run");
  await assert.rejects(allocLine(p.runId, p.eventId, pr.seq, pr.reversalId, pl.rows[0].id), rc001, "reversal allocation line on a PENDING run");
  await assert.rejects(holding(p.runId, p.eventId, pr.seq, pr.reversalId), rc001, "reversal holding on a PENDING run");
  for (const state of ["CALCULATED", "VERIFIED", "VOIDED"] as const) {
    const r = await runIn(state);
    const v = await reversal(r.runId, r.eventId);
    await assert.rejects(poolLine(r.runId, r.eventId, v.seq, v.reversalId), rc001, `reversal pool line on a ${state} run`);
    await assert.rejects(holding(r.runId, r.eventId, v.seq, v.reversalId), rc001, `reversal holding on a ${state} run`);
  }
  // 확정 run의 역분개 행은 들어간다(원 라인은 PENDING일 때 넣고 확정까지 옮긴다).
  const c = await runIn("PENDING");
  await poolLine(c.runId, c.eventId, 1, null);
  const cl = await allocLine(c.runId, c.eventId, 1, null);
  await holding(c.runId, c.eventId, 1, null);
  await q("UPDATE settlement_run SET status = 'CALCULATED', events_digest = $2, result_digest = $3 WHERE run_id = $1", [c.runId, D1, D2]);
  await q("UPDATE settlement_run SET status = 'VERIFIED', verified_by = 'sys_verifier', verified_at = $2 WHERE run_id = $1", [c.runId, AT]);
  await q("UPDATE settlement_run SET status = 'CONFIRMED' WHERE run_id = $1", [c.runId]);
  const cr = await reversal(c.runId, c.eventId);
  await poolLine(c.runId, c.eventId, cr.seq, cr.reversalId);
  await allocLine(c.runId, c.eventId, cr.seq, cr.reversalId, cl.rows[0].id);
  await holding(c.runId, c.eventId, cr.seq, cr.reversalId);
});
