import { systemClock } from "../platform/clock.ts";
import { createDb } from "../platform/db.ts";
import { startOutboxPoller } from "../platform/outbox.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { OUTBOX_HANDLERS } from "../issuance/service.ts";
import { buildServer } from "./server.ts";

const url = process.env.DATABASE_URL ?? "postgres://rc_app:rc_app@localhost:54329/rights_core";
const db = createDb(url);
const ctx = createBridgeCtx(createFsBlobStore(process.env.BLOB_DIR ?? ".blobs"));
const app = buildServer({ db, ctx, clock: systemClock });
const stop = startOutboxPoller(db, OUTBOX_HANDLERS, systemClock, 1000);
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "127.0.0.1" });
console.log(`rights-core listening on http://127.0.0.1:${port}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { stop(); await app.close(); await db.close(); process.exit(0); });
}
