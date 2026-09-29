import { iso, type Tx } from "../platform/db.ts";
import { conflict } from "../platform/errors.ts";

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

/**
 * facts 봉인 울타리(통합 설계 9.3-10): 범위 행을 FOR SHARE로 잠그고(봉인의 FOR UPDATE와 충돌), 쓰기 시각이 sealed_through보다
 * 엄격히 늦어야 통과한다. 잠금은 트랜잭션 끝까지 유지되므로, 봉인은 이 쓰기가 커밋될 때까지 기다린 뒤 그 행을 본다.
 */
export async function fenceScope(tx: Tx, scopeId: string, at: string): Promise<void> {
  const r = (await tx.query("SELECT sealed_through FROM facts_scope WHERE facts_scope_id = $1 FOR SHARE", [scopeId])).rows[0];
  if (r === undefined || r.sealed_through === null) return;
  if (Date.parse(at) <= (r.sealed_through as Date).getTime()) {
    throw conflict("FACTS_SEALED_THROUGH", `facts scope ${scopeId} is sealed through ${iso(r.sealed_through)}; a write at ${at} must be later`);
  }
}

/** 작품에 facts 범위가 있으면 그 범위의 울타리를 건다(범위가 없으면 봉인될 것도 없다). */
export async function fenceWork(tx: Tx, workId: string, at: string): Promise<void> {
  const r = (await tx.query("SELECT facts_scope_id FROM facts_scope WHERE work_id = $1", [workId])).rows[0];
  if (r !== undefined) await fenceScope(tx, r.facts_scope_id, at);
}

/** 녹음 → 작품 → 범위. */
export async function fenceRecording(tx: Tx, recordingId: string, at: string): Promise<void> {
  const r = (await tx.query("SELECT work_id FROM recording_version WHERE recording_id = $1", [recordingId])).rows[0];
  if (r !== undefined) await fenceWork(tx, r.work_id, at);
}
