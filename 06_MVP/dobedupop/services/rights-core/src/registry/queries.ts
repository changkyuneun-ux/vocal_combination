import type { Tx } from "../platform/db.ts";
import { withSystemScope } from "../platform/actor.ts";
import { notFound } from "../platform/errors.ts";
import { cursorKey, pageOf, ts, type Page } from "../platform/paging.ts";

type Rows = Record<string, any>[];

/**
 * 당사자 목록. restrict(플랫폼 밖 조회)면 공용 명부 범위(결정 TD8): 권리자로 활동하는 당사자(조직·작가·아티스트·참여 기관)는 모두 보이고,
 * 개인(멤버·세션·팬)은 관리 주체와, 그 당사자가 나오는 곡의 소유 테넌트(보이는 주장·스템이 가리킴)만 본다. id를 정확히 주면 찾을 수 있다.
 */
export async function listParties(tx: Tx, f: { type?: string; tenant?: string; id?: string; restrict?: boolean }, page: Page) {
  const after = cursorKey(page, ["s"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.type !== undefined) { p.push(f.type); w.push(`party_type = $${p.length}`); }
  if (f.id !== undefined) { p.push(f.id); w.push(`party_id = $${p.length}`); }
  else if (f.restrict === true) {
    w.push(`(party_type NOT IN ('MEMBER','SESSION','FAN') OR rc_party_visible(party_id)
             OR EXISTS (SELECT 1 FROM right_claim c WHERE c.target_id = party.party_id) OR EXISTS (SELECT 1 FROM stem s WHERE s.performer_party_id = party.party_id))`);
  }
  if (f.tenant !== undefined) { p.push(f.tenant); w.push(`tenant_id = $${p.length}`); }
  if (after) { p.push(after[0]); w.push(`party_id > $${p.length}`); }
  p.push(page.limit + 1);
  const rows = (await tx.query(`SELECT * FROM party ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY party_id LIMIT $${p.length}`, p)).rows;
  return pageOf(rows.map((r) => ({
    partyId: r.party_id as string, partyType: r.party_type as string, displayName: r.display_name as string,
    isni: (r.isni as string | null), ipiNo: (r.ipi_no as string | null), createdAt: ts(r.created_at)!, tenantId: r.tenant_id as string,
  })), page, (r) => [r.partyId]);
}

export async function listWorks(tx: Tx, _f: Record<string, never>, page: Page) {
  const after = cursorKey(page, ["s"]);
  const p: unknown[] = [];
  let where = "";
  if (after) { p.push(after[0]); where = `WHERE work_id > $1`; }
  p.push(page.limit + 1);
  const rows = (await tx.query(`SELECT * FROM work ${where} ORDER BY work_id LIMIT $${p.length}`, p)).rows;
  return pageOf(rows.map((r) => ({
    workId: r.work_id as string, title: r.title as string, iswc: r.iswc as string | null, createdAt: ts(r.created_at)!,
  })), page, (r) => [r.workId]);
}

const disputeOut = (r: Record<string, any>) => ({
  disputeId: r.dispute_id as string, targetType: r.target_type as string, targetId: r.target_id as string,
  factsScopeId: r.facts_scope_id as string, disputeReason: r.dispute_reason as string, status: r.status as string,
  openedAt: ts(r.opened_at)!, closedAt: ts(r.closed_at),
});

/** opened_at DESC, dispute_id ASC */
export async function listDisputes(tx: Tx, f: { status?: string; scope?: string }, page: Page) {
  const after = cursorKey(page, ["t", "s"]);
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.status !== undefined) { p.push(f.status); w.push(`status = $${p.length}`); }
  if (f.scope !== undefined) { p.push(f.scope); w.push(`facts_scope_id = $${p.length}`); }
  if (after) {
    p.push(after[0], after[1]);
    w.push(`(opened_at < $${p.length - 1}::timestamptz OR (opened_at = $${p.length - 1}::timestamptz AND dispute_id > $${p.length}))`);
  }
  p.push(page.limit + 1);
  const rows = (await tx.query(`SELECT * FROM dispute ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY opened_at DESC, dispute_id LIMIT $${p.length}`, p)).rows;
  return pageOf(rows.map(disputeOut), page, (r) => [r.openedAt, r.disputeId]);
}

/** 범위 행 + 마지막 facts 봉인. 최신 봉인은 doc_version(범위 안 기록 시각 수, 시각에 단조)이 가장 큰 facts 문서이고 knownAt은 sealed_through다. */
export async function getScope(tx: Tx, scopeId: string) {
  const s = (await tx.query("SELECT * FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rows[0];
  if (s === undefined) throw notFound("facts scope", scopeId);
  const seal = (await tx.query(
    "SELECT digest FROM sealed_document WHERE kind = 'facts' AND doc_id = $1 ORDER BY doc_version::int DESC, created_at DESC LIMIT 1", [scopeId],
  )).rows[0];
  return {
    factsScopeId: s.facts_scope_id as string, workId: s.work_id as string, lastVersion: s.last_version as number,
    createdAt: ts(s.created_at)!, sealedThrough: ts(s.sealed_through),
    // sealed_document에는 knownAt이 없다. 최신 봉인(가장 큰 doc_version)은 sealed_through(봉인한 knownAt의 최댓값)에서 만들어졌다고 본다.
    latestFactsSeal: seal === undefined ? null : { digest: seal.digest as string, knownAt: ts(s.sealed_through) },
  };
}

/** 범위의 사실 행 전부(각 id 순). 작품에 달린 녹음·슬롯·스템과 범위에 달린 목소리·주장·위임·분쟁. */
export async function getScopeFacts(tx: Tx, scopeId: string) {
  const s = (await tx.query("SELECT work_id FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rows[0];
  if (s === undefined) throw notFound("facts scope", scopeId);
  // 범위가 요청자에게 보이면(RLS) 그 곡 안의 행은 다 보인다 — 멤버가 확인해 쓴 새 버전(소유 테넌트가 다르다)도 곡의 현재 사실이다.
  return withSystemScope(tx, () => scopeFactsRows(tx, scopeId, s.work_id as string));
}

async function scopeFactsRows(tx: Tx, scopeId: string, workId: string) {
  const s = { work_id: workId };
  const q = async (sql: string, params: unknown[]): Promise<Rows> => (await tx.query(sql, params)).rows;
  // 한 PoolClient에서는 쿼리를 순차로 실행한다(동시 실행은 pg 경고).
  const recordings = await q("SELECT * FROM recording_version WHERE work_id = $1 ORDER BY recording_id", [s.work_id]);
  const slots = await q("SELECT p.* FROM part_slot p JOIN recording_version r ON r.recording_id = p.recording_id WHERE r.work_id = $1 ORDER BY p.slot_id", [s.work_id]);
  const parts = await q(
    `SELECT sp.* FROM slot_part sp JOIN part_slot p ON p.slot_id = sp.slot_id JOIN recording_version r ON r.recording_id = p.recording_id
      WHERE r.work_id = $1 ORDER BY sp.slot_id, sp.part_no`, [s.work_id]);
  const stems = await q("SELECT t.* FROM stem t JOIN recording_version r ON r.recording_id = t.recording_id WHERE r.work_id = $1 ORDER BY t.stem_id", [s.work_id]);
  const voices = await q("SELECT * FROM voice WHERE facts_scope_id = $1 ORDER BY voice_id", [scopeId]);
  const claims = await q("SELECT * FROM right_claim WHERE facts_scope_id = $1 ORDER BY claim_id, version", [scopeId]);
  const mandates = await q("SELECT * FROM mandate WHERE facts_scope_id = $1 ORDER BY mandate_id, version", [scopeId]);
  const disputes = await q("SELECT * FROM dispute WHERE facts_scope_id = $1 ORDER BY dispute_id", [scopeId]);
  // 봉인 뒤 원곡 파트 담당 바로잡기(0046): 현재 버전. 파트의 originalPartyId는 v1(봉인 때 값) 그대로다.
  const assigns = await q("SELECT * FROM part_assignment WHERE facts_scope_id = $1 AND superseded_at IS NULL ORDER BY slot_id, part_no", [scopeId]);
  return {
    recordings: recordings.map((r) => ({
      recordingId: r.recording_id as string, workId: r.work_id as string, masterOwnerPartyId: r.master_owner_party_id as string,
      isrc: r.isrc as string | null, versionTitle: r.version_title as string, createdAt: ts(r.created_at)!,
    })),
    slots: slots.map((r) => ({
      slotId: r.slot_id as string, recordingId: r.recording_id as string, startMs: r.start_ms as number, endMs: r.end_ms as number,
      durationMs: r.duration_ms as number, sortOrder: r.sort_order as number, sectionLabel: r.section_label as string | null,
      // 파트(결정 SL1): 슬롯 안 원곡 트랙 — 보컬·그룹·반주
      parts: parts.filter((p) => p.slot_id === r.slot_id).map((p) => ({
        partNo: p.part_no as number, kind: p.kind as string, role: p.role as string | null, startMs: p.start_ms as number, endMs: p.end_ms as number,
        durationMs: p.duration_ms as number, originalPartyId: p.original_party_id as string | null,
      })),
    })),
    stems: stems.map((r) => ({
      stemId: r.stem_id as string, slotId: r.slot_id as string, partNo: r.part_no as number, recordingId: r.recording_id as string,
      performerPartyId: r.performer_party_id as string | null, rightsBearing: r.rights_bearing as boolean, createdAt: ts(r.created_at)!,
    })),
    voices: voices.map((r) => ({ voiceId: r.voice_id as string, factsScopeId: r.facts_scope_id as string, kind: r.kind as string, createdAt: ts(r.created_at)! })),
    claims: claims.map((r) => ({
      claimId: r.claim_id as string, version: r.version as number, factsScopeId: r.facts_scope_id as string, sourceId: r.source_id as string,
      edge: r.edge as string, targetId: r.target_id as string, shareBps: r.share_bps as number, performerRole: r.performer_role as string | null,
      roleDetail: r.role_detail as string | null, status: r.status as string, validFrom: ts(r.valid_from)!, validTo: ts(r.valid_to),
      recordedAt: ts(r.recorded_at)!, supersededAt: ts(r.superseded_at), evidenceDigest: r.evidence_digest as string | null,
      visibility: r.visibility as string | null, sourceRef: r.source_ref as string | null,
    })),
    mandates: mandates.map((r) => ({
      mandateId: r.mandate_id as string, version: r.version as number, factsScopeId: r.facts_scope_id as string,
      fromPartyId: r.from_party_id as string, toPartyId: r.to_party_id as string, rightKind: r.right_kind as string,
      shareBps: r.share_bps as number, status: r.status as string, validFrom: ts(r.valid_from)!, validTo: ts(r.valid_to),
      recordedAt: ts(r.recorded_at)!, supersededAt: ts(r.superseded_at), visibility: r.visibility as string | null, sourceRef: r.source_ref as string | null,
    })),
    disputes: disputes.map(disputeOut),
    partAssignments: assigns.map((r) => ({
      assignmentId: r.assignment_id as string, version: r.version as number, slotId: r.slot_id as string, partNo: r.part_no as number,
      partyId: r.party_id as string, previousPartyId: r.previous_party_id as string, status: r.status as string,
      validFrom: ts(r.valid_from)!, recordedAt: ts(r.recorded_at)!,
    })),
  };
}
