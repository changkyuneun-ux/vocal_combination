import { devApi } from "./client.ts";
import type { DevOutcome, PspOutcomes, SeedResult, WebhookResponses } from "./types.ts";

const e = encodeURIComponent;

export const setInstructionOutcome = (i: { instructionId: string; outcome: DevOutcome }) =>
  devApi<PspOutcomes>("PUT", `/psp/outcomes/${e(i.instructionId)}`, { outcome: i.outcome });
export const setPartyOutcome = (i: { partyId: string; outcome: DevOutcome }) =>
  devApi<PspOutcomes>("PUT", `/psp/outcomes/party/${e(i.partyId)}`, { outcome: i.outcome });
export const sendWebhook = (i: { instructionId: string; repeat: number; status?: "PAID" | "FAILED" }) =>
  devApi<WebhookResponses>("POST", "/psp/webhook", i);
export const seedSong = () => devApi<SeedResult>("POST", "/seed/synthetic-song", {});
export const resetDb = () => devApi<{ ok: true }>("POST", "/reset", {});
