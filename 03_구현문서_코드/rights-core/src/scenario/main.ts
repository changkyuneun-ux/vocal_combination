import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "../platform/db.ts";
import { ADMIN_URL, createFreshDatabase } from "../platform/dbadmin.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { runScenario } from "./run.ts";
import { runSettlementScenario, settlementPass } from "./settlement.ts";

// --settle <구매 건수>(예: 30000)를 주면 I-1 시나리오 뒤에 정산 시나리오(I-2a)를 이어서 돌린다.
const { values } = parseArgs({ options: { n: { type: "string", default: "10000" }, seed: { type: "string", default: "20260929" }, settle: { type: "string" } } });
const settle = values.settle === undefined ? undefined : Number(values.settle);
if (settle !== undefined && !(Number.isSafeInteger(settle) && settle > 0)) throw new Error(`--settle must be a positive integer, got ${values.settle}`);

const fresh = await createFreshDatabase(ADMIN_URL);
const db = createDb(fresh.appUrl);
const blobRoot = mkdtempSync(join(tmpdir(), "rc-scenario-"));
try {
  const ctx = createBridgeCtx(createFsBlobStore(blobRoot));
  const report = await runScenario({ db, ctx }, { n: Number(values.n), seed: Number(values.seed) });
  console.log(JSON.stringify({ ...report, p50Ms: +report.p50Ms.toFixed(2), p95Ms: +report.p95Ms.toFixed(2), maxMs: +report.maxMs.toFixed(2), totalMs: Math.round(report.totalMs) }, null, 2));
  let pass = report.issued === Number(values.n) && report.auditMismatches === 0 && report.factsRederiveOk && report.disputeFlowOk;
  if (settle !== undefined) {
    const s = await runSettlementScenario({ db, ctx, appUrl: fresh.appUrl }, { purchases: settle, seed: Number(values.seed) });
    const ms = (x: number) => Math.round(x);
    console.log(JSON.stringify({ ...s, ingestMs: ms(s.ingestMs), batchMs: ms(s.batchMs), settleMs: ms(s.settleMs), reverseMs: ms(s.reverseMs) }, null, 2));
    pass = pass && settlementPass(s);
  }
  console.log(pass ? "SCENARIO PASS" : "SCENARIO FAIL");
  process.exitCode = pass ? 0 : 1;
} finally {
  await db.close();
  await fresh.drop();
  rmSync(blobRoot, { recursive: true, force: true });
}
