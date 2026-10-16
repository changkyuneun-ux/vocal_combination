import { fileURLToPath } from "node:url";
// 개발 환경 기본값(이미 있으면 그 값). 다른 모듈이 process.env를 읽기 전에 채운다.
process.env.RC_DEV ??= "1";
process.env.DATABASE_URL ??= "postgres://rc_app:rc_app@localhost:54329/rights_core_dev";
process.env.RC_ADMIN_URL ??= "postgres://rc:rc@localhost:54329/rights_core_dev";
process.env.RC_PSP ??= "fake";
process.env.RC_PSP_SECRET ??= "dev-secret";

const { devModeFromEnv } = await import("./env.ts");
const { createDb } = await import("../platform/db.ts");
const { loadDevClock } = await import("./clock.ts");
const { ensureDevUsers } = await import("./users.ts");
const { createDevPsp } = await import("./psp.ts");
const { startServer } = await import("../http/assemble.ts");

if (!devModeFromEnv(process.env)) throw new Error("DEV_ONLY: RC_DEV must be 1 for npm run dev");
// 개발 DB가 없으면 만들고, 새로 추가된 마이그레이션을 적용한다(두 번 실행해도 안전 — npm run dev:db와 같다).
const { setupDevDb, DEFAULT_ADMIN_URL } = await import("./setup-db.ts");
const setup = await setupDevDb(process.env.RC_SERVER_ADMIN_URL ?? DEFAULT_ADMIN_URL);
if (setup.applied.length + setup.appliedDev.length > 0) console.log(`dev db: applied ${[...setup.applied, ...setup.appliedDev].join(", ")}`);
const url = process.env.DATABASE_URL!;
// 가상 시계를 읽고 개발 사용자를 심는 데는 잠깐 쓰는 연결을 따로 쓴다(서버 풀은 startServer가 만든다).
const boot = createDb(url, { max: 2 });
let clock: Awaited<ReturnType<typeof loadDevClock>>;
try {
  clock = await loadDevClock(boot);
  await boot.tx((tx) => ensureDevUsers(tx, clock));
} finally {
  await boot.close();
}
const blobDir = process.env.BLOB_DIR ?? fileURLToPath(new URL("../../.blobs-dev/", import.meta.url));
const psp = createDevPsp(clock);
const provider = psp.provider;
await startServer({
  url, clock, provider, pspSecret: process.env.RC_PSP_SECRET, port: Number(process.env.PORT ?? 8080),
  dev: { clock, psp, adminUrl: process.env.RC_ADMIN_URL!, blobDir },
});
