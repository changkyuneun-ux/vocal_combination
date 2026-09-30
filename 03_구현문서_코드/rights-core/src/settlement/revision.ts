import { audit } from "../platform/audit.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { lockBatching } from "../platform/locks.ts";
import { writeReversal } from "./reversal.ts";
import { releaseRunEvents, type SettleDeps } from "./service.ts";

const SETTLER = "sys_settler";

/**
 * revision-recorded(통합 설계 11.2-11): 새 revision이 대체한 이전 이벤트를 정리한다. 재시도·중복 실행에 안전하다.
 * 전역 배치 잠금 SHARED를 먼저 잡는다(진행 중인 배치 생성이 커밋된 뒤에 살아 있는 run을 찾는다 — 환불과 같은 규칙).
 * - 이전 이벤트가 살아 있는 run에 없으면 끝(배치는 대체된 이벤트를 후보에서 뺀다).
 * - 확정 전 run이면 VOIDED·이벤트 해제(다음 배치가 새 revision을 평가한다).
 * - 확정 run이면 이전 이벤트의 남은 정산액 전액을 CORRECTION으로 역분개한다(식별 이벤트 = 새 revision).
 * 역분개가 정산액 초과로 거부되면(버그 신호, 결정적) 역분개는 쓰지 않고 CORRECTION_REJECTED를 한 번만 감사에 남기고 끝낸다.
 */
export async function revisionRecorded(d: SettleDeps, data: { newEventId: string }): Promise<void> {
  try {
    await revisionInTx(d, data);
  } catch (e) {
    if (!(e instanceof DomainError && e.code === "CORRECTION_EXCEEDS_SETTLED")) throw e;
    await d.db.tx(async (tx) => {
      const seen = await tx.query("SELECT 1 FROM audit_log WHERE action_name = 'CORRECTION_REJECTED' AND entity_type = 'revenue_event' AND entity_id = $1", [data.newEventId]);
      if ((seen.rowCount ?? 0) > 0) return;
      await audit(tx, d.clock, {
        actor: SETTLER, action: "CORRECTION_REJECTED", entityType: "revenue_event", entityId: data.newEventId, after: { code: e.code, diagnostics: e.diagnostics },
      });
    });
  }
}

/**
 * 잠금 순서: 확정 run에서는 run 이벤트 행 → run(FOR SHARE, 분개 보장) 순서다(releaseHold·reverse-event와 같다). 그래서 CONFIRMED(끝 상태)는
 * 잠금 없이 읽고 곧바로 CORRECTION 경로로 간다. run을 FOR UPDATE로 잠그는 것은 확정 전 무효화 경로뿐이고(run → 이벤트 행, settle-run·verify-run·
 * 운영자 무효화와 같은 순서), 잠근 뒤 확정돼 있으면(확정과 경합) savepoint로 run 잠금을 풀고 CORRECTION 경로로 간다.
 */
async function revisionInTx(d: SettleDeps, data: { newEventId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    await lockBatching(tx, "SHARED");
    const s = (await tx.query("SELECT old_event_id FROM revenue_supersede WHERE new_event_id = $1", [data.newEventId])).rows[0];
    if (s === undefined) return;
    const old = s.old_event_id as string;
    const live = (await tx.query(
      "SELECT x.run_id, r.status FROM settlement_run_event x JOIN settlement_run r USING (run_id) WHERE x.event_id = $1 AND x.active", [old],
    )).rows[0];
    if (live === undefined) return;
    const target = { runId: live.run_id as string, oldEventId: old, newEventId: data.newEventId };
    if (live.status === "CONFIRMED") return correctConfirmed(d, tx, target);
    await tx.query("SAVEPOINT revision_run_lock");
    const run = (await tx.query("SELECT status FROM settlement_run WHERE run_id = $1 FOR UPDATE", [live.run_id])).rows[0];
    if (run.status === "CONFIRMED") {
      await tx.query("ROLLBACK TO SAVEPOINT revision_run_lock");
      return correctConfirmed(d, tx, target);
    }
    await tx.query("RELEASE SAVEPOINT revision_run_lock");
    if (run.status === "FAILED" || run.status === "VOIDED") return;
    await tx.query("UPDATE settlement_run SET status = 'VOIDED', diagnostics = $2 WHERE run_id = $1",
      [live.run_id, JSON.stringify([{ code: "SUPERSEDED_BEFORE_CONFIRMATION", path: "$", message: `${old} superseded by ${data.newEventId}` }])]);
    const released = await releaseRunEvents(tx, live.run_id);
    await audit(tx, d.clock, {
      actor: SETTLER, action: "RUN_VOIDED_BY_REVISION", entityType: "settlement_run", entityId: live.run_id,
      after: { from: run.status, superseded: old, by: data.newEventId, released },
    });
  });
}

/**
 * 확정 run에 있는 이전 revision의 CORRECTION 역분개(reverse-event와 같은 절차): 원 run 이벤트 행을 잠가 같은 이벤트의 다른 역분개·보류 해제와
 * 직렬화하고, 새 revision id로 멱등을 확인한 뒤, 남은 정산액(run 이벤트 순액 + 앞선 역분개 풀 합, 앞선 역분개는 음수) 전액을 되돌린다.
 */
async function correctConfirmed(d: SettleDeps, tx: Tx, input: { runId: string; oldEventId: string; newEventId: string }): Promise<void> {
  const x = (await tx.query(
    "SELECT net_amount_krw::text AS net FROM settlement_run_event WHERE run_id = $1 AND event_id = $2 AND active FOR UPDATE",
    [input.runId, input.oldEventId],
  )).rows[0];
  if (x === undefined) return;
  const done = await tx.query("SELECT 1 FROM reversal_run WHERE refund_event_id = $1", [input.newEventId]);
  if ((done.rowCount ?? 0) > 0) return;
  const reversed = (await tx.query(
    "SELECT COALESCE(SUM(amount_krw), 0)::text AS s FROM pool_line WHERE run_id = $1 AND event_id = $2 AND reversal_id IS NOT NULL",
    [input.runId, input.oldEventId],
  )).rows[0].s as string;
  const remaining = BigInt(x.net) + BigInt(reversed);
  if (remaining <= 0n) return;
  await writeReversal(d, tx, { runId: input.runId, eventId: input.oldEventId, identEventId: input.newEventId, reason: "CORRECTION", amount: remaining });
}
