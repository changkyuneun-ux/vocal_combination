import { api } from "./client.ts";
import type { HoldReleaseResult } from "./types.ts";

const e = encodeURIComponent;

/** SPACE_OPS(usr_ops). */
export const createBatch = (b: { batchId: string; periodStart: string; periodEnd: string }) => api<unknown>("POST", "/batches", b);
/** SPACE_SETTLE(usr_settle, 생성자와 다른 사람). */
export const confirmBatch = (batchId: string) => api<{ manifestDigest: string }>("POST", `/batches/${e(batchId)}/confirm`);
export const voidRun = (i: { runId: string; reason: string }) => api<unknown>("POST", `/runs/${e(i.runId)}/void`, { reason: i.reason });
export const requeueRun = (runId: string) => api<unknown>("POST", `/runs/${e(runId)}/requeue`);
export const releaseQuarantine = (snapshotId: string) => api<unknown>("POST", `/quarantine/${e(snapshotId)}/release`);
export const releaseHold = (i: { holdingId: number; allocation: Record<string, string> }) =>
  api<HoldReleaseResult>("POST", `/holds/${i.holdingId}/release`, { allocation: i.allocation });
