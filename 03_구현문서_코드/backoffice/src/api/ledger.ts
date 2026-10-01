import type { Paged } from "./client.ts";
import type { EntryRow } from "./types.ts";

/** 원장 조회는 SPACE_SETTLE(usr_settle). 확정 뒤 반영 진행: 이 run들의 SETTLEMENT 분개(sourceRef = run:<runId>) 수. */
export const settlementEntriesPath = "/ledger/entries?kind=SETTLEMENT&limit=200";

export function postedRunCount(entries: Paged<EntryRow> | undefined, runIds: string[]): number {
  if (!entries) return 0;
  const refs = new Set(entries.items.map((e) => e.sourceRef));
  return runIds.filter((id) => refs.has(`run:${id}`)).length;
}
