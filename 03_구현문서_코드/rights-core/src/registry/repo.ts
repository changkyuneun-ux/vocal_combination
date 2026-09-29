import type { Tx } from "../platform/db.ts";

export type EntityKind = "party" | "work" | "recording" | "stem" | "voice";

const LOOKUP: Record<EntityKind, string> = {
  party: "SELECT party_id AS id, party_type AS detail, NULL::text AS scope FROM party WHERE party_id = $1",
  work: "SELECT w.work_id AS id, NULL::text AS detail, s.facts_scope_id AS scope FROM work w LEFT JOIN facts_scope s ON s.work_id = w.work_id WHERE w.work_id = $1",
  recording: "SELECT r.recording_id AS id, NULL::text AS detail, s.facts_scope_id AS scope FROM recording_version r LEFT JOIN facts_scope s ON s.work_id = r.work_id WHERE r.recording_id = $1",
  stem: "SELECT st.stem_id AS id, NULL::text AS detail, s.facts_scope_id AS scope FROM stem st JOIN recording_version r ON r.recording_id = st.recording_id LEFT JOIN facts_scope s ON s.work_id = r.work_id WHERE st.stem_id = $1",
  voice: "SELECT voice_id AS id, kind AS detail, facts_scope_id AS scope FROM voice WHERE voice_id = $1",
};

/** 엔티티 존재·소속 범위 조회. detail은 party_type 또는 voice kind. */
export async function lookup(tx: Tx, kind: EntityKind, id: string): Promise<{ id: string; detail: string | null; scope: string | null } | undefined> {
  const r = await tx.query(LOOKUP[kind], [id]);
  return r.rows[0];
}

export async function scopeExists(tx: Tx, scopeId: string): Promise<boolean> {
  return ((await tx.query("SELECT 1 FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rowCount ?? 0) > 0;
}
