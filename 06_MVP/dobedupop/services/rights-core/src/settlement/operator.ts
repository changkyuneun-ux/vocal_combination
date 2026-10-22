import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, invalid, notFound } from "../platform/errors.ts";
import type { JobName } from "../platform/jobs.ts";
import { releaseRunEvents, type SettleDeps } from "./service.ts";
import { requirePermission } from "../platform/permissions.ts";

/** 무효화 사유의 최대 길이(진단·감사에 그대로 들어간다). */
export const MAX_VOID_REASON = 500;
const VOIDABLE = new Set(["PENDING", "CALCULATED", "VERIFIED"]);
const REQUEUE_JOB: Record<string, JobName> = { PENDING: "settle-run", CALCULATED: "verify-run" };

async function lockRun(tx: Tx, runId: string): Promise<string> {
  const run = (await tx.query("SELECT status FROM settlement_run WHERE run_id = $1 FOR UPDATE", [runId])).rows[0];
  if (run === undefined) throw notFound("run", runId);
  return run.status as string;
}

/**
 * 운영자 run 무효화(통합 설계 11.2-9, settlement.operate): 확정 전(PENDING·CALCULATED·VERIFIED) run을 VOIDED로 바꾸고 이벤트를 푼다.
 * run을 잠가 settle-run·verify-run·confirmBatch와 직렬화한다. 이미 쌓인 작업은 상태를 보고 아무것도 하지 않는다.
 * 0011 가드 순서: run을 먼저 VOIDED로 바꾼 뒤 이벤트를 푼다. 풀린 이벤트는 다음 배치의 후보가 된다.
 */
export async function voidRun(d: SettleDeps, actor: Actor, runId: string, reason: string) {
  requirePermission(actor, "settlement.operate");
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > MAX_VOID_REASON) {
    throw invalid("INVALID_REASON", `reason must be a non-empty string of at most ${MAX_VOID_REASON} characters`);
  }
  return d.db.tx(async (tx) => {
    const from = await lockRun(tx, runId);
    if (!VOIDABLE.has(from)) throw conflict("INVALID_STATE", `run ${runId} is ${from}`);
    await tx.query("UPDATE settlement_run SET status = 'VOIDED', diagnostics = $2 WHERE run_id = $1",
      [runId, JSON.stringify([{ code: "OPERATOR_VOID", path: "$", message: reason }])]);
    const released = await releaseRunEvents(tx, runId);
    await audit(tx, d.clock, { actor: actor.userId, action: "RUN_VOIDED_BY_OPERATOR", entityType: "settlement_run", entityId: runId, after: { from, reason, released } });
    return { runId, from, status: "VOIDED" as const, released };
  });
}

/** 운영자 run 재큐잉(통합 설계 11.2-9, settlement.operate): PENDING → settle-run, CALCULATED → verify-run을 다시 보낸다. 처리기는 상태를 보고 멱등이다. */
export async function requeueRun(d: SettleDeps, actor: Actor, runId: string) {
  requirePermission(actor, "settlement.operate");
  return d.db.tx(async (tx) => {
    const status = await lockRun(tx, runId);
    const job = REQUEUE_JOB[status];
    if (job === undefined) throw conflict("INVALID_STATE", `run ${runId} is ${status}`);
    await d.jobs.send(tx, job, { runId });
    await audit(tx, d.clock, { actor: actor.userId, action: "RUN_REQUEUED", entityType: "settlement_run", entityId: runId, after: { status, job } });
    return { runId, status, job };
  });
}
