import type { Clock } from "../platform/clock.ts";
import type { Db } from "../platform/db.ts";
import { dueForSweep, revalidate } from "./service.ts";

/** RC_VALIDATION_SWEEP_MS: 정기 검사 간격(기본 1시간). 0이면 끈다. 곡마다 하루에 한 번 이상 다시 검사된다(SWEEP_STALE_HOURS). */
export function sweepIntervalFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.RC_VALIDATION_SWEEP_MS;
  if (raw === undefined || raw === "") return 3_600_000;
  if (!/^\d+$/.test(raw)) throw new Error(`RC_VALIDATION_SWEEP_MS must be a non-negative integer, got ${raw}`);
  return Number(raw);
}

/** 한 번 돌린다: 다시 볼 곡을 고르고 곡마다 따로 트랜잭션을 연다(한 곡의 실패가 다른 곡을 막지 않는다). 검사한 곡 수를 돌려준다. */
export async function runValidationSweep(db: Db, clock: Clock, limit = 200): Promise<number> {
  const scopes = await db.tx((tx) => dueForSweep(tx, clock.now(), limit));
  let n = 0;
  for (const s of scopes) {
    try {
      await db.tx((tx) => revalidate(tx, clock, s));
      n++;
    } catch (e) {
      console.error("validation sweep", s, e);
    }
  }
  return n;
}

/** 정기 검사(원천 문서 설계 S3b): 간격마다 runValidationSweep. 앞 회차가 끝나지 않았으면 건너뛴다. */
export function startValidationSweeper(db: Db, clock: Clock, intervalMs: number): () => void {
  if (intervalMs === 0) return () => {};
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    runValidationSweep(db, clock).catch((e) => console.error("validation sweep", e)).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
