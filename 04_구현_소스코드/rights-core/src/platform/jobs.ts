import { PgBoss, type Db as BossDb, type JobResult } from "pg-boss";
import pg from "pg";
import type { Tx } from "./db.ts";

export type JobName = "settle-run" | "verify-run" | "refund-recorded" | "revision-recorded" | "reverse-event" | "post-batch" | "submit-payout" | "poll-payout" | "apply-psp-result" | "audio-check" | "render-master";
export const JOB_NAMES: readonly JobName[] = ["settle-run", "verify-run", "refund-recorded", "revision-recorded", "reverse-event", "post-batch", "submit-payout", "poll-payout", "apply-psp-result", "audio-check", "render-master"];
/** startAfterSeconds: 이 초만큼 뒤에 처리한다(pg-boss startAfter). 기록용 큐는 지연 없이 바로 처리 대상으로 둔다. */
export type SendOptions = { startAfterSeconds?: number };
export type Jobs = { send(tx: Tx, name: JobName, data: Record<string, string>, opts?: SendOptions): Promise<void> };
export type JobHandler = (data: Record<string, string>) => Promise<void>;
export type BossJobs = Jobs & {
  work(handlers: Record<JobName, JobHandler>): Promise<void>;
  /** 개발 전용(운영 경로는 부르지 않는다): 그 큐의 워커만 멈추고(진행 중 작업은 끝까지 기다린다) 작업은 큐에 쌓아 둔다. work() 뒤에만 쓴다. */
  pause(name: JobName): Promise<void>;
  /** 개발 전용: pause한 큐를 같은 처리기·옵션으로 다시 연다. 멈추지 않은 큐에는 아무 일도 하지 않는다. */
  resume(name: JobName): Promise<void>;
  drainIdle(timeoutMs: number): Promise<void>;
  stop(): Promise<void>;
};
/** 테스트용: 보낸 작업을 트랜잭션 커밋과 무관하게 기록한다. drain은 핸들러를 순서대로 호출하고 새로 쌓인 작업도 처리한다. 처리기가 없는 작업은 대기로 남는다. */
export type RecordingJobs = Jobs & { sent: { name: JobName; data: Record<string, string>; startAfterSeconds?: number }[]; drain(handlers: Partial<Record<JobName, JobHandler>>): Promise<number> };

const SCHEMA = "pgboss";
/** 아직 끝나지 않은 작업 상태(대기·재시도·실행 중). */
const PENDING_STATES = ["created", "retry", "active"] as const;

/** 같은 트랜잭션에서 작업을 넣기 위한 실행기(통합 설계 10.2-1). */
const txExecutor = (tx: Tx): BossDb => ({ executeSql: (text: string, values?: unknown[]) => tx.query(text, values) });

/** 템플릿 DB를 만들 때 소유자 역할로 pg-boss 스키마와 큐를 설치하고 rc_app에 권한을 준다(스키마 소유권은 넘기지 않는다). */
export async function installJobSchema(adminUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: adminUrl, schema: SCHEMA, supervise: false, schedule: false });
  boss.on("error", (e: unknown) => console.error("pg-boss(install)", e));
  await boss.start();
  try {
    for (const name of JOB_NAMES) await boss.createQueue(name);
  } finally {
    await boss.stop({ graceful: false });
  }
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO rc_app`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO rc_app`);
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO rc_app`);
    await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} TO rc_app`);
  } finally {
    await c.end();
  }
}

/** 워커 처리량 설정. 기본값(1·1)은 한 번에 한 작업. batchSize > 1이면 가득 찬 배치가 오는 동안 대기 없이 연속으로 가져온다. */
export type BossWorkOptions = { batchSize?: number; localConcurrency?: number };

/**
 * 서버 워커 설정을 환경 변수에서 읽는다: RC_JOB_BATCH_SIZE(기본 20), RC_JOB_CONCURRENCY(기본 4).
 * 기본값은 I-2a 시나리오에서 쓴 값이다(1·1은 작업마다 폴링 간격만큼 쉰다 — 통합 설계 10.4). 양의 정수가 아니면 시작을 거부한다.
 */
export function workOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): Required<BossWorkOptions> {
  const read = (name: string, dflt: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return dflt;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got ${raw}`);
    return n;
  };
  return { batchSize: read("RC_JOB_BATCH_SIZE", 20), localConcurrency: read("RC_JOB_CONCURRENCY", 4) };
}

/** rc_app 역할로 pg-boss에 붙는다. 스키마는 installJobSchema가 이미 만들어 두었으므로 만들거나 이관하지 않는다. */
export async function startBossJobs(appUrl: string, opts: BossWorkOptions = {}): Promise<BossJobs> {
  const boss = new PgBoss({ connectionString: appUrl, schema: SCHEMA, migrate: false, createSchema: false, schedule: false });
  boss.on("error", (e: unknown) => console.error("pg-boss", e));
  await boss.start();
  const batchSize = opts.batchSize ?? 1;
  const localConcurrency = opts.localConcurrency ?? 1;
  let inFlight = 0;
  const registered = new Map<JobName, JobHandler>();
  const active = new Set<JobName>();
  async function register(name: JobName): Promise<void> {
    const handler = registered.get(name)!;
    // 작업별 결과: 배치 안의 한 작업이 실패해도 그 작업만 재시도한다(나머지는 완료로 남는다).
    const options = { pollingIntervalSeconds: 0.5, batchSize, localConcurrency, burstWhenBatchFull: batchSize > 1, perJobResults: true } as const;
    await boss.work<Record<string, string>, unknown, typeof options>(name, options, async (batch) => {
      const results: JobResult[] = [];
      for (const job of batch) {
        inFlight++;
        try {
          await handler(job.data);
          results.push({ id: job.id, status: "completed" });
        } catch (e) {
          console.error(`job ${name} ${job.id} failed:`, e instanceof Error ? e.message : e);
          results.push({ id: job.id, status: "failed", output: { message: e instanceof Error ? e.message : String(e) } });
        } finally {
          inFlight--;
        }
      }
      return results;
    });
    active.add(name);
  }
  return {
    async send(tx, name, data, opts) {
      const startAfter = opts?.startAfterSeconds;
      await boss.send(name, data, { db: txExecutor(tx), retryLimit: 5, retryBackoff: true, ...(startAfter === undefined ? {} : { startAfter }) });
    },
    async work(handlers) {
      for (const name of JOB_NAMES) {
        registered.set(name, handlers[name]);
        await register(name);
      }
    },
    async pause(name) {
      if (!registered.has(name)) throw new Error(`jobs.pause(${name}): work() has not registered handlers yet`);
      if (!active.has(name)) return;
      active.delete(name);
      await boss.offWork(name);
    },
    async resume(name) {
      if (!registered.has(name)) throw new Error(`jobs.resume(${name}): work() has not registered handlers yet`);
      if (active.has(name)) return;
      await register(name);
    },
    async drainIdle(timeoutMs) {
      // 끝나지 않은 작업만 센다(findJobs는 완료된 작업까지 전부 읽어 수만 건이면 느리다).
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await boss.getDb().executeSql(
          `SELECT count(*)::int AS n FROM ${SCHEMA}.job WHERE name = ANY($1) AND state = ANY($2::${SCHEMA}.job_state[])`,
          [[...JOB_NAMES], [...PENDING_STATES]],
        );
        const pending = (r.rows[0].n as number) + inFlight;
        if (pending === 0) return;
        if (Date.now() > deadline) throw new Error(`jobs did not drain within ${timeoutMs}ms (${pending} pending)`);
        await new Promise((res) => setTimeout(res, 100));
      }
    },
    stop: () => boss.stop({ graceful: true }),
  };
}

export function recordingJobs(): RecordingJobs {
  const sent: { name: JobName; data: Record<string, string>; startAfterSeconds?: number }[] = [];
  const done: boolean[] = [];
  return {
    sent,
    async send(_tx, name, data, opts) {
      sent.push(opts?.startAfterSeconds === undefined ? { name, data: { ...data } } : { name, data: { ...data }, startAfterSeconds: opts.startAfterSeconds });
      done.push(false);
    },
    async drain(handlers) {
      // 처리기가 없는 작업은 소비하지 않고 남겨 두어, 더 넓은 처리기 맵으로 다시 drain할 때 처리한다.
      let n = 0;
      for (;;) {
        const i = sent.findIndex((job, k) => !done[k] && handlers[job.name] !== undefined);
        if (i < 0) return n;
        done[i] = true;
        await handlers[sent[i]!.name]!(sent[i]!.data);
        n++;
      }
    },
  };
}
