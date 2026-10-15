import { validateFacts, type FactsDocument } from "mdrl/facts";
import { withSystemScope } from "../platform/actor.ts";
import { iso, type Tx } from "../platform/db.ts";
import { invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { buildFactsDocument, type FactsRows } from "./convert-facts.ts";
import { loadSealed, sealDocument, type Sealed } from "./seal-store.ts";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** knownAt은 SQL(timestamptz)과 변환기(문자열 비교) 양쪽에서 쓰이므로 정규 밀리초 UTC 형식만 받는다. */
function requireInstant(knownAt: string): void {
  if (!INSTANT.test(knownAt) || Number.isNaN(Date.parse(knownAt)) || new Date(knownAt).toISOString() !== knownAt) {
    throw invalid("INVALID_INSTANT", `knownAt must be a canonical UTC millisecond instant: ${knownAt}`);
  }
}

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

/** 범위의 행 중 knownAt까지 기록된 것만 읽는다(통합 설계 9.3-5). 정렬은 변환기가 한다. */
export async function loadFactsRows(tx: Tx, scopeId: string, knownAt: string): Promise<FactsRows> {
  requireInstant(knownAt);
  const scope = (await tx.query(
    "SELECT s.facts_scope_id, w.work_id, w.iswc, w.created_at FROM facts_scope s JOIN work w ON w.work_id = s.work_id WHERE s.facts_scope_id = $1",
    [scopeId],
  )).rows[0];
  if (scope === undefined) throw notFound("facts scope", scopeId);
  const recordings = (await tx.query(
    "SELECT recording_id, work_id, isrc, created_at FROM recording_version WHERE work_id = $1 AND created_at <= $2", [scope.work_id, knownAt],
  )).rows;
  const stems = (await tx.query(
    "SELECT stem_id, recording_id, slot_id, rights_bearing, created_at FROM stem WHERE recording_id = ANY($1) AND created_at <= $2",
    [recordings.map((r) => r.recording_id), knownAt],
  )).rows;
  const voices = (await tx.query("SELECT voice_id, kind, created_at FROM voice WHERE facts_scope_id = $1 AND created_at <= $2", [scopeId, knownAt])).rows;
  const claims = (await tx.query("SELECT * FROM right_claim WHERE facts_scope_id = $1 AND recorded_at <= $2", [scopeId, knownAt])).rows;
  const mandates = (await tx.query("SELECT * FROM mandate WHERE facts_scope_id = $1 AND recorded_at <= $2", [scopeId, knownAt])).rows;
  const partyIds = new Set<string>([
    ...claims.filter((c) => c.edge !== "PERFORMED_BY").map((c) => c.target_id as string),
    ...mandates.flatMap((m) => [m.from_party_id as string, m.to_party_id as string]),
  ]);
  const parties = (await tx.query(
    "SELECT party_id, party_type, isni, ipi_no, created_at FROM party WHERE party_id = ANY($1) AND created_at <= $2", [[...partyIds], knownAt],
  )).rows;
  const recorded = (r: any) => ({
    version: r.version, status: r.status, validFrom: iso(r.valid_from)!, validTo: iso(r.valid_to), recordedAt: iso(r.recorded_at)!,
    supersededAt: iso(r.superseded_at), visibility: opt(r.visibility),
  });
  return {
    scopeId,
    work: { workId: scope.work_id, iswc: opt(scope.iswc), createdAt: iso(scope.created_at)! },
    recordings: recordings.map((r) => ({ recordingId: r.recording_id, workId: r.work_id, isrc: opt(r.isrc), createdAt: iso(r.created_at)! })),
    stems: stems.map((s) => ({ stemId: s.stem_id, recordingId: s.recording_id, slotId: s.slot_id, rightsBearing: s.rights_bearing, createdAt: iso(s.created_at)! })),
    voices: voices.map((v) => ({ voiceId: v.voice_id, kind: v.kind, createdAt: iso(v.created_at)! })),
    parties: parties.map((p) => ({ partyId: p.party_id, partyType: p.party_type, isni: opt(p.isni), ipiNo: opt(p.ipi_no), createdAt: iso(p.created_at)! })),
    claims: claims.map((c) => ({
      ...recorded(c), claimId: c.claim_id, sourceId: c.source_id, edge: c.edge, targetId: c.target_id, shareBps: c.share_bps,
      performerRole: opt(c.performer_role), roleDetail: opt(c.role_detail), evidenceDigest: opt(c.evidence_digest),
    })),
    mandates: mandates.map((m) => ({
      ...recorded(m), mandateId: m.mandate_id, fromPartyId: m.from_party_id, toPartyId: m.to_party_id, rightKind: m.right_kind, shareBps: m.share_bps,
      evidenceDigest: opt(m.evidence_digest),
    })),
  };
}

/**
 * S1: 범위의 facts를 knownAt 기준으로 만들고, MDRL로 검증한 뒤 봉인한다. 같은 행·같은 knownAt이면 같은 digest다.
 * 봉인 울타리(통합 설계 9.3-10): 행을 읽기 전에 범위 행을 FOR UPDATE로 잠가, knownAt 이전 시각으로 쓰고 아직 커밋하지 않은
 * 쓰기(FOR SHARE 보유)가 끝나기를 기다린다. 그리고 sealed_through를 knownAt 이상으로 올려 이후 그 시각 이전의 쓰기를 거부하게 한다.
 * - 미래의 knownAt은 울타리를 앞당겨 그때까지의 모든 쓰기를 막으므로 DB 시계(clock_timestamp)보다 늦으면 INVALID_INSTANT(422).
 * - 같은 트랜잭션에서 이 범위에 쓴 뒤 봉인하지 않는다: FOR SHARE → FOR UPDATE 승격은 다른 쓰기와 교착할 수 있다(409 RETRY로 드러남).
 */
export async function sealFacts(ctx: BridgeCtx, tx: Tx, scopeId: string, knownAt: string): Promise<Sealed & { knownAt: string }> {
  requireInstant(knownAt);
  if ((await tx.query("SELECT $1::timestamptz > clock_timestamp() AS future", [knownAt])).rows[0].future) {
    throw invalid("INVALID_INSTANT", `knownAt is in the future: ${knownAt}`);
  }
  // 범위 행은 요청자 범위에서 잠근다(보이지 않으면 404). facts는 곡 전체의 주장을 담아야 하므로 행 조회는 system 범위로 한다.
  const lock = await tx.query("SELECT 1 FROM facts_scope WHERE facts_scope_id = $1 FOR UPDATE", [scopeId]);
  if (lock.rowCount === 0) throw notFound("facts scope", scopeId);
  const doc = buildFactsDocument(await withSystemScope(tx, () => loadFactsRows(tx, scopeId, knownAt)), knownAt);
  const errors = validateFacts(doc);
  if (errors.length > 0) throw invalid("FACTS_INVALID", `facts ${scopeId} failed MDRL validation`, errors);
  const sealed = await sealDocument(ctx, tx, { kind: "facts", value: doc, docId: doc.id, docVersion: doc.version });
  await tx.query(
    `UPDATE facts_scope SET last_version = GREATEST(last_version, $2), sealed_through = GREATEST(COALESCE(sealed_through, $3), $3)
      WHERE facts_scope_id = $1`,
    [scopeId, Number(doc.version), knownAt],
  );
  return { ...sealed, knownAt };
}

export async function loadFacts(ctx: BridgeCtx, tx: Tx, digest: string): Promise<FactsDocument> {
  return (await loadSealed(ctx, tx, digest)) as FactsDocument;
}
