import { fileURLToPath } from "node:url";
import { systemClock } from "../platform/clock.ts";
import { createDb } from "../platform/db.ts";
import { startOutboxPoller } from "../platform/outbox.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { OUTBOX_HANDLERS } from "../issuance/service.ts";
import { ensureSystemIdentities } from "../platform/actor.ts";
import { JOB_NAMES, startBossJobs, workOptionsFromEnv, type JobHandler, type JobName } from "../platform/jobs.ts";
import { jobHandlers } from "../settlement/handlers.ts";
import { payoutJobHandlers } from "../payout/handlers.ts";
import { providerFromEnv } from "../payout/provider.ts";
import { buildServer } from "./server.ts";

const url = process.env.DATABASE_URL ?? "postgres://rc_app:rc_app@localhost:54329/rights_core";
const db = createDb(url);
// 기본 blob 위치는 실행 디렉터리가 아니라 패키지 기준(rights-core/.blobs)이다.
const blobDir = process.env.BLOB_DIR ?? fileURLToPath(new URL("../../.blobs/", import.meta.url));
const ctx = createBridgeCtx(createFsBlobStore(blobDir));
// PSP 어댑터: 이 단계에는 가짜 어댑터만 있다(RC_PSP가 "fake"나 빈 값이 아니면 시작을 거부한다).
const provider = providerFromEnv(process.env);
// 워커가 쓰는 시스템 신원(sys_ingest·sys_settler·sys_verifier)을 먼저 보장한다.
await db.tx((tx) => ensureSystemIdentities(tx, systemClock));
const jobs = await startBossJobs(url, workOptionsFromEnv(process.env));
const handlers = { ...jobHandlers({ db, ctx, clock: systemClock, jobs }), ...payoutJobHandlers({ db, clock: systemClock, jobs, provider }) };
for (const n of JOB_NAMES) if (handlers[n] === undefined) throw new Error(`missing job handler: ${n}`);
await jobs.work(handlers as Record<JobName, JobHandler>);
const app = buildServer({ db, ctx, clock: systemClock, jobs });
const stop = startOutboxPoller(db, OUTBOX_HANDLERS, systemClock, 1000);
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "127.0.0.1" });
console.log(`rights-core listening on http://127.0.0.1:${port}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { stop(); await app.close(); await jobs.stop(); await db.close(); process.exit(0); });
}
