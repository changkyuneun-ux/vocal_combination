import { PgBoss, type Db as BossDb } from "pg-boss";
import pg from "pg";
import type { Tx } from "./db.ts";

export type JobName = "settle-run" | "verify-run" | "refund-recorded" | "reverse-event";
export const JOB_NAMES: readonly JobName[] = ["settle-run", "verify-run", "refund-recorded", "reverse-event"];
export type Jobs = { send(tx: Tx, name: JobName, data: Record<string, string>): Promise<void> };
export type JobHandler = (data: Record<string, string>) => Promise<void>;
export type BossJobs = Jobs & { work(handlers: Record<JobName, JobHandler>): Promise<void>; drainIdle(timeoutMs: number): Promise<void>; stop(): Promise<void> };
/** 테스트용: 보낸 작업을 트랜잭션 커밋과 무관하게 기록한다. drain은 핸들러를 순서대로 호출하고 새로 쌓인 작업도 처리한다. 처리기가 없는 작업은 대기로 남는다. */
export type RecordingJobs = Jobs & { sent: { name: JobName; data: Record<string, string> }[]; drain(handlers: Partial<Record<JobName, JobHandler>>): Promise<number> };

const SCHEMA = "pgboss";
/** 아직 끝나지 않은 작업 상태(대기·재시도·실행 중). */
const PENDING_STATES = new Set(["created", "retry", "active"]);

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

/** rc_app 역할로 pg-boss에 붙는다. 스키마는 installJobSchema가 이미 만들어 두었으므로 만들거나 이관하지 않는다. */
export async function startBossJobs(appUrl: string): Promise<BossJobs> {
  const boss = new PgBoss({ connectionString: appUrl, schema: SCHEMA, migrate: false, createSchema: false, schedule: false });
  boss.on("error", (e: unknown) => console.error("pg-boss", e));
  await boss.start();
  let inFlight = 0;
  return {
    async send(tx, name, data) {
      await boss.send(name, data, { db: txExecutor(tx), retryLimit: 5, retryBackoff: true });
    },
    async work(handlers) {
      for (const name of JOB_NAMES) {
        const handler = handlers[name];
        await boss.work<Record<string, string>>(name, { pollingIntervalSeconds: 0.5 }, async (batch) => {
          for (const job of batch) {
            inFlight++;
            try {
              await handler(job.data);
            } finally {
              inFlight--;
            }
          }
        });
      }
    },
    async drainIdle(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const lists = await Promise.all(JOB_NAMES.map((n) => boss.findJobs(n)));
        const pending = lists.reduce((a, jobs) => a + jobs.filter((j) => PENDING_STATES.has(j.state)).length, 0) + inFlight;
        if (pending === 0) return;
        if (Date.now() > deadline) throw new Error(`jobs did not drain within ${timeoutMs}ms (${pending} pending)`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    stop: () => boss.stop({ graceful: true }),
  };
}

export function recordingJobs(): RecordingJobs {
  const sent: { name: JobName; data: Record<string, string> }[] = [];
  const done: boolean[] = [];
  return {
    sent,
    async send(_tx, name, data) {
      sent.push({ name, data: { ...data } });
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
