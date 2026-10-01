export type UserRow = { userId: string; displayName: string; roles: string[] };
export type ClockState = { now: string; realNow: string; headroomMs: number };
export type { Paged } from "./client.ts";
