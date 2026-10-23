import { withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { requestPartConfirmation } from "./confirmations.ts";
import { fenceScope } from "./repo.ts";

/**
 * IR 생성 뒤 원곡 파트 담당 바로잡기(0046, 시안 Song-Locked-FixPerf).
 * - 봉인 전에는 카탈로그 수정(PUT /slot-parts)으로 고친다 → 여기서는 409 NOT_SEALED.
 * - 봉인 뒤에는 slot_part(v1)를 그대로 두고 새 버전을 쌓는다. 기록 시각은 봉인 울타리 뒤라 다음 재고정부터 반영된다.
 * - 새 담당은 이 곡의 멤버(이 곡 보이스의 현재 소유자)만. 바뀐 멤버 둘(새 담당·이전 담당)에게 확인 요청을 보낸다.
 * - 조합 몫은 발행 때 고정된 스템 배정에서 오므로 이미 발행된 조합은 그대로다.
 */
export type PartAssignmentInput = { slotId?: unknown; partNo?: unknown; partyId?: unknown; validFrom?: unknown; reason?: unknown; evidenceDocuments?: unknown };

export type PartAssignment = {
  assignmentId: string; version: number; factsScopeId: string; slotId: string; partNo: number; partyId: string; previousPartyId: string;
  status: string; validFrom: string; recordedAt: string; recordedBy: string; evidenceDocument: { documentId: string; version: number } | null; reason: string | null;
};

export const toAssignment = (r: any): PartAssignment => ({
  assignmentId: r.assignment_id, version: r.version, factsScopeId: r.facts_scope_id, slotId: r.slot_id, partNo: r.part_no, partyId: r.party_id,
  previousPartyId: r.previous_party_id, status: r.status, validFrom: iso(r.valid_from)!, recordedAt: iso(r.recorded_at)!, recordedBy: r.recorded_by,
  evidenceDocument: r.evidence_document_id === null ? null : { documentId: r.evidence_document_id, version: r.evidence_document_version }, reason: r.reason,
});

const assignmentIdOf = (slotId: string, partNo: number) => `pa_${slotId}_${partNo}`;

/** 현재 버전(잠금). */
export async function currentAssignment(tx: Tx, assignmentId: string, lock = false) {
  const r = (await tx.query(`SELECT * FROM part_assignment WHERE assignment_id = $1 AND superseded_at IS NULL${lock ? " FOR UPDATE" : ""}`, [assignmentId])).rows[0];
  if (r === undefined) throw notFound("part assignment", assignmentId);
  return r;
}

/** 현재 버전을 닫고 같은 내용의 새 버전(상태만 바꿈)을 쓴다. */
export async function reviseAssignment(tx: Tx, clock: Clock, cur: any, status: "VERIFIED" | "DISPUTED", reason?: string): Promise<PartAssignment> {
  const at = clock.now();
  await tx.query("UPDATE part_assignment SET superseded_at = $3 WHERE assignment_id = $1 AND version = $2", [cur.assignment_id, cur.version, at]);
  const row = (await tx.query(
    `INSERT INTO part_assignment (assignment_id, version, facts_scope_id, slot_id, part_no, party_id, previous_party_id, status, valid_from, recorded_at,
       recorded_by, evidence_document_id, evidence_document_version, reason, owner_tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [cur.assignment_id, cur.version + 1, cur.facts_scope_id, cur.slot_id, cur.part_no, cur.party_id, cur.previous_party_id, status, cur.valid_from, at,
      cur.recorded_by, cur.evidence_document_id, cur.evidence_document_version, reason ?? cur.reason, cur.owner_tenant_id])).rows[0];
  return toAssignment(row);
}

export async function recordPartAssignment(tx: Tx, clock: Clock, actor: Actor, b: PartAssignmentInput): Promise<PartAssignment> {
  if (typeof b.slotId !== "string" || !Number.isInteger(b.partNo) || typeof b.partyId !== "string" || typeof b.validFrom !== "string" || Number.isNaN(Date.parse(b.validFrom))) {
    throw new DomainError("BAD_REQUEST", 400, "slotId, partNo (integer), partyId and validFrom (ISO instant) are required");
  }
  const slotId = b.slotId, partNo = b.partNo as number, partyId = b.partyId;
  const part = (await tx.query(
    `SELECT p.kind, p.original_party_id, s.facts_scope_id, s.sealed_through FROM slot_part p JOIN part_slot sl ON sl.slot_id = p.slot_id
       JOIN recording_version r ON r.recording_id = sl.recording_id JOIN facts_scope s ON s.work_id = r.work_id
      WHERE p.slot_id = $1 AND p.part_no = $2`, [slotId, partNo])).rows[0];
  if (part === undefined) throw notFound("slot part", `${slotId}/${partNo}`);
  const scopeId = part.facts_scope_id as string;
  if (part.sealed_through === null) throw conflict("NOT_SEALED", `song of ${slotId}/${partNo} has no IR yet — edit the slot part itself (PUT /slot-parts/${slotId}/${partNo})`);
  if (part.kind !== "VOCAL") throw invalid("NOT_VOCAL_PART", `${slotId}/${partNo} is a ${part.kind} part; only vocal parts have an original member`);
  // 이 곡의 멤버: 이 곡 보이스의 현재 소유자(보이스 소유 주장은 곡 소유 테넌트 밖 멤버가 확인해 쓴 새 버전일 수 있어 system 범위로 읽는다).
  const members = await withSystemScope(tx, async () => (await tx.query(
    `SELECT DISTINCT c.target_id FROM right_claim c JOIN voice v ON v.voice_id = c.source_id
      WHERE c.facts_scope_id = $1 AND v.facts_scope_id = $1 AND c.edge = 'OWNED_BY' AND c.superseded_at IS NULL AND c.status <> 'DISPUTED'`, [scopeId])).rows.map((r) => r.target_id as string));
  if (!members.includes(partyId)) throw invalid("NOT_SONG_MEMBER", `${partyId} owns no voice in this song; the original part owner must be one of its members`);
  const id = assignmentIdOf(slotId, partNo);
  const prev = (await tx.query("SELECT * FROM part_assignment WHERE assignment_id = $1 AND superseded_at IS NULL FOR UPDATE", [id])).rows[0];
  const effective = prev !== undefined && prev.status !== "DISPUTED" ? (prev.party_id as string) : (part.original_party_id as string);
  if (effective === partyId) throw conflict("NO_CHANGE", `${slotId}/${partNo} is already sung by ${partyId}`);
  const at = clock.now();
  await fenceScope(tx, scopeId, at);
  let doc: { documentId: string; version: number } | null = null;
  if (Array.isArray(b.evidenceDocuments) && b.evidenceDocuments.length > 0) {
    const d = b.evidenceDocuments[0] as { documentId?: unknown; version?: unknown };
    if (typeof d.documentId !== "string" || !Number.isInteger(d.version)) throw new DomainError("BAD_REQUEST", 400, "evidenceDocuments[0] needs documentId and version");
    if ((await tx.query("SELECT 1 FROM source_document WHERE document_id = $1 AND version = $2", [d.documentId, d.version])).rowCount === 0) throw notFound("document", `${d.documentId}@${d.version}`);
    doc = { documentId: d.documentId, version: d.version as number };
  }
  if (prev !== undefined) await tx.query("UPDATE part_assignment SET superseded_at = $3 WHERE assignment_id = $1 AND version = $2", [id, prev.version, at]);
  const row = (await tx.query(
    `INSERT INTO part_assignment (assignment_id, version, facts_scope_id, slot_id, part_no, party_id, previous_party_id, status, valid_from, recorded_at,
       recorded_by, evidence_document_id, evidence_document_version, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ASSERTED',$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id, (prev?.version ?? 0) + 1, scopeId, slotId, partNo, partyId, effective, new Date(b.validFrom).toISOString(), at, actor.userId,
      doc?.documentId ?? null, doc?.version ?? null, typeof b.reason === "string" ? b.reason : null])).rows[0];
  const out = toAssignment(row);
  // 이전 버전에 열린 확인 요청은 닫는다(내용이 바뀌었다).
  await tx.query("UPDATE confirmation_request SET status = 'SUPERSEDED', decided_at = $2 WHERE record_type = 'PART' AND record_id = $1 AND status = 'OPEN'", [id, at]);
  for (const cp of [partyId, effective]) if (actor.partyId !== cp) await requestPartConfirmation(tx, clock, actor, out, cp);
  await audit(tx, clock, { actor: actor.userId, action: "PART_ASSIGNMENT_RECORDED", entityType: "part_assignment", entityId: id, after: { version: out.version, from: effective, to: partyId } });
  return out;
}
