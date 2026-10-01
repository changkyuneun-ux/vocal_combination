import { api } from "./client.ts";
import type { RevenueBody } from "./types.ts";

/** POST /revenue-events는 SYSTEM 역할이므로 호출 사용자(x-actor)가 sys_ingest여야 한다. */
export const recordRevenue = (b: RevenueBody) => api<{ eventId: string; created: boolean }>("POST", "/revenue-events", b);

/** 정산 전개(GET /revenue-events/:id/settlement)는 SPACE_OPS·SPACE_SETTLE만 읽는다. sys_ingest일 때는 이 사용자로 읽는다. */
export const SETTLEMENT_READER = "usr_settle";
export const INGEST_ACTOR = "sys_ingest";

export const nowStamp = (iso: string) => iso.replace(/\D/g, "");
export const toLocalInput = (iso: string) => iso.slice(0, 19);
