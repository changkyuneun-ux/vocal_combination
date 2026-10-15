import { carryClauses } from "../documents/service.ts";
import { withSystemScope, type Actor } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError, invalid, notFound } from "../platform/errors.ts";
import { currentClaim, currentMandate, recordClaim, recordMandate } from "./service.ts";

/**
 * 조항을 기록의 근거로 연결한다(원천 문서 설계 S3). 기록의 현재 버전이 이미 그 문서를 근거로 삼고 있으면 조항만 붙이고,
 * 아니면 그 문서를 근거에 더한 새 버전을 남긴다(증빙 digest가 바뀌므로 봉인 facts도 바뀐다). 동의는 근거 문서가 같을 때만 조항을 붙인다.
 */
export async function linkClause(tx: Tx, clock: Clock, actor: Actor, clauseId: string, input: { recordType?: unknown; recordId?: unknown }) {
  const type = input.recordType;
  if ((type !== "CLAIM" && type !== "MANDATE" && type !== "CONSENT") || typeof input.recordId !== "string") {
    throw new DomainError("BAD_REQUEST", 400, "recordType (CLAIM | MANDATE | CONSENT) and recordId are required");
  }
  const c = (await tx.query("SELECT clause_id, document_id, document_version FROM document_clause WHERE clause_id = $1", [clauseId])).rows[0];
  if (c === undefined) throw notFound("clause", clauseId);
  const link = (version: number) => tx.query(
    "INSERT INTO record_clause (record_type, record_id, record_version, clause_id, linked_by, linked_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    [type, input.recordId, version, clauseId, actor.userId, clock.now()]);
  if (type === "CONSENT") {
    const k = (await tx.query("SELECT source_document_id, source_document_version FROM consent_agreement WHERE consent_id = $1", [input.recordId])).rows[0];
    if (k === undefined) throw notFound("consent", input.recordId);
    if (k.source_document_id !== c.document_id || k.source_document_version !== c.document_version) throw invalid("CLAUSE_NOT_IN_EVIDENCE", "the consent cites a different source document");
    await link(0);
    return { recordType: type, recordId: input.recordId, version: 0, clauseId };
  }
  const cur = type === "CLAIM" ? await currentClaim(tx, input.recordId) : await currentMandate(tx, input.recordId);
  const docs = (await tx.query("SELECT document_id, document_version FROM record_evidence WHERE record_type = $1 AND record_id = $2 AND record_version = $3 ORDER BY document_id, document_version",
    [type, input.recordId, cur.version])).rows.map((r) => ({ documentId: r.document_id as string, version: r.document_version as number }));
  if (docs.some((d) => d.documentId === c.document_id && d.version === c.document_version)) {
    await link(cur.version);
    return { recordType: type, recordId: input.recordId, version: cur.version, clauseId };
  }
  const { version, evidenceDigest: _old, ...draft } = cur;
  const evidenceDocuments = [...docs, { documentId: c.document_id as string, version: c.document_version as number }];
  const rec = type === "CLAIM"
    ? await recordClaim(tx, clock, { ...(draft as Awaited<ReturnType<typeof currentClaim>>), evidenceDocuments, linkedBy: actor.userId }, { expectedVersion: version })
    : await recordMandate(tx, clock, { ...(draft as Awaited<ReturnType<typeof currentMandate>>), evidenceDocuments, linkedBy: actor.userId }, { expectedVersion: version });
  await withSystemScope(tx, () => carryClauses(tx, clock, type, input.recordId as string, rec.version));
  await link(rec.version);
  return { recordType: type, recordId: input.recordId, version: rec.version, clauseId };
}
