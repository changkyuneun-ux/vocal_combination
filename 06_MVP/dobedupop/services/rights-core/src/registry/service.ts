import { invalidateDecisions } from "../decisions/cache.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, invalid, notFound } from "../platform/errors.ts";
import { fenceRecording, fenceScope, fenceWork, lookup, scopeExists, type EntityKind } from "./repo.ts";
import { carryEvidence, evidenceDigest, linkEvidence, type DocumentRef } from "../documents/service.ts";
import { withSystemScope } from "../platform/actor.ts";

export type PartyType = "LABEL" | "AGENCY" | "PUBLISHER" | "CMO" | "AUTHOR" | "ARTIST" | "MEMBER" | "SESSION" | "AI_PROVIDER" | "FAN" | "PLATFORM";
export type ClaimEdge = "PERFORMED_BY" | "OWNED_BY" | "CONTROLLED_BY" | "WRITTEN_BY" | "CONTRIBUTED_BY";
export type RecordStatus = "ASSERTED" | "VERIFIED" | "DISPUTED" | "SUPERSEDED";
type Visibility = "PUBLIC" | "PARTIES" | "PRIVATE";

export type ClaimDraft = {
  claimId: string; factsScopeId: string; sourceId: string; edge: ClaimEdge; targetId: string; shareBps: number;
  performerRole?: "FEATURED" | "NON_FEATURED"; roleDetail?: string; status: RecordStatus; validFrom: string; validTo?: string;
  evidenceDigest?: string; visibility?: Visibility; sourceRef?: string;
  /** 근거 원천 문서(원천 문서 설계 S1). 주면 evidenceDigest를 시스템이 문서 해시로 채운다(직접 주면 거부). linkedBy는 연결한 사용자. */
  evidenceDocuments?: DocumentRef[]; linkedBy?: string;
};
export type MandateDraft = {
  mandateId: string; factsScopeId: string; fromPartyId: string; toPartyId: string; rightKind: "MASTER" | "WORK" | "PERFORMER";
  shareBps: number; status: RecordStatus; validFrom: string; validTo?: string; visibility?: Visibility; sourceRef?: string;
  /** 위임 증빙(결정 D4): 주장과 같이 facts에 봉인된다. evidenceDocuments를 주면 시스템이 채운다. */
  evidenceDigest?: string; evidenceDocuments?: DocumentRef[]; linkedBy?: string;
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
export type PartyInput = { partyId: string; partyType: PartyType; displayName: string; isni?: string; ipiNo?: string; tenantId?: string; legalId?: string; managementDocumentId?: string };

export async function registerParty(tx: Tx, clock: Clock, p: PartyInput): Promise<void> {
  await tx.query(
    `INSERT INTO party (party_id, party_type, display_name, isni, ipi_no, created_at, tenant_id, legal_id, management_document_id)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, rc_tenant(), 'tnt_platform'),$8,$9)`,
    [p.partyId, p.partyType, p.displayName, p.isni ?? null, p.ipiNo ?? null, clock.now(), p.tenantId ?? null, p.legalId ?? null, p.managementDocumentId ?? null]);
}

/**
 * 한 테넌트에 여러 당사자를 두는 기준(결정 TD2): 권리 테넌트의 당사자는 그 테넌트와 같은 법인(사업자번호가 같거나 비워 두면 테넌트 사업자번호)이거나,
 * 다른 법인이면 관리 위임 계약(원천 문서)이 있어야 한다. 참여 기관은 자기 당사자 하나, 개인 소속은 개인 당사자(멤버·팬·작가·세션)만 둔다.
 * 비워 둔 legalId는 테넌트 사업자번호로 채운다(입력 객체를 고친다).
 */
export async function assertPartyAdmissible(tx: Tx, tenantId: string, p: PartyInput): Promise<void> {
  const t = (await tx.query("SELECT org_class, tenant_type, business_no FROM tenant WHERE tenant_id = $1", [tenantId])).rows[0];
  if (t === undefined) throw notFound("tenant", tenantId);
  if (t.org_class === "RIGHTS") {
    if (p.legalId === undefined && t.business_no !== null) p.legalId = t.business_no;
    if (p.legalId !== undefined && t.business_no !== null && p.legalId !== t.business_no && p.managementDocumentId === undefined) {
      throw invalid("PARTY_OTHER_ENTITY", `${p.partyId} (${p.legalId}) is another legal entity than ${tenantId} (${t.business_no}); attach the management delegation contract (managementDocumentId) or register a separate tenant`);
    }
  } else if (t.org_class === "PARTICIPANT") {
    const n = (await tx.query("SELECT count(*)::int AS n FROM party WHERE tenant_id = $1", [tenantId])).rows[0].n as number;
    if (t.tenant_type === "B2B_PARTNER") throw invalid("PARTY_NOT_ALLOWED", "a distribution partner is not a payee party");
    if (n > 0) throw invalid("PARTY_NOT_ALLOWED", `${tenantId} already has its party; a participant organization has one`);
  } else if (t.org_class === "INDIVIDUAL") {
    if (!["MEMBER", "ARTIST", "AUTHOR", "SESSION", "FAN"].includes(p.partyType)) throw invalid("PARTY_NOT_ALLOWED", `${p.partyType} is an organization; register it in its own tenant`);
  }
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

export type PartKind = "VOCAL" | "GROUP" | "INSTRUMENT";
export type PartRole = "LEAD" | "HARMONY" | "ADLIB" | "UNISON" | "RAP";
export type SlotPartInput = { partNo: number; kind: PartKind; role?: PartRole; startMs: number; endMs: number; originalPartyId?: string };

/** 슬롯 = 원곡 흐름 구간(SL1). 파트를 주지 않으면 슬롯 전체 길이의 반주 파트 1을 만든다. */
export async function registerSlot(tx: Tx, clock: Clock, s: { slotId: string; recordingId: string; startMs: number; endMs: number; sortOrder: number; sectionLabel?: string; parts?: SlotPartInput[] }): Promise<void> {
  // 시계는 한 번만 읽는다(단계 시계를 쓰는 시나리오의 이후 시각이 밀리지 않게).
  const at = clock.now();
  await fenceRecording(tx, s.recordingId, at);
  await tx.query("INSERT INTO part_slot (slot_id, recording_id, start_ms, end_ms, sort_order, section_label) VALUES ($1,$2,$3,$4,$5,$6)",
    [s.slotId, s.recordingId, s.startMs, s.endMs, s.sortOrder, s.sectionLabel ?? null]);
  for (const p of s.parts ?? [{ partNo: 1, kind: "INSTRUMENT" as const, startMs: s.startMs, endMs: s.endMs }]) await insertPart(tx, s.slotId, p, at);
}

/** 파트 = 슬롯 안 원곡 트랙(SL1·SL6·SL7). 보컬은 원곡 담당 멤버가 있어야 한다. */
export async function registerSlotPart(tx: Tx, clock: Clock, slotId: string, p: SlotPartInput): Promise<void> {
  const r = (await tx.query("SELECT recording_id FROM part_slot WHERE slot_id = $1", [slotId])).rows[0];
  if (r === undefined) throw invalid("INVALID_REFERENCE", `slot ${slotId} does not exist`);
  const at = clock.now();
  await fenceRecording(tx, r.recording_id, at);
  await insertPart(tx, slotId, p, at);
}

async function insertPart(tx: Tx, slotId: string, p: SlotPartInput, at: string): Promise<void> {
  await tx.query("INSERT INTO slot_part (slot_id, part_no, kind, role, start_ms, end_ms, original_party_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [slotId, p.partNo, p.kind, p.role ?? null, p.startMs, p.endMs, p.originalPartyId ?? null, at]);
}

export async function registerStem(tx: Tx, clock: Clock, s: { stemId: string; slotId: string; partNo?: number; recordingId: string; performerPartyId?: string; rightsBearing: boolean }): Promise<void> {
  const at = clock.now();
  await fenceRecording(tx, s.recordingId, at);
  await tx.query("INSERT INTO stem (stem_id, slot_id, part_no, recording_id, performer_party_id, rights_bearing, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [s.stemId, s.slotId, s.partNo ?? 1, s.recordingId, s.performerPartyId ?? null, s.rightsBearing, at]);
}

/** 실연자 보이스 id 규칙(결정 ID3): pty_ 접두어를 떼고 voc_를 붙인다(pty_jimin → voc_jimin, pb → voc_pb). */
export const voiceIdFor = (partyId: string): string => `voc_${partyId.replace(/^pty_/, "")}`;

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
  await invalidateDecisions(tx, d.factsScopeId, { all: true }); // 주장·위임이 바뀌면 곡의 판정 캐시 전부
  const version = await nextVersion(tx, "right_claim", "claim_id", d.claimId, d.factsScopeId, recordedAt, opts.expectedVersion);
  const evidence = await resolveEvidence(tx, "right_claim", "claim_id", d.claimId, version, d);
  // 부분 유니크 인덱스(현재 버전 1개)를 지키려면 INSERT 전에 직전 버전을 대체해야 한다.
  await supersede(tx, "right_claim", "claim_id", d.claimId, version, recordedAt);
  await tx.query(
    `INSERT INTO right_claim (claim_id, version, facts_scope_id, source_id, edge, target_id, share_bps, performer_role, role_detail,
       status, valid_from, valid_to, recorded_at, evidence_digest, visibility, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [d.claimId, version, d.factsScopeId, d.sourceId, d.edge, d.targetId, d.shareBps, d.performerRole ?? null, d.roleDetail ?? null,
      d.status, d.validFrom, d.validTo ?? null, recordedAt, evidence.digest, d.visibility ?? null, d.sourceRef ?? null],
  );
  await evidence.link(tx, clock, "CLAIM", d.claimId, version);
  await supersedeRequests(tx, "CLAIM", d.claimId, version, recordedAt);
  return { id: d.claimId, version, recordedAt };
}

export async function recordMandate(tx: Tx, clock: Clock, d: MandateDraft, opts: RecordOptions = {}): Promise<Recorded> {
  if (!(await scopeExists(tx, d.factsScopeId))) throw notFound("facts scope", d.factsScopeId);
  if (d.fromPartyId === d.toPartyId) throw invalid("INVALID_REFERENCE", `mandate ${d.mandateId}: from and to are the same party`);
  await requireEndpoint(tx, "party", d.fromPartyId, d.factsScopeId, "from");
  await requireEndpoint(tx, "party", d.toPartyId, d.factsScopeId, "to");
  const recordedAt = clock.now();
  await fenceScope(tx, d.factsScopeId, recordedAt);
  await invalidateDecisions(tx, d.factsScopeId, { all: true }); // 주장·위임이 바뀌면 곡의 판정 캐시 전부
  const version = await nextVersion(tx, "mandate", "mandate_id", d.mandateId, d.factsScopeId, recordedAt, opts.expectedVersion);
  const evidence = await resolveEvidence(tx, "mandate", "mandate_id", d.mandateId, version, d);
  // 부분 유니크 인덱스(현재 버전 1개)를 지키려면 INSERT 전에 직전 버전을 대체해야 한다.
  await supersede(tx, "mandate", "mandate_id", d.mandateId, version, recordedAt);
  await tx.query(
    `INSERT INTO mandate (mandate_id, version, facts_scope_id, from_party_id, to_party_id, right_kind, share_bps, status,
       valid_from, valid_to, recorded_at, visibility, source_ref, evidence_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [d.mandateId, version, d.factsScopeId, d.fromPartyId, d.toPartyId, d.rightKind, d.shareBps, d.status,
      d.validFrom, d.validTo ?? null, recordedAt, d.visibility ?? null, d.sourceRef ?? null, evidence.digest],
  );
  await evidence.link(tx, clock, "MANDATE", d.mandateId, version);
  await supersedeRequests(tx, "MANDATE", d.mandateId, version, recordedAt);
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
    ...(r.evidence_digest !== null && { evidenceDigest: r.evidence_digest }),
  };
}

/** 기록이 새 버전이 되면 그 전 버전에 대한 열린 확인 요청은 의미가 없어진다(원천 문서 설계 S3). */
async function supersedeRequests(tx: Tx, type: "CLAIM" | "MANDATE", id: string, version: number, at: string): Promise<void> {
  await withSystemScope(tx, () => tx.query(
    "UPDATE confirmation_request SET status = 'SUPERSEDED', decided_at = $4 WHERE record_type = $1 AND record_id = $2 AND status = 'OPEN' AND record_version < $3",
    [type, id, version, at]));
}

/**
 * 증빙 결정: 근거 문서를 주면 문서 해시로 digest를 만들고(직접 준 digest와 같이 오면 거부) 버전에 연결한다.
 * 문서를 주지 않으면 준 digest(이전 방식)를 쓰고, 그 digest가 직전 버전과 같으면 직전 버전의 근거 연결을 이어받는다(분쟁 개시·종결이 만드는 새 버전).
 */
async function resolveEvidence(
  tx: Tx, table: "right_claim" | "mandate", key: string, id: string, version: number, d: { evidenceDigest?: string; evidenceDocuments?: DocumentRef[]; linkedBy?: string },
): Promise<{ digest: string | null; link: (tx: Tx, clock: Clock, type: "CLAIM" | "MANDATE", id: string, version: number) => Promise<void> }> {
  if (d.evidenceDocuments !== undefined && d.evidenceDocuments.length > 0) {
    if (d.evidenceDigest !== undefined) throw invalid("INVALID_EVIDENCE", "give evidenceDocuments or evidenceDigest, not both");
    if (d.linkedBy === undefined) throw invalid("INVALID_EVIDENCE", "linkedBy is required with evidenceDocuments");
    const digest = await evidenceDigest(tx, d.evidenceDocuments);
    const refs = d.evidenceDocuments;
    return { digest, link: (tx, clock, type, rid, v) => linkEvidence(tx, clock, d.linkedBy!, type, rid, v, refs) };
  }
  const prior = version > 1 ? (await tx.query(`SELECT evidence_digest FROM ${table} WHERE ${key} = $1 AND version = $2`, [id, version - 1])).rows[0]?.evidence_digest ?? null : null;
  const digest = d.evidenceDigest ?? null;
  return { digest, link: async (tx, clock, type, rid, v) => { if (digest !== null && digest === prior) await carryEvidence(tx, clock, type, rid, v); } };
}
