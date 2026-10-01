import { fileURLToPath } from "node:url";
import type { Clock } from "../platform/clock.ts";
import { createDb, poolMaxFromEnv } from "../platform/db.ts";
import { startOutboxPoller } from "../platform/outbox.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { OUTBOX_HANDLERS } from "../issuance/service.ts";
import { JOB_NAMES, startBossJobs, workOptionsFromEnv, type JobHandler, type JobName } from "../platform/jobs.ts";
import { jobHandlers } from "../settlement/handlers.ts";
import { payoutJobHandlers } from "../payout/handlers.ts";
import type { PayoutProvider } from "../payout/provider.ts";
import type { DevDeps } from "../dev/routes.ts";
import { createDevJobs } from "../dev/jobs.ts";
import { buildServer } from "./server.ts";

/** 기본 blob 위치는 실행 디렉터리가 아니라 패키지 기준(rights-core/.blobs)이다. */
export const DEFAULT_BLOB_DIR = fileURLToPath(new URL("../../.blobs/", import.meta.url));

export type StartOpts = {
  url: string;
  clock: Clock;
  provider: PayoutProvider;
  pspSecret?: string | undefined;
  /** dev 진입점이 넘긴다(buildServer가 /dev/* 라우트를 등록). */
  dev?: Omit<DevDeps, "jobs"> | undefined;
  port: number;
  /** 시작 직후(워커·서버 시작 전) 실행할 준비 단계. 호출자가 필요한 시드를 심는다. */
  prepare?: ((db: ReturnType<typeof createDb>) => Promise<void>) | undefined;
};

/**
 * 서버 조립(작업 핸들러·outbox 폴러·HTTP 서버)과 시작. 운영(http/main.ts)과 개발(dev/main.ts)이 함께 쓴다.
 * 시스템 신원 보장은 prepare가 없으면 호출자 책임이다(운영 main이 prepare로 넘긴다).
 */
export async function startServer(opts: StartOpts): Promise<{ db: ReturnType<typeof createDb>; stop(): Promise<void> }> {
  const db = createDb(opts.url, { max: poolMaxFromEnv(process.env) });
  const blobDir = opts.dev?.blobDir ?? process.env.BLOB_DIR ?? DEFAULT_BLOB_DIR;
  const ctx = createBridgeCtx(createFsBlobStore(blobDir));
  if (opts.prepare !== undefined) await opts.prepare(db);
  const jobs = await startBossJobs(opts.url, workOptionsFromEnv(process.env));
  const handlers = { ...jobHandlers({ db, ctx, clock: opts.clock, jobs }), ...payoutJobHandlers({ db, clock: opts.clock, jobs, provider: opts.provider }) };
  for (const n of JOB_NAMES) if (handlers[n] === undefined) throw new Error(`missing job handler: ${n}`);
  await jobs.work(handlers as Record<JobName, JobHandler>);
  const app = buildServer({
    db, ctx, clock: opts.clock, jobs, provider: opts.provider,
    ...(opts.pspSecret === undefined ? {} : { pspSecret: opts.pspSecret }),
    ...(opts.dev === undefined ? {} : { dev: { ...opts.dev, jobs: createDevJobs(jobs) } }),
  });
  const stopPoller = startOutboxPoller(db, OUTBOX_HANDLERS, opts.clock, 1000);
  await app.listen({ port: opts.port, host: "127.0.0.1" });
  console.log(`rights-core listening on http://127.0.0.1:${opts.port}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    stopPoller();
    await app.close();
    await jobs.stop();
    await db.close();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await stop(); process.exit(0); });
  return { db, stop };
}
