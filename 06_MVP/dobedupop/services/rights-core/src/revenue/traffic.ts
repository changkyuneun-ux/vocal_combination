import { withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { policyEventTypes } from "../engine-bridge/settle.ts";
import { ingestRevenue, type RefundHook, type RevisionHook } from "./service.ts";
import { assertExposed } from "../exposure/service.ts";
import { withPermissions, requirePermission } from "../platform/permissions.ts";

/** 유효 재생 기준: 30초 이상 들었으면 한 번으로 센다. */
export const COUNTED_MS = 30_000;
/** 같은 사용자가 같은 조합을 24시간 안에 이보다 많이 유효 재생하면 그 뒤 재생은 FLAGGED(배정에서 뺀다). */
export const DAILY_PLAY_LIMIT = 10;

const ID = /^[A-Za-z0-9._-]+$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 재생 보고(팬 앱): 발행된 조합만, 재생 시각은 코어 시계. play_id로 멱등(같은 내용이면 기존 행, 다르면 409).
 * 유효 재생(30초 이상)이 같은 사용자·조합의 24시간 한도를 넘으면 FLAGGED로 남긴다(기록은 하되 배정하지 않는다).
 */
export async function recordPlay(tx: Tx, clock: Clock, actor: Actor, input: { playId?: unknown; vcId?: unknown; durationMs?: unknown; source?: string }) {
  const { playId, vcId, durationMs } = input;
  if (typeof playId !== "string" || !ID.test(playId) || typeof vcId !== "string" || !ID.test(vcId)) throw new DomainError("BAD_REQUEST", 400, "playId and vcId are required ids");
  if (!Number.isSafeInteger(durationMs) || (durationMs as number) < 0) throw new DomainError("BAD_REQUEST", 400, "durationMs must be a non-negative integer");
  return withSystemScope(tx, async () => {
    const prev = (await tx.query("SELECT * FROM play_event WHERE play_id = $1", [playId])).rows[0];
    if (prev !== undefined) {
      if (prev.vc_id !== vcId || prev.user_id !== actor.userId || prev.duration_ms !== durationMs) throw conflict("IDEMPOTENCY_MISMATCH", `play ${playId} was recorded with different content`);
      return toPlay(prev);
    }
    if ((await tx.query("SELECT 1 FROM rights_snapshot WHERE vc_id = $1", [vcId])).rowCount === 0) throw notFound("combination", vcId);
    await assertExposed(tx, vcId); // 노출이 멈춘 조합의 재생은 기록하지 않는다(감상 매출이 생기지 않는다)
    const now = clock.now();
    const counted = (durationMs as number) >= COUNTED_MS;
    // 같은 사용자·조합의 재생 판정을 직렬화한다(한도 경계에서 둘 다 CLEAR가 되지 않게).
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('play:' || $1, 0))", [`${actor.userId}/${vcId}`]);
    const recent = Number((await tx.query(
      "SELECT count(*) AS n FROM play_event WHERE user_id = $1 AND vc_id = $2 AND counted AND played_at > $3",
      [actor.userId, vcId, new Date(Date.parse(now) - 86_400_000).toISOString()],
    )).rows[0].n);
    const integrity = counted && recent >= DAILY_PLAY_LIMIT ? "FLAGGED" : "CLEAR";
    const row = (await tx.query(
      "INSERT INTO play_event (play_id, vc_id, user_id, source, duration_ms, counted, integrity, played_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [playId, vcId, actor.userId, input.source ?? "fan_app", durationMs, counted, integrity, now],
    )).rows[0];
    return toPlay(row);
  });
}

function toPlay(r: any) {
  return { playId: r.play_id as string, vcId: r.vc_id as string, durationMs: r.duration_ms as number, counted: r.counted as boolean, integrity: r.integrity as string, playedAt: iso(r.played_at)! };
}

export type PoolInput = { poolId?: unknown; source?: unknown; periodStart?: unknown; periodEnd?: unknown; amountKrw?: unknown };

/** 기간 수익 풀 등록(정산 담당): 구독 또는 광고 수익의 한 기간치. */
export async function createPool(tx: Tx, clock: Clock, actor: Actor, i: PoolInput) {
  requirePermission(actor, "traffic.manage");
  const bad = (m: string) => invalid("INVALID_POOL", m);
  if (typeof i.poolId !== "string" || !ID.test(i.poolId)) throw bad("poolId must be an id");
  if (i.source !== "SUBSCRIPTION" && i.source !== "AD") throw bad("source must be SUBSCRIPTION or AD");
  for (const t of [i.periodStart, i.periodEnd]) {
    if (typeof t !== "string" || !INSTANT.test(t) || new Date(t).toISOString() !== t) throw bad("periodStart and periodEnd must be ms UTC ISO");
  }
  if ((i.periodStart as string) >= (i.periodEnd as string)) throw bad("periodStart must be before periodEnd");
  if (typeof i.amountKrw !== "string" || !/^[1-9]\d*$/.test(i.amountKrw)) throw bad("amountKrw must be a positive integer string");
  await tx.query(
    "INSERT INTO traffic_pool (pool_id, source, period_start, period_end, amount_krw, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [i.poolId, i.source, i.periodStart, i.periodEnd, i.amountKrw, actor.userId, clock.now()],
  );
  await audit(tx, clock, { actor: actor.userId, action: "TRAFFIC_POOL_CREATED", entityType: "traffic_pool", entityId: i.poolId, after: { source: i.source, amount: i.amountKrw } });
  return getPool(tx, i.poolId);
}

/**
 * 몫 나누기(최대잉여): 재생 수에 비례한 내림 몫을 주고, 남은 원은 소수부가 큰 순(같으면 조합 id 순)으로 1원씩 준다. 합 = 풀 금액.
 */
export function splitByPlays(amount: bigint, plays: { vcId: string; plays: number }[]): Map<string, bigint> {
  const total = BigInt(plays.reduce((a, p) => a + p.plays, 0));
  const parts = plays.map((p) => ({ vcId: p.vcId, floor: (amount * BigInt(p.plays)) / total, rem: (amount * BigInt(p.plays)) % total }));
  const out = new Map(parts.map((p) => [p.vcId, p.floor]));
  let rest = amount - parts.reduce((a, p) => a + p.floor, 0n);
  for (const p of [...parts].sort((a, b) => (a.rem === b.rem ? (a.vcId < b.vcId ? -1 : 1) : a.rem > b.rem ? -1 : 1))) {
    if (rest <= 0n) break;
    out.set(p.vcId, out.get(p.vcId)! + 1n);
    rest -= 1n;
  }
  return out;
}

/**
 * 풀 배정(정산 담당): 기간의 유효·CLEAR 재생을 조합별로 세고 비중대로 나눠, 조합마다 TRAFFIC 매출 이벤트를 만든다.
 * 이벤트 시각은 기간의 마지막 밀리초라 같은 기간 정산 배치에 들어간다. 조합의 봉인 정책이 TRAFFIC을 받지 않으면 그 재생은 뺀다
 * (그대로 넣으면 엔진이 run을 거부해 조합이 격리된다). 한 번만 배정한다. 유효 재생이 없으면 NO_PLAYS로 닫고 금액은 남는다.
 */
export async function allocatePool(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, poolId: string, onRefund: RefundHook, onRevision: RevisionHook) {
  requirePermission(actor, "traffic.manage");
  const pool = (await tx.query("SELECT * FROM traffic_pool WHERE pool_id = $1 FOR UPDATE", [poolId])).rows[0];
  if (pool === undefined) throw notFound("traffic pool", poolId);
  if (pool.status !== "OPEN") throw conflict("POOL_ALREADY_ALLOCATED", `pool ${poolId} is ${pool.status}`);
  const start = iso(pool.period_start)!;
  const end = iso(pool.period_end)!;
  const rows = (await tx.query(
    `SELECT p.vc_id, i.policy_digest, count(*) FILTER (WHERE p.integrity = 'CLEAR')::int AS clear, count(*) FILTER (WHERE p.integrity = 'FLAGGED')::int AS flagged
       FROM play_event p JOIN rights_snapshot s ON s.vc_id = p.vc_id JOIN issue_seal i ON i.snapshot_id = s.snapshot_id
      WHERE p.counted AND p.played_at >= $1 AND p.played_at < $2 GROUP BY p.vc_id, i.policy_digest ORDER BY p.vc_id`, [start, end],
  )).rows;
  const excluded = { FLAGGED: 0, POLICY_NO_TRAFFIC: 0 };
  const accepts = new Map<string, boolean>();
  const eligible: { vcId: string; plays: number }[] = [];
  for (const r of rows) {
    excluded.FLAGGED += r.flagged as number;
    if (r.clear === 0) continue;
    if (!accepts.has(r.policy_digest)) accepts.set(r.policy_digest, (await policyEventTypes(ctx, tx, r.policy_digest)).includes("TRAFFIC"));
    if (!accepts.get(r.policy_digest)) { excluded.POLICY_NO_TRAFFIC += r.clear as number; continue; }
    eligible.push({ vcId: r.vc_id as string, plays: r.clear as number });
  }
  const now = clock.now();
  if (eligible.length === 0) {
    await tx.query("UPDATE traffic_pool SET status = 'NO_PLAYS', excluded = $2, allocated_by = $3, allocated_at = $4 WHERE pool_id = $1", [poolId, JSON.stringify(excluded), actor.userId, now]);
    await audit(tx, clock, { actor: actor.userId, action: "TRAFFIC_POOL_NO_PLAYS", entityType: "traffic_pool", entityId: poolId, after: { excluded } });
    return getPool(tx, poolId);
  }
  const shares = splitByPlays(BigInt(pool.amount_krw), eligible);
  const occurredAt = new Date(Date.parse(end) - 1).toISOString();
  // 매출 수집은 수집 신원(SYSTEM)의 일이다. 배정을 실행한 정산 담당이 감사 행위자로 남는다.
  const ingester: Actor = { ...withPermissions(actor, ["revenue.ingest"]), roles: new Set([...actor.roles, "SYSTEM"]) };
  for (const e of eligible) {
    const amount = shares.get(e.vcId)!;
    let eventId: string | null = null;
    if (amount > 0n) {
      eventId = `ev_tr_${poolId}_${e.vcId}`;
      await ingestRevenue(tx, clock, ingester, {
        eventId, sourceSystem: "traffic_pool", sourceEventId: `${poolId}/${e.vcId}`, eventType: "TRAFFIC", vcId: e.vcId,
        amountKrw: amount.toString(), currency: "KRW", occurredAt,
      }, onRefund, onRevision);
    }
    await tx.query("INSERT INTO traffic_allocation (pool_id, vc_id, plays, amount_krw, event_id) VALUES ($1,$2,$3,$4,$5)", [poolId, e.vcId, e.plays, amount.toString(), eventId]);
  }
  await tx.query("UPDATE traffic_pool SET status = 'ALLOCATED', excluded = $2, allocated_by = $3, allocated_at = $4 WHERE pool_id = $1", [poolId, JSON.stringify(excluded), actor.userId, now]);
  await audit(tx, clock, { actor: actor.userId, action: "TRAFFIC_POOL_ALLOCATED", entityType: "traffic_pool", entityId: poolId, after: { combinations: eligible.length, excluded } });
  return getPool(tx, poolId);
}

export async function getPool(tx: Tx, poolId: string) {
  const p = (await tx.query("SELECT * FROM traffic_pool WHERE pool_id = $1", [poolId])).rows[0];
  if (p === undefined) throw notFound("traffic pool", poolId);
  const allocations = (await tx.query("SELECT vc_id, plays, amount_krw::text AS amount, event_id FROM traffic_allocation WHERE pool_id = $1 ORDER BY vc_id", [poolId])).rows;
  return {
    poolId: p.pool_id as string, source: p.source as string, periodStart: iso(p.period_start)!, periodEnd: iso(p.period_end)!, amountKrw: String(p.amount_krw),
    status: p.status as string, ...(p.excluded !== null && { excluded: p.excluded as Record<string, number> }),
    createdBy: p.created_by as string, createdAt: iso(p.created_at)!, ...(p.allocated_at !== null && { allocatedBy: p.allocated_by as string, allocatedAt: iso(p.allocated_at)! }),
    allocations: allocations.map((a) => ({ vcId: a.vc_id as string, plays: a.plays as number, amountKrw: a.amount as string, ...(a.event_id !== null && { eventId: a.event_id as string }) })),
  };
}

export async function listPools(tx: Tx) {
  const ids = (await tx.query("SELECT pool_id FROM traffic_pool ORDER BY period_start DESC, pool_id")).rows;
  const out = [];
  for (const r of ids) out.push(await getPool(tx, r.pool_id as string));
  return out;
}
