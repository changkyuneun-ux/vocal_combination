import { api } from "./client.ts";
import type { RevenueBody } from "./types.ts";

/** POST /revenue-events는 SYSTEM 역할이므로 호출 사용자(x-actor)가 sys_ingest여야 한다. */
export const recordRevenue = (b: RevenueBody) => api<{ eventId: string; created: boolean }>("POST", "/revenue-events", b);

export const INGEST_ACTOR = "sys_ingest";

export const nowStamp = (iso: string) => iso.replace(/\D/g, "");
export const toLocalInput = (iso: string) => iso.slice(0, 19);
