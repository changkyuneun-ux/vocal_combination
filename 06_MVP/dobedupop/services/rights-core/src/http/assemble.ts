import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { Clock } from "../platform/clock.ts";
import { createDb, poolMaxFromEnv } from "../platform/db.ts";
import { startOutboxPoller } from "../platform/outbox.ts";
import { devSignatureProvider } from "../contracts/esign.ts";
import { startValidationSweeper, sweepIntervalFromEnv } from "../validation/sweeper.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createObjectBlobStore } from "../engine-bridge/blob-fs.ts";
import { ensureS3Bucket, objectStoreFromEnv, s3ConfigFromEnv } from "../platform/object-store.ts";
import { startObjectGc } from "../platform/object-gc.ts";
import { OUTBOX_HANDLERS } from "../issuance/service.ts";
import { JOB_NAMES, startBossJobs, workOptionsFromEnv, type JobHandler, type JobName } from "../platform/jobs.ts";
import { jobHandlers } from "../settlement/handlers.ts";
import { payoutJobHandlers } from "../payout/handlers.ts";
import type { PayoutProvider } from "../payout/provider.ts";
import type { DevDeps } from "../dev/routes.ts";
import { createDevJobs } from "../dev/jobs.ts";
import { buildServer } from "./server.ts";
import { createObjectAudioStore, httpAnalyzer, localAnalyzer, localRenderer } from "../audio/deps.ts";
import { createObjectDocumentStore, documentMasterKey } from "../documents/store.ts";
import { audioJobHandlers } from "../audio/handlers.ts";
import { devIdentityProvider } from "../performer/identity.ts";
import { pushOutboxHandlers, webPushSender } from "../performer/notifications.ts";

/** 기본 blob 위치는 실행 디렉터리가 아니라 패키지 기준(rights-core/.blobs)이다. */
export const DEFAULT_BLOB_DIR = fileURLToPath(new URL("../../.blobs/", import.meta.url));

/**
 * 프로세스 역할(MVP 진행계획 M2): 같은 이미지를 역할별로 띄운다. all은 한 프로세스에 모두(로컬 개발 기본값).
 * api = HTTP(작업은 보내기만), worker = 검증을 뺀 작업·outbox·정기 검사, verifier = 독립 재계산(verify-run)만.
 */
export const ROLES = ["all", "api", "worker", "verifier"] as const;
export type Role = (typeof ROLES)[number];

export function roleFromEnv(env: Readonly<Record<string, string | undefined>>): Role {
  const v = env.RC_ROLE === undefined || env.RC_ROLE === "" ? "all" : env.RC_ROLE;
  if (!(ROLES as readonly string[]).includes(v)) throw new Error(`RC_ROLE must be one of ${ROLES.join(", ")}, got ${v}`);
  return v as Role;
}

/** 역할이 처리하는 큐. 검증은 실행과 다른 프로세스·신원에서 돌아야 검증의 의미가 있다. */
export function queuesFor(role: Role): JobName[] {
  if (role === "api") return [];
  if (role === "verifier") return ["verify-run"];
  if (role === "worker") return JOB_NAMES.filter((n) => n !== "verify-run");
  return [...JOB_NAMES];
}

/** 컨테이너 안에서는 RC_LISTEN_HOST=0.0.0.0으로 연다(로컬 기본값은 127.0.0.1). */
export const listenHostFromEnv = (env: Readonly<Record<string, string | undefined>>): string => env.RC_LISTEN_HOST || "127.0.0.1";

/** 워커·검증 워커의 상태 점검용 HTTP(업무 API는 열지 않는다). */
export function healthServer(db: ReturnType<typeof createDb>, role: Role): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ status: "ok", role }));
  app.get("/readyz", async () => { await db.tx((tx) => tx.query("SELECT 1")); return { status: "ready", role }; });
  return app;
}

export type StartOpts = {
  url: string;
  clock: Clock;
  provider: PayoutProvider;
  pspSecret?: string | undefined;
  /** dev 진입점이 넘긴다(buildServer가 /dev/* 라우트를 등록). */
  dev?: Omit<DevDeps, "jobs" | "devDbName"> | undefined;
  port: number;
  /** 프로세스 역할. 주지 않으면 RC_ROLE(기본 all). */
  role?: Role;
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
  // 오브젝트 저장소(MVP 진행계획 M2): RC_OBJECT_STORE=s3이면 S3 호환 저장소 한 버킷에 seal/·documents/·audio/ 접두어로, 아니면 로컬 파일.
  if (process.env.RC_OBJECT_STORE === "s3") await ensureS3Bucket(s3ConfigFromEnv(process.env));
  const stores = {
    seal: objectStoreFromEnv(process.env, "seal", blobDir),
    documents: objectStoreFromEnv(process.env, "documents", process.env.DOC_DIR ?? fileURLToPath(new URL("../../.documents/", import.meta.url))),
    audio: objectStoreFromEnv(process.env, "audio", process.env.AUDIO_DIR ?? fileURLToPath(new URL("../../.audio/", import.meta.url))),
  };
  const ctx = createBridgeCtx(createObjectBlobStore(stores.seal));
  // 오디오 처리 서비스: AUDIO_SERVICE_URL이 있으면 별도 프로세스(audio-service)를, 없으면 같은 프로세스의 라이브러리를 부른다.
  const audio = {
    store: createObjectAudioStore(stores.audio),
    analyzer: process.env.AUDIO_SERVICE_URL ? httpAnalyzer(process.env.AUDIO_SERVICE_URL) : localAnalyzer,
    // 렌더링은 원본 스템을 다루므로 같은 신뢰 경계 안(같은 프로세스 라이브러리)에서 한다.
    renderer: localRenderer,
  };
  // 원천 문서 저장소: 테넌트별 키로 암호화(마스터 키 RC_DOC_KEY, 없으면 개발용 키). 운영은 국내 리전 오브젝트 저장소 + KMS로 바꾼다.
  const documents = createObjectDocumentStore(stores.documents, documentMasterKey());
  if (opts.prepare !== undefined) await opts.prepare(db);
  const jobs = await startBossJobs(opts.url, workOptionsFromEnv(process.env));
  // 웹 푸시(VAPID): 키가 환경에 없으면 실행마다 새 키를 만든다(개발용). 구독은 키가 바뀌면 다시 해야 하므로 운영은 키를 고정한다.
  const push = webPushSender(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY } : undefined);
  const handlers = { ...jobHandlers({ db, ctx, clock: opts.clock, jobs }), ...payoutJobHandlers({ db, clock: opts.clock, jobs, provider: opts.provider }), ...audioJobHandlers({ db, clock: opts.clock, audio }) };
  for (const n of JOB_NAMES) if (handlers[n] === undefined) throw new Error(`missing job handler: ${n}`);
  const role = opts.role ?? roleFromEnv(process.env);
  const all = handlers as Record<JobName, JobHandler>;
  await jobs.work(Object.fromEntries(queuesFor(role).map((n) => [n, all[n]])));
  const app = role !== "all" && role !== "api" ? healthServer(db, role) : buildServer({
    db, ctx, clock: opts.clock, jobs, provider: opts.provider, audio, push, documents,
    // 본인 인증 공급자: 개발 서버는 코드를 응답으로 돌려주는 개발용 공급자, 운영은 실제 공급자(휴대폰·PASS)를 붙인다(미설정이면 503).
    ...(opts.dev !== undefined && { identity: devIdentityProvider }),
    // 전자서명 공급자(결정 D1): 국내 사업자를 정할 때까지 개발 서버만 개발용 임의 공급자를 붙인다(운영은 미설정이면 503).
    ...(opts.dev !== undefined && { esign: devSignatureProvider }),
    ...(opts.pspSecret === undefined ? {} : { pspSecret: opts.pspSecret }),
    ...(opts.dev === undefined ? {} : { dev: { ...opts.dev, jobs: createDevJobs(jobs) } }),
  });
  // outbox와 정기 검사는 워커가 맡는다(API 프로세스가 여럿이어도 한 번만 돈다).
  const background = role === "all" || role === "worker";
  const stopPoller = background ? startOutboxPoller(db, { ...OUTBOX_HANDLERS, ...pushOutboxHandlers(push) }, opts.clock, 1000) : () => {};
  const stopSweeper = background ? startValidationSweeper(db, opts.clock, sweepIntervalFromEnv(process.env)) : () => {};
  const stopGc = background ? startObjectGc(db, stores, process.env) : () => {};
  const host = listenHostFromEnv(process.env);
  await app.listen({ port: opts.port, host });
  console.log(`rights-core (${role}) listening on http://${host}:${opts.port}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    stopPoller();
    stopSweeper();
    stopGc();
    await app.close();
    await jobs.stop();
    await db.close();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await stop(); process.exit(0); });
  return { db, stop };
}
