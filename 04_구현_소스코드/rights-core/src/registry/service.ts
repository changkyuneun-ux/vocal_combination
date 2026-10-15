import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, invalid, notFound } from "../platform/errors.ts";
import { fenceRecording, fenceScope, fenceWork, lookup, scopeExists, type EntityKind } from "./repo.ts";

export type PartyType = "LABEL" | "AGENCY" | "PUBLISHER" | "CMO" | "AUTHOR" | "ARTIST" | "MEMBER" | "SESSION" | "AI_PROVIDER" | "FAN" | "PLATFORM";
export type ClaimEdge = "PERFORMED_BY" | "OWNED_BY" | "CONTROLLED_BY" | "WRITTEN_BY" | "CONTRIBUTED_BY";
export type RecordStatus = "ASSERTED" | "VERIFIED" | "DISPUTED" | "SUPERSEDED";
type Visibility = "PUBLIC" | "PARTIES" | "PRIVATE";

export type ClaimDraft = {
  claimId: string; factsScopeId: string; sourceId: string; edge: ClaimEdge; targetId: string; shareBps: number;
  performerRole?: "FEATURED" | "NON_FEATURED"; roleDetail?: string; status: RecordStatus; validFrom: string; validTo?: string;
  evidenceDigest?: string; visibility?: Visibility; sourceRef?: string;
};
export type MandateDraft = {
  mandateId: string; factsScopeId: string; fromPartyId: string; toPartyId: string; rightKind: "MASTER" | "WORK" | "PERFORMER";
  shareBps: number; status: RecordStatus; validFrom: string; validTo?: string; visibility?: Visibility; sourceRef?: string;
};
export type Recorded = { id: string; version: number; recordedAt: string };

/** MDRL CLAIM_EDGE_KINDS와 같은 표(코어 규격 facts/types.ts). */
const EDGE_ENDPOINTS: Record<ClaimEdge, readonly [EntityKind, EntityKind]> = {
  PERFORMED_BY: ["stem", "voice"],
  OWNED_BY: ["voice", "party"],
  CONTROLLED_BY: ["recording", "party"],
  WRITTEN_BY: ["work", "party"],
  CONTRIBUTED_BY: ["recording", "party"],
};
const NON_FACTS_PARTY = new Set(["FAN", "PLATFORM"]);

/** tenantId를 생략하면 요청 범위의 테넌트(rc.tenant_id)에 소속된다. */
export async function registerParty(tx: Tx, clock: Clock, p: { partyId: string; partyType: PartyType; displayName: string; isni?: string; ipiNo?: string; tenantId?: string }): Promise<void> {
  await tx.query("INSERT INTO party (party_id, party_type, display_name, isni, ipi_no, created_at, tenant_id) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, rc_tenant(), 'tnt_platform'))",
    [p.partyId, p.partyType, p.displayName, p.isni ?? null, p.ipiNo ?? null, clock.now(), p.tenantId ?? null]);
}

export async function registerWork(tx: Tx, clock: Clock, w: { workId: string; title: string; iswc?: string }): Promise<void> {
  await tx.query("INSERT INTO work (work_id, title, iswc, created_at) VALUES ($1,$2,$3,$4)", [w.workId, w.title, w.iswc ?? null, clock.now()]);
}

export async function createScope(tx: Tx, clock: Clock, s: { factsScopeId: string; workId: string }): Promise<void> {
  await tx.query("INSERT INTO facts_scope (facts_scope_id, work_id, created_at) VALUES ($1,$2,$3)", [s.factsScopeId, s.workId, clock.now()]);
}

export async function registerRecording(tx: Tx, clock: Clock, r: { recordingId: string; workId: string; masterOwnerPartyId: string; isrc?: string; versionTitle: string }): Promise<void> {
  const at = clock.now();
  await fenceWork(tx, r.workId, at);
  await tx.query("INSERT INTO recording_version (recording_id, work_id, master_owner_party_id, isrc, version_title, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [r.recordingId, r.workId, r.masterOwnerPartyId, r.isrc ?? null, r.versionTitle, at]);
}

export async function registerSlot(tx: Tx, s: { slotId: string; recordingId: string; startMs: number; endMs: number; sortOrder: number }): Promise<void> {
  await tx.query("INSERT INTO part_slot (slot_id, recording_id, start_ms, end_ms, sort_order) VALUES ($1,$2,$3,$4,$5)",
    [s.slotId, s.recordingId, s.startMs, s.endMs, s.sortOrder]);
}

export async function registerStem(tx: Tx, clock: Clock, s: { stemId: string; slotId: string; recordingId: string; performerPartyId?: string; rightsBearing: boolean }): Promise<void> {
  const at = clock.now();
  await fenceRecording(tx, s.recordingId, at);
  await tx.query("INSERT INTO stem (stem_id, slot_id, recording_id, performer_party_id, rights_bearing, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [s.stemId, s.slotId, s.recordingId, s.performerPartyId ?? null, s.rightsBearing, at]);
}

export async function registerVoice(tx: Tx, clock: Clock, v: { voiceId: string; factsScopeId: string; kind: "HUMAN" | "AI" }): Promise<void> {
  const at = clock.now();
  await fenceScope(tx, v.factsScopeId, at);
  await tx.query("INSERT INTO voice (voice_id, facts_scope_id, kind, created_at) VALUES ($1,$2,$3,$4)", [v.voiceId, v.factsScopeId, v.kind, at]);
}

/** 엔티티가 존재하고, 범위가 있는 종류면 같은 facts 범위에 속하며, party면 facts에 들어갈 수 있는 종류인지 확인한다. */
async function requireEndpoint(tx: Tx, kind: EntityKind, id: string, scopeId: string, role: string): Promise<void> {
  const e = await lookup(tx, kind, id);
  if (e === undefined) throw invalid("INVALID_REFERENCE", `${role}: ${kind} ${id} does not exist`);
  if (kind !== "party" && e.scope !== scopeId) throw invalid("INVALID_REFERENCE", `${role}: ${kind} ${id} is not in facts scope ${scopeId}`);
  if (kind === "party" && NON_FACTS_PARTY.has(e.detail ?? "")) throw invalid("INVALID_REFERENCE", `${role}: party ${id} (${e.detail}) cannot appear in facts`);
}

/** expectedVersion: 호출자가 읽은 현재 버전(없으면 0). 잠근 현재 버전과 다르면 VERSION_CONFLICT(잃어버린 갱신 방지). */
export type RecordOptions = { expectedVersion?: number };

/**
 * 이중 시간축 버전 추가: 현재 버전을 잠그고, 새 버전을 INSERT한 뒤 직전 버전의 superseded_at을 설정한다.
 * 새 버전은 현재 버전보다 엄격히 늦게 기록되어야 하고 같은 facts 범위에 있어야 한다.
 */
async function nextVersion(
  tx: Tx, table: "right_claim" | "mandate", idCol: string, id: string, scopeId: string, recordedAt: string, expectedVersion: number | undefined,
): Promise<number> {
  const cur = await tx.query(`SELECT version, recorded_at, facts_scope_id FROM ${table} WHERE ${idCol} = $1 AND superseded_at IS NULL FOR UPDATE`, [id]);
  const row = cur.rows[0];
  const current = row === undefined ? 0 : (row.version as number);
  if (expectedVersion !== undefined && expectedVersion !== current) {
    throw conflict("VERSION_CONFLICT", `${id}: expected current version ${expectedVersion} but it is ${current}`);
  }
  if (row === undefined) return 1;
  if (row.facts_scope_id !== scopeId) throw invalid("INVALID_REFERENCE", `${id} belongs to facts scope ${row.facts_scope_id}`);
  if (Date.parse(recordedAt) <= (row.recorded_at as Date).getTime()) {
    throw conflict("CLOCK_NOT_MONOTONIC", `${id}: new version must be recorded after ${iso(row.recorded_at)}`);
  }
  return (row.version as number) + 1;
}

async function supersede(tx: Tx, table: "right_claim" | "mandate", idCol: string, id: string, version: number, at: string): Promise<void> {
  if (version > 1) await tx.query(`UPDATE ${table} SET superseded_at = $3 WHERE ${idCol} = $1 AND version = $2`, [id, version - 1, at]);
}

export async function recordClaim(tx: Tx, clock: Clock, d: ClaimDraft, opts: RecordOptions = {}): Promise<Recorded> {
  if (!(await scopeExists(tx, d.factsScopeId))) throw notFound("facts scope", d.factsScopeId);
  const [srcKind, dstKind] = EDGE_ENDPOINTS[d.edge];
  await requireEndpoint(tx, srcKind, d.sourceId, d.factsScopeId, "source");
  await requireEndpoint(tx, dstKind, d.targetId, d.factsScopeId, "target");
  const recordedAt = clock.now();
  await fenceScope(tx, d.factsScopeId, recordedAt);
  const version = await nextVersion(tx, "right_claim", "claim_id", d.claimId, d.factsScopeId, recordedAt, opts.expectedVersion);
  // 부분 유니크 인덱스(현재 버전 1개)를 지키려면 INSERT 전에 직전 버전을 대체해야 한다.
  await supersede(tx, "right_claim", "claim_id", d.claimId, version, recordedAt);
  await tx.query(
    `INSERT INTO right_claim (claim_id, version, facts_scope_id, source_id, edge, target_id, share_bps, performer_role, role_detail,
       status, valid_from, valid_to, recorded_at, evidence_digest, visibility, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [d.claimId, version, d.factsScopeId, d.sourceId, d.edge, d.targetId, d.shareBps, d.performerRole ?? null, d.roleDetail ?? null,
      d.status, d.validFrom, d.validTo ?? null, recordedAt, d.evidenceDigest ?? null, d.visibility ?? null, d.sourceRef ?? null],
  );
  return { id: d.claimId, version, recordedAt };
}

export async function recordMandate(tx: Tx, clock: Clock, d: MandateDraft, opts: RecordOptions = {}): Promise<Recorded> {
  if (!(await scopeExists(tx, d.factsScopeId))) throw notFound("facts scope", d.factsScopeId);
  if (d.fromPartyId === d.toPartyId) throw invalid("INVALID_REFERENCE", `mandate ${d.mandateId}: from and to are the same party`);
  await requireEndpoint(tx, "party", d.fromPartyId, d.factsScopeId, "from");
  await requireEndpoint(tx, "party", d.toPartyId, d.factsScopeId, "to");
  const recordedAt = clock.now();
  await fenceScope(tx, d.factsScopeId, recordedAt);
  const version = await nextVersion(tx, "mandate", "mandate_id", d.mandateId, d.factsScopeId, recordedAt, opts.expectedVersion);
  // 부분 유니크 인덱스(현재 버전 1개)를 지키려면 INSERT 전에 직전 버전을 대체해야 한다.
  await supersede(tx, "mandate", "mandate_id", d.mandateId, version, recordedAt);
  await tx.query(
    `INSERT INTO mandate (mandate_id, version, facts_scope_id, from_party_id, to_party_id, right_kind, share_bps, status,
       valid_from, valid_to, recorded_at, visibility, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [d.mandateId, version, d.factsScopeId, d.fromPartyId, d.toPartyId, d.rightKind, d.shareBps, d.status,
      d.validFrom, d.validTo ?? null, recordedAt, d.visibility ?? null, d.sourceRef ?? null],
  );
  return { id: d.mandateId, version, recordedAt };
}

export async function currentClaim(tx: Tx, claimId: string): Promise<ClaimDraft & { version: number }> {
  const r = (await tx.query("SELECT * FROM right_claim WHERE claim_id = $1 AND superseded_at IS NULL", [claimId])).rows[0];
  if (r === undefined) throw notFound("claim", claimId);
  return {
    claimId: r.claim_id, version: r.version, factsScopeId: r.facts_scope_id, sourceId: r.source_id, edge: r.edge, targetId: r.target_id,
    shareBps: r.share_bps, status: r.status, validFrom: iso(r.valid_from)!,
    ...(r.performer_role !== null && { performerRole: r.performer_role }),
    ...(r.role_detail !== null && { roleDetail: r.role_detail }),
    ...(r.valid_to !== null && { validTo: iso(r.valid_to) }),
    ...(r.evidence_digest !== null && { evidenceDigest: r.evidence_digest }),
    ...(r.visibility !== null && { visibility: r.visibility }),
    ...(r.source_ref !== null && { sourceRef: r.source_ref }),
  };
}

export async function currentMandate(tx: Tx, mandateId: string): Promise<MandateDraft & { version: number }> {
  const r = (await tx.query("SELECT * FROM mandate WHERE mandate_id = $1 AND superseded_at IS NULL", [mandateId])).rows[0];
  if (r === undefined) throw notFound("mandate", mandateId);
  return {
    mandateId: r.mandate_id, version: r.version, factsScopeId: r.facts_scope_id, fromPartyId: r.from_party_id, toPartyId: r.to_party_id,
    rightKind: r.right_kind, shareBps: r.share_bps, status: r.status, validFrom: iso(r.valid_from)!,
    ...(r.valid_to !== null && { validTo: iso(r.valid_to) }),
    ...(r.visibility !== null && { visibility: r.visibility }),
    ...(r.source_ref !== null && { sourceRef: r.source_ref }),
  };
}
