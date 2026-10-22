import { invalidateDecisions } from "../decisions/cache.ts";
import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError, conflict, notFound } from "../platform/errors.ts";

/**
 * IR 생성 전 카탈로그 수정·삭제(결정 ID1). "IR 생성 전" = 그 곡의 facts_scope.sealed_through IS NULL.
 * 한 번이라도 봉인되면 409 CATALOG_SEALED(DB 트리거 0043이 뒤를 받친다). 다른 행이 가리키는 행을 지우면 409 CATALOG_IN_USE.
 */
export type CatalogKind = "work" | "recording" | "slot" | "slot-part" | "stem" | "voice";

type Spec = {
  table: string;
  /** 키 조건($1, $2) */
  where: string;
  /** 그 행이 속한 곡 */
  workOf: string;
  /** 본문 키 → 열 */
  columns: Record<string, string>;
};

const SPECS: Record<CatalogKind, Spec> = {
  work: { table: "work", where: "work_id = $1", workOf: "SELECT $1::text AS work_id", columns: { title: "title", iswc: "iswc" } },
  recording: {
    table: "recording_version", where: "recording_id = $1", workOf: "SELECT work_id FROM recording_version WHERE recording_id = $1",
    columns: { versionTitle: "version_title", isrc: "isrc", masterOwnerPartyId: "master_owner_party_id" },
  },
  slot: {
    table: "part_slot", where: "slot_id = $1",
    workOf: "SELECT r.work_id FROM part_slot s JOIN recording_version r ON r.recording_id = s.recording_id WHERE s.slot_id = $1",
    columns: { startMs: "start_ms", endMs: "end_ms", sortOrder: "sort_order", sectionLabel: "section_label" },
  },
  "slot-part": {
    table: "slot_part", where: "slot_id = $1 AND part_no = $2::int",
    workOf: "SELECT r.work_id FROM part_slot s JOIN recording_version r ON r.recording_id = s.recording_id WHERE s.slot_id = $1",
    columns: { kind: "kind", role: "role", startMs: "start_ms", endMs: "end_ms", originalPartyId: "original_party_id" },
  },
  stem: {
    table: "stem", where: "stem_id = $1", workOf: "SELECT r.work_id FROM stem st JOIN recording_version r ON r.recording_id = st.recording_id WHERE st.stem_id = $1",
    columns: { performerPartyId: "performer_party_id", rightsBearing: "rights_bearing" },
  },
  voice: { table: "voice", where: "voice_id = $1", workOf: "SELECT s.work_id FROM voice v JOIN facts_scope s ON s.facts_scope_id = v.facts_scope_id WHERE v.voice_id = $1", columns: {} },
};

const keyOf = (kind: CatalogKind, key: string[]) => (kind === "slot-part" ? key.slice(0, 2) : key.slice(0, 1));

/** 행·곡 범위를 찾고, 봉인된 적이 있으면 409. 범위 행은 FOR SHARE로 잠가 봉인(FOR UPDATE)과 겹치지 않게 한다. */
async function target(tx: Tx, kind: CatalogKind, key: string[]) {
  const spec = SPECS[kind];
  const params = keyOf(kind, key);
  const row = (await tx.query(`SELECT to_jsonb(t) AS row FROM ${spec.table} t WHERE ${spec.where}`, params)).rows[0];
  if (row === undefined) throw notFound(kind, params.join("/"));
  const workId = (await tx.query(spec.workOf, [params[0]])).rows[0]?.work_id as string | undefined;
  const scope = (await tx.query("SELECT facts_scope_id, sealed_through FROM facts_scope WHERE work_id = $1 FOR SHARE", [workId])).rows[0];
  if (scope !== undefined && scope.sealed_through !== null) {
    throw conflict("CATALOG_SEALED", `${kind} ${params.join("/")} cannot change — the song's facts are sealed`);
  }
  return { spec, params, before: row.row as Record<string, unknown>, scopeId: scope?.facts_scope_id as string | undefined };
}

/** DB 예외를 업무 오류로: 외래키 위반 = 다른 행이 가리킴, 0043 트리거 = 봉인됨. */
async function guarded<T>(kind: CatalogKind, id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code === "23503") throw conflict("CATALOG_IN_USE", `${kind} ${id} is referenced by other rows: ${e.detail ?? e.message}`);
    if (e?.code === "RC001" && String(e.message).startsWith("CATALOG_SEALED:")) throw conflict("CATALOG_SEALED", e.message);
    throw e;
  }
}

/** 수정: 본문에 있는 키만 바꾼다(null은 비운다). 키 열은 바꾸지 않는다. */
export async function updateCatalogRow(tx: Tx, clock: Clock, actor: Actor, kind: CatalogKind, key: string[], body: Record<string, unknown>) {
  const { spec, params, before, scopeId } = await target(tx, kind, key);
  const sets = Object.entries(spec.columns).filter(([k]) => body[k] !== undefined);
  if (sets.length === 0) throw new DomainError("BAD_REQUEST", 400, `nothing to update; fields: ${Object.keys(spec.columns).join(", ")}`);
  const id = params.join("/");
  const after = await guarded(kind, id, async () => (await tx.query(
    `UPDATE ${spec.table} t SET ${sets.map(([, c], i) => `${c} = $${params.length + i + 1}`).join(", ")} WHERE ${spec.where} RETURNING to_jsonb(t) AS row`,
    [...params, ...sets.map(([k]) => body[k])],
  )).rows[0]?.row);
  if (after === undefined) throw notFound(kind, id);
  if (scopeId !== undefined) await invalidateDecisions(tx, scopeId, { all: true });
  await audit(tx, clock, { actor: actor.userId, action: "CATALOG_UPDATE", entityType: spec.table, entityId: id, after: { before, after } });
  return { scopeId, row: after };
}

/** 그 엔티티를 출처·대상으로 하는 권리 주장(모든 버전)과 그 확인 요청을 지운다(봉인 전이라 어떤 IR에도 없다). */
async function dropClaimsTouching(tx: Tx, scopeId: string | undefined, entityId: string): Promise<string[]> {
  if (scopeId === undefined) return [];
  const ids = (await tx.query(
    "SELECT DISTINCT claim_id FROM right_claim WHERE facts_scope_id = $1 AND (source_id = $2 OR target_id = $2) ORDER BY claim_id", [scopeId, entityId],
  )).rows.map((r) => r.claim_id as string);
  if (ids.length === 0) return ids;
  await tx.query("DELETE FROM confirmation_request WHERE record_type = 'CLAIM' AND record_id = ANY($1)", [ids]);
  await tx.query("DELETE FROM right_claim WHERE claim_id = ANY($1)", [ids]);
  return ids;
}

/** 삭제. 스템·보이스·녹음·곡은 그 엔티티를 가리키는 권리 주장과 확인 요청을 함께 거둔다. 슬롯은 파트를, 곡은 빈 범위를 함께 지운다. */
export async function deleteCatalogRow(tx: Tx, clock: Clock, actor: Actor, kind: CatalogKind, key: string[]) {
  const { spec, params, before, scopeId } = await target(tx, kind, key);
  const id = params.join("/");
  const claims = await guarded(kind, id, async () => {
    const dropped = kind === "slot" || kind === "slot-part" ? [] : await dropClaimsTouching(tx, scopeId, params[0]!);
    if (kind === "slot") await tx.query("DELETE FROM slot_part WHERE slot_id = $1", [params[0]]);
    if (kind === "work" && scopeId !== undefined) await tx.query("DELETE FROM facts_scope WHERE facts_scope_id = $1", [scopeId]);
    await tx.query(`DELETE FROM ${spec.table} WHERE ${spec.where}`, params);
    return dropped;
  });
  if (scopeId !== undefined && kind !== "work") await invalidateDecisions(tx, scopeId, { all: true });
  await audit(tx, clock, { actor: actor.userId, action: "CATALOG_DELETE", entityType: spec.table, entityId: id, after: { before, droppedClaims: claims } });
  return { scopeId: kind === "work" ? undefined : scopeId };
}
