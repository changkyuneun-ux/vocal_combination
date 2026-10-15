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
import { createFsAudioStore, httpAnalyzer, localAnalyzer, localRenderer } from "../audio/deps.ts";
import { createFsDocumentStore, documentMasterKey } from "../documents/store.ts";
import { audioJobHandlers } from "../audio/handlers.ts";
import { devIdentityProvider } from "../performer/identity.ts";
import { pushOutboxHandlers, webPushSender } from "../performer/notifications.ts";

/** 기본 blob 위치는 실행 디렉터리가 아니라 패키지 기준(rights-core/.blobs)이다. */
export const DEFAULT_BLOB_DIR = fileURLToPath(new URL("../../.blobs/", import.meta.url));

export type StartOpts = {
  url: string;
  clock: Clock;
  provider: PayoutProvider;
  pspSecret?: string | undefined;
  /** dev 진입점이 넘긴다(buildServer가 /dev/* 라우트를 등록). */
  dev?: Omit<DevDeps, "jobs" | "devDbName"> | undefined;
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
  // 오디오 처리 서비스: AUDIO_SERVICE_URL이 있으면 별도 프로세스(audio-service)를, 없으면 같은 프로세스의 라이브러리를 부른다.
  const audio = {
    store: createFsAudioStore(process.env.AUDIO_DIR ?? fileURLToPath(new URL("../../.audio/", import.meta.url))),
    analyzer: process.env.AUDIO_SERVICE_URL ? httpAnalyzer(process.env.AUDIO_SERVICE_URL) : localAnalyzer,
    // 렌더링은 원본 스템을 다루므로 같은 신뢰 경계 안(같은 프로세스 라이브러리)에서 한다.
    renderer: localRenderer,
  };
  // 원천 문서 저장소: 테넌트별 키로 암호화(마스터 키 RC_DOC_KEY, 없으면 개발용 키). 운영은 국내 리전 오브젝트 저장소 + KMS로 바꾼다.
  const documents = createFsDocumentStore(process.env.DOC_DIR ?? fileURLToPath(new URL("../../.documents/", import.meta.url)), documentMasterKey());
  if (opts.prepare !== undefined) await opts.prepare(db);
  const jobs = await startBossJobs(opts.url, workOptionsFromEnv(process.env));
  // 웹 푸시(VAPID): 키가 환경에 없으면 실행마다 새 키를 만든다(개발용). 구독은 키가 바뀌면 다시 해야 하므로 운영은 키를 고정한다.
  const push = webPushSender(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY } : undefined);
  const handlers = { ...jobHandlers({ db, ctx, clock: opts.clock, jobs }), ...payoutJobHandlers({ db, clock: opts.clock, jobs, provider: opts.provider }), ...audioJobHandlers({ db, clock: opts.clock, audio }) };
  for (const n of JOB_NAMES) if (handlers[n] === undefined) throw new Error(`missing job handler: ${n}`);
  await jobs.work(handlers as Record<JobName, JobHandler>);
  const app = buildServer({
    db, ctx, clock: opts.clock, jobs, provider: opts.provider, audio, push, documents,
    // 본인 인증 공급자: 개발 서버는 코드를 응답으로 돌려주는 개발용 공급자, 운영은 실제 공급자(휴대폰·PASS)를 붙인다(미설정이면 503).
    ...(opts.dev !== undefined && { identity: devIdentityProvider }),
    ...(opts.pspSecret === undefined ? {} : { pspSecret: opts.pspSecret }),
    ...(opts.dev === undefined ? {} : { dev: { ...opts.dev, jobs: createDevJobs(jobs) } }),
  });
  const stopPoller = startOutboxPoller(db, { ...OUTBOX_HANDLERS, ...pushOutboxHandlers(push) }, opts.clock, 1000);
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
