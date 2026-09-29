import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "../platform/db.ts";
import { ADMIN_URL, createFreshDatabase } from "../platform/dbadmin.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { runScenario } from "./run.ts";

const { values } = parseArgs({ options: { n: { type: "string", default: "10000" }, seed: { type: "string", default: "20260929" } } });
const fresh = await createFreshDatabase(ADMIN_URL);
const db = createDb(fresh.appUrl);
const blobRoot = mkdtempSync(join(tmpdir(), "rc-scenario-"));
try {
  const report = await runScenario({ db, ctx: createBridgeCtx(createFsBlobStore(blobRoot)) }, { n: Number(values.n), seed: Number(values.seed) });
  console.log(JSON.stringify({ ...report, p50Ms: +report.p50Ms.toFixed(2), p95Ms: +report.p95Ms.toFixed(2), maxMs: +report.maxMs.toFixed(2), totalMs: Math.round(report.totalMs) }, null, 2));
  const pass = report.auditMismatches === 0 && report.factsRederiveOk && report.disputeFlowOk;
  console.log(pass ? "SCENARIO PASS" : "SCENARIO FAIL");
  process.exitCode = pass ? 0 : 1;
} finally {
  await db.close();
  await fresh.drop();
  rmSync(blobRoot, { recursive: true, force: true });
}
