import { createHash, randomBytes } from "node:crypto";
import { requireRole, withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { DocumentStore } from "./store.ts";

export const DOCUMENT_KINDS = ["MASTER_CONTRACT", "PUBLISHING", "PERFORMER_CONSENT", "MANDATE", "PLATFORM_CONTRACT", "EVIDENCE"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
/** 받는 원문 형식과 크기 한도. 계약서는 PDF가 기본이고 스캔 이미지도 받는다. */
export const DOCUMENT_MIME = ["application/pdf", "image/png", "image/jpeg"] as const;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** 보관 기한(결정 D3): 효력 종료 후 10년(상법 제33조의 영업 중요서류 보관 기간). 법무 확인 뒤 바뀔 수 있다. */
export const RETENTION_YEARS = 10;

export type DocumentRef = { documentId: string; version: number };
export type DocumentMeta = {
  kind?: unknown; title?: unknown; parties?: unknown; effectiveFrom?: unknown; effectiveTo?: unknown; confidentiality?: unknown;
};

const ID = /^[A-Za-z0-9._-]+$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const bad = (m: string) => invalid("INVALID_DOCUMENT", m);

function requireEditor(actor: Actor): void {
  if (actor.scope !== "platform") requireRole(actor, "RIGHTS_EDITOR");
}

function retentionUntil(effectiveTo: string | null): string | null {
  if (effectiveTo === null) return null;
  const d = new Date(effectiveTo);
  d.setUTCFullYear(d.getUTCFullYear() + RETENTION_YEARS);
  return d.toISOString();
}

async function parseMeta(tx: Tx, m: DocumentMeta, base?: Record<string, any>) {
  const kind = (m.kind ?? base?.kind) as string;
  if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) throw bad(`kind must be one of ${DOCUMENT_KINDS.join(", ")}`);
  const title = (typeof m.title === "string" ? m.title : base?.title) as string;
  if (typeof title !== "string" || title.trim() === "") throw bad("title is required");
  const parties = m.parties === undefined ? (base?.parties ?? []) as string[] : m.parties;
  if (!Array.isArray(parties) || !parties.every((p) => typeof p === "string" && ID.test(p))) throw bad("parties must be party ids");
  const known = (await withSystemScope(tx, async () => (await tx.query("SELECT party_id FROM party WHERE party_id = ANY($1)", [parties])).rows)).map((r) => r.party_id as string);
  const unknown = parties.filter((p) => !known.includes(p));
  if (unknown.length > 0) throw bad(`unknown parties: ${unknown.join(", ")}`);
  const instant = (v: unknown, name: string, fallback: string | null): string | null => {
    if (v === undefined) return fallback;
    if (v === null || v === "") return null;
    if (typeof v !== "string" || !INSTANT.test(v) || new Date(v).toISOString() !== v) throw bad(`${name} must be ms UTC ISO`);
    return v;
  };
  const effectiveFrom = instant(m.effectiveFrom, "effectiveFrom", base?.effective_from ? iso(base.effective_from)! : null);
  const effectiveTo = instant(m.effectiveTo, "effectiveTo", base?.effective_to ? iso(base.effective_to)! : null);
  if (effectiveFrom !== null && effectiveTo !== null && effectiveTo <= effectiveFrom) throw bad("effectiveTo must be after effectiveFrom");
  const confidentiality = (m.confidentiality ?? base?.confidentiality ?? "PARTIES") as string;
  if (confidentiality !== "OWNER" && confidentiality !== "PARTIES") throw bad("confidentiality must be OWNER or PARTIES");
  return { kind, title: title.trim(), parties: [...new Set(parties)].sort(), effectiveFrom, effectiveTo, confidentiality };
}

function checkFile(mime: string, bytes: Uint8Array): void {
  if (!DOCUMENT_MIME.includes(mime as (typeof DOCUMENT_MIME)[number])) throw bad(`file type must be one of ${DOCUMENT_MIME.join(", ")}`);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES) throw bad(`file must be 1..${MAX_DOCUMENT_BYTES} bytes`);
}

/**
 * 원천 문서 올리기(권리자 포털·운영). 같은 테넌트에 같은 파일(해시)이 이미 있으면 그 문서를 돌려준다(created=false).
 * 문서 id를 주지 않으면 파일 해시로 만든다.
 */
export async function uploadDocument(
  tx: Tx, clock: Clock, store: DocumentStore, actor: Actor, input: DocumentMeta & { documentId?: unknown; mime: string; bytes: Uint8Array },
): Promise<{ created: boolean; document: Awaited<ReturnType<typeof getDocument>> }> {
  requireEditor(actor);
  checkFile(input.mime, input.bytes);
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  // 소유 테넌트: 요청자 테넌트, break-glass 대행 중이면 대상 테넌트(행 기본값과 같은 규칙). 저장소 암호화 키도 이 테넌트 키다.
  const owner = (await tx.query("SELECT rc_owner_default() AS t")).rows[0].t as string;
  const same = (await tx.query("SELECT document_id FROM source_document WHERE owner_tenant_id = $1 AND file_sha256 = $2", [owner, hash])).rows[0];
  if (same !== undefined) return { created: false, document: await getDocument(tx, same.document_id as string) };
  const documentId = input.documentId === undefined ? `doc_${hash.slice(0, 16)}` : input.documentId;
  if (typeof documentId !== "string" || !ID.test(documentId)) throw bad("documentId must be an id");
  if ((await withSystemScope(tx, async () => (await tx.query("SELECT 1 FROM source_document WHERE document_id = $1", [documentId])).rowCount)) !== 0) {
    throw conflict("DOCUMENT_EXISTS", `document ${documentId} exists; upload a new version instead`);
  }
  const meta = await parseMeta(tx, input);
  const { uri } = await store.put(owner, input.bytes);
  await insertVersion(tx, clock, actor, owner, documentId, 1, meta, { sha256: hash, size: input.bytes.byteLength, mime: input.mime, uri });
  await audit(tx, clock, { actor: actor.userId, action: "DOCUMENT_UPLOADED", entityType: "source_document", entityId: documentId, after: { version: 1, sha256: hash, kind: meta.kind } });
  return { created: true, document: await getDocument(tx, documentId) };
}

/**
 * 생성 문서(원천 문서 설계 S4): 표준 계약 서명본·실연 동의서 원문. 시스템이 만들므로 올리기 형식 검사(PDF·이미지)를 거치지 않고
 * 사람이 읽는 HTML(UTF-8)도 받는다. 출처는 TEMPLATE_SIGNED, 모든 당사자가 서명했으므로 상태는 CONFIRMED다. 소유 테넌트를 직접 정한다.
 */
export async function storeGeneratedDocument(
  tx: Tx, clock: Clock, store: DocumentStore,
  input: { owner: string; documentId: string; kind: DocumentKind; title: string; parties: string[]; effectiveFrom: string | null; effectiveTo: string | null; html: string; by: string },
): Promise<DocumentRef> {
  const meta = await parseMeta(tx, { kind: input.kind, title: input.title, parties: input.parties, effectiveFrom: input.effectiveFrom ?? undefined, effectiveTo: input.effectiveTo ?? undefined });
  const bytes = new TextEncoder().encode(input.html);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const { uri } = await store.put(input.owner, bytes);
  await withSystemScope(tx, async () => {
    if ((await tx.query("SELECT 1 FROM source_document WHERE document_id = $1", [input.documentId])).rowCount !== 0) {
      throw conflict("DOCUMENT_EXISTS", `document ${input.documentId} exists`);
    }
    await tx.query(
      `INSERT INTO source_document (document_id, version, owner_tenant_id, kind, title, parties, effective_from, effective_to,
         file_sha256, byte_size, mime, storage_uri, origin, status, confidentiality, uploaded_by, uploaded_at, retention_until)
       VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,'text/html',$10,'TEMPLATE_SIGNED','CONFIRMED','PARTIES',$11,$12,$13)`,
      [input.documentId, input.owner, meta.kind, meta.title, meta.parties, meta.effectiveFrom, meta.effectiveTo, hash, bytes.byteLength, uri, input.by, clock.now(), retentionUntil(meta.effectiveTo)]);
  });
  await audit(tx, clock, { actor: input.by, action: "DOCUMENT_GENERATED", entityType: "source_document", entityId: input.documentId, after: { version: 1, sha256: hash, kind: meta.kind } });
  return { documentId: input.documentId, version: 1 };
}

/** 새 버전 올리기: 원문을 고치면 새 버전이다. 메타데이터는 주지 않은 항목만 이전 버전에서 이어받는다. 이전 버전과 연결된 기록은 그대로 이전 버전을 가리킨다. */
export async function uploadVersion(
  tx: Tx, clock: Clock, store: DocumentStore, actor: Actor, documentId: string, input: DocumentMeta & { mime: string; bytes: Uint8Array },
) {
  requireEditor(actor);
  checkFile(input.mime, input.bytes);
  const prev = (await tx.query("SELECT * FROM source_document WHERE document_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE", [documentId])).rows[0];
  if (prev === undefined) throw notFound("document", documentId);
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  if (hash === prev.file_sha256) throw conflict("SAME_FILE", `version ${prev.version} already has this file`);
  const meta = await parseMeta(tx, input, prev);
  const { uri } = await store.put(prev.owner_tenant_id as string, input.bytes);
  const version = (prev.version as number) + 1;
  await insertVersion(tx, clock, actor, prev.owner_tenant_id as string, documentId, version, meta, { sha256: hash, size: input.bytes.byteLength, mime: input.mime, uri });
  await audit(tx, clock, { actor: actor.userId, action: "DOCUMENT_VERSIONED", entityType: "source_document", entityId: documentId, after: { version, sha256: hash } });
  return getDocument(tx, documentId);
}

async function insertVersion(
  tx: Tx, clock: Clock, actor: Actor, owner: string, documentId: string, version: number, m: Awaited<ReturnType<typeof parseMeta>>,
  f: { sha256: string; size: number; mime: string; uri: string },
) {
  await tx.query(
    `INSERT INTO source_document (document_id, version, owner_tenant_id, kind, title, parties, effective_from, effective_to,
       file_sha256, byte_size, mime, storage_uri, confidentiality, uploaded_by, uploaded_at, retention_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [documentId, version, owner, m.kind, m.title, m.parties, m.effectiveFrom, m.effectiveTo, f.sha256, f.size, f.mime, f.uri, m.confidentiality,
      actor.userId, clock.now(), retentionUntil(m.effectiveTo)],
  );
}

function toVersion(r: any) {
  return {
    version: r.version as number, kind: r.kind as DocumentKind, title: r.title as string, parties: r.parties as string[],
    effectiveFrom: iso(r.effective_from), effectiveTo: iso(r.effective_to), sha256: r.file_sha256 as string, byteSize: Number(r.byte_size), mime: r.mime as string,
    origin: r.origin as string, status: r.status as string, ...(r.status_reason !== null && { statusReason: r.status_reason as string }),
    confidentiality: r.confidentiality as string, uploadedBy: r.uploaded_by as string, uploadedAt: iso(r.uploaded_at)!,
    retentionUntil: iso(r.retention_until), ...(r.disposed_at !== null && { disposedAt: iso(r.disposed_at)! }),
  };
}

/** 문서 상세: 모든 버전(최신이 앞)과 버전별로 근거로 삼은 기록. */
export async function getDocument(tx: Tx, documentId: string) {
  const rows = (await tx.query("SELECT * FROM source_document WHERE document_id = $1 ORDER BY version DESC", [documentId])).rows;
  if (rows.length === 0) throw notFound("document", documentId);
  const links = (await tx.query(
    "SELECT record_type, record_id, record_version, document_version FROM record_evidence WHERE document_id = $1 ORDER BY record_type, record_id, record_version", [documentId])).rows;
  const clauses = (await tx.query("SELECT * FROM document_clause WHERE document_id = $1 ORDER BY page NULLS LAST, marked_at, clause_id", [documentId])).rows;
  const clauseLinks = (await tx.query(
    "SELECT clause_id, record_type, record_id, record_version FROM record_clause WHERE clause_id = ANY($1) ORDER BY record_type, record_id, record_version", [clauses.map((c) => c.clause_id)])).rows;
  return {
    documentId, ownerTenantId: rows[0].owner_tenant_id as string,
    versions: rows.map((r) => ({
      ...toVersion(r),
      records: links.filter((l) => l.document_version === r.version).map((l) => ({ type: l.record_type as string, id: l.record_id as string, version: l.record_version as number })),
      clauses: clauses.filter((c) => c.document_version === r.version).map((c) => ({
        clauseId: c.clause_id as string, page: c.page as number | null, quote: c.quote as string, clauseType: c.clause_type as string, ...(c.note !== null && { note: c.note as string }),
        markedBy: c.marked_by as string, markedAt: iso(c.marked_at)!,
        records: clauseLinks.filter((l) => l.clause_id === c.clause_id).map((l) => ({ type: l.record_type as string, id: l.record_id as string, version: l.record_version as number })),
      })),
    })),
  };
}

/** 문서 목록(최신 버전 기준). RLS로 소유 테넌트·당사자·플랫폼만 보인다. */
export async function listDocuments(tx: Tx, f: { kind?: string; party?: string }) {
  const rows = (await tx.query(
    `SELECT DISTINCT ON (document_id) * FROM source_document
      WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR $2 = ANY(parties))
      ORDER BY document_id, version DESC`, [f.kind ?? null, f.party ?? null])).rows;
  return rows.sort((a, b) => (iso(b.uploaded_at)! < iso(a.uploaded_at)! ? -1 : 1)).map((r) => ({ documentId: r.document_id as string, ownerTenantId: r.owner_tenant_id as string, ...toVersion(r) }));
}

/** 원문 읽기: 저장소에서 꺼내 해시를 다시 계산해 대조한다. 다르면 DOCUMENT_CORRUPT(봉인 저장소와 같은 규칙). */
export async function readDocumentFile(tx: Tx, store: DocumentStore, ref: DocumentRef): Promise<{ mime: string; bytes: Uint8Array; title: string }> {
  const r = (await tx.query("SELECT * FROM source_document WHERE document_id = $1 AND version = $2", [ref.documentId, ref.version])).rows[0];
  if (r === undefined) throw notFound("document", `${ref.documentId}@${ref.version}`);
  if (r.disposed_at !== null) throw new DomainError("DOCUMENT_DISPOSED", 410, `${ref.documentId}@${ref.version} was disposed at ${iso(r.disposed_at)} after its retention period`);
  const bytes = await store.get(r.owner_tenant_id as string, r.storage_uri as string);
  if (createHash("sha256").update(bytes).digest("hex") !== r.file_sha256) {
    throw new DomainError("DOCUMENT_CORRUPT", 500, `stored file of ${ref.documentId}@${ref.version} does not match its sha256`);
  }
  return { mime: r.mime as string, bytes, title: r.title as string };
}

/** 잘못 올린 문서 표시(사유 필수). 지우지 않는다. 이 버전을 이미 근거로 삼은 기록은 그대로 이 버전을 가리킨다. */
export async function rejectDocument(tx: Tx, clock: Clock, actor: Actor, ref: DocumentRef, reason: unknown) {
  requireEditor(actor);
  if (typeof reason !== "string" || reason.trim() === "") throw new DomainError("BAD_REQUEST", 400, "reason is required");
  const r = await tx.query("UPDATE source_document SET status = 'REJECTED', status_reason = $3 WHERE document_id = $1 AND version = $2 AND status <> 'REJECTED' RETURNING 1",
    [ref.documentId, ref.version, reason.trim()]);
  if (r.rowCount === 0) throw notFound("document", `${ref.documentId}@${ref.version}`);
  await audit(tx, clock, { actor: actor.userId, action: "DOCUMENT_REJECTED", entityType: "source_document", entityId: ref.documentId, after: { version: ref.version, reason: reason.trim() } });
  return getDocument(tx, ref.documentId);
}

/**
 * 폐기(운영, 결정 D3): 보관 기한이 지난 원문만 지운다. 이 문서를 근거로 한 기록의 곡에 열린 분쟁이 있으면 끝날 때까지 미룬다(법적 보존).
 * 해시·메타데이터·연결·폐기 기록은 남는다. 봉인된 facts의 근거 digest는 계속 남는다.
 */
export async function disposeDocument(tx: Tx, clock: Clock, store: DocumentStore, actor: Actor, ref: DocumentRef) {
  requireRole(actor, "SPACE_OPS");
  const r = (await tx.query("SELECT * FROM source_document WHERE document_id = $1 AND version = $2 FOR UPDATE", [ref.documentId, ref.version])).rows[0];
  if (r === undefined) throw notFound("document", `${ref.documentId}@${ref.version}`);
  if (r.disposed_at !== null) throw conflict("ALREADY_DISPOSED", `${ref.documentId}@${ref.version} is already disposed`);
  const now = clock.now();
  if (r.retention_until === null || iso(r.retention_until)! > now) {
    throw conflict("RETENTION_NOT_OVER", `${ref.documentId}@${ref.version} must be kept until ${iso(r.retention_until) ?? "its effective end is set"}`);
  }
  const held = await withSystemScope(tx, async () => (await tx.query(
    `SELECT 1 FROM record_evidence e
       JOIN dispute d ON d.status = 'OPEN' AND d.facts_scope_id = COALESCE(
         (SELECT facts_scope_id FROM right_claim WHERE claim_id = e.record_id LIMIT 1),
         (SELECT facts_scope_id FROM mandate WHERE mandate_id = e.record_id LIMIT 1),
         (SELECT facts_scope_id FROM consent_agreement WHERE consent_id = e.record_id))
      WHERE e.document_id = $1 AND e.document_version = $2 LIMIT 1`, [ref.documentId, ref.version])).rowCount ?? 0);
  if (held > 0) throw conflict("LEGAL_HOLD", `${ref.documentId}@${ref.version} supports a record under an open dispute`);
  await store.dispose(r.storage_uri as string);
  await tx.query("UPDATE source_document SET disposed_at = $3, disposed_by = $4 WHERE document_id = $1 AND version = $2", [ref.documentId, ref.version, now, actor.userId]);
  await audit(tx, clock, { actor: actor.userId, action: "DOCUMENT_DISPOSED", entityType: "source_document", entityId: ref.documentId, after: { version: ref.version, sha256: r.file_sha256 } });
  return getDocument(tx, ref.documentId);
}

export const CLAUSE_TYPES = ["SHARE", "RIGHT_HOLDER", "MANDATE", "SCOPE", "PERIOD", "SPLIT_RATE", "OTHER"] as const;

/** 조항 표시(원천 문서 설계 S3): 원문의 근거 위치(쪽·인용). 사람이 표시한다(자동 추출은 하지 않는다, D2). 거부·폐기된 버전에는 표시하지 않는다. */
export async function addClause(tx: Tx, clock: Clock, actor: Actor, ref: DocumentRef, input: { page?: unknown; quote?: unknown; clauseType?: unknown; note?: unknown }) {
  requireEditor(actor);
  const d = (await tx.query("SELECT status, disposed_at FROM source_document WHERE document_id = $1 AND version = $2", [ref.documentId, ref.version])).rows[0];
  if (d === undefined) throw notFound("document", `${ref.documentId}@${ref.version}`);
  if (d.status === "REJECTED" || d.disposed_at !== null) throw invalid("DOCUMENT_UNUSABLE", `${ref.documentId}@${ref.version} is not usable`);
  if (typeof input.quote !== "string" || input.quote.trim() === "") throw bad("quote is required (the clause text)");
  if (!CLAUSE_TYPES.includes(input.clauseType as (typeof CLAUSE_TYPES)[number])) throw bad(`clauseType must be one of ${CLAUSE_TYPES.join(", ")}`);
  if (input.page !== undefined && input.page !== null && !(Number.isInteger(input.page) && (input.page as number) >= 1)) throw bad("page must be a positive integer");
  const clauseId = `cls_${randomBytes(8).toString("hex")}`;
  await tx.query(
    "INSERT INTO document_clause (clause_id, document_id, document_version, page, quote, clause_type, note, marked_by, marked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [clauseId, ref.documentId, ref.version, input.page ?? null, input.quote.trim(), input.clauseType, typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim() : null, actor.userId, clock.now()]);
  return { clauseId, ...ref };
}

/** 근거 참조 모양 검사(요청 본문). */
export function parseRefs(v: unknown, name = "evidenceDocuments"): DocumentRef[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((r) => typeof r === "object" && r !== null && typeof r.documentId === "string" && Number.isInteger(r.version))) {
    throw new DomainError("BAD_REQUEST", 400, `${name} must be a non-empty array of {documentId, version}`);
  }
  return v.map((r) => ({ documentId: r.documentId as string, version: r.version as number }));
}

/**
 * 근거 문서의 증빙 digest(facts의 evidence로 봉인되는 값, 형식 `mdrl:sha256:<hex>`).
 * - 문서 하나: 그 원문 파일의 SHA-256. 원문을 받은 사람이 바로 대조할 수 있다.
 * - 여러 문서: 원문 해시(hex)들을 정렬한 JSON 배열(JCS와 같다)의 SHA-256.
 * 문서는 요청자에게 보여야 하고(RLS), 거부·폐기된 버전은 근거로 쓸 수 없다.
 */
export async function evidenceDigest(tx: Tx, refs: DocumentRef[]): Promise<string> {
  const hashes: string[] = [];
  for (const ref of refs) {
    const r = (await tx.query("SELECT file_sha256, status, disposed_at FROM source_document WHERE document_id = $1 AND version = $2", [ref.documentId, ref.version])).rows[0];
    if (r === undefined) throw notFound("document", `${ref.documentId}@${ref.version}`);
    if (r.status === "REJECTED" || r.disposed_at !== null) throw invalid("DOCUMENT_UNUSABLE", `${ref.documentId}@${ref.version} is ${r.status === "REJECTED" ? "rejected" : "disposed"}`);
    hashes.push(r.file_sha256 as string);
  }
  const unique = [...new Set(hashes)].sort();
  return `mdrl:sha256:${unique.length === 1 ? unique[0] : createHash("sha256").update(JSON.stringify(unique)).digest("hex")}`;
}

export async function linkEvidence(tx: Tx, clock: Clock, userId: string, type: "CLAIM" | "MANDATE" | "CONSENT", recordId: string, recordVersion: number, refs: DocumentRef[]) {
  for (const ref of refs) {
    await tx.query(
      `INSERT INTO record_evidence (record_type, record_id, record_version, document_id, document_version, linked_by, linked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [type, recordId, recordVersion, ref.documentId, ref.version, userId, clock.now()]);
  }
}

/** 주장·위임의 새 버전이 근거를 바꾸지 않았으면(같은 증빙 digest) 이전 버전의 연결을 이어받는다. */
export async function carryEvidence(tx: Tx, clock: Clock, type: "CLAIM" | "MANDATE", recordId: string, version: number): Promise<void> {
  if (version <= 1) return;
  await withSystemScope(tx, async () => {
    await tx.query(
      `INSERT INTO record_evidence (record_type, record_id, record_version, document_id, document_version, linked_by, linked_at)
       SELECT record_type, record_id, $3, document_id, document_version, linked_by, $4 FROM record_evidence
        WHERE record_type = $1 AND record_id = $2 AND record_version = $3 - 1 ON CONFLICT DO NOTHING`, [type, recordId, version, clock.now()]);
    await carryClauses(tx, clock, type, recordId, version);
  });
}

/** 조항 연결도 이어받는다(새 버전이 그 조항의 문서를 여전히 근거로 삼는 경우만). */
export async function carryClauses(tx: Tx, clock: Clock, type: "CLAIM" | "MANDATE", recordId: string, version: number): Promise<void> {
  await tx.query(
    `INSERT INTO record_clause (record_type, record_id, record_version, clause_id, linked_by, linked_at)
     SELECT k.record_type, k.record_id, $3, k.clause_id, k.linked_by, $4 FROM record_clause k JOIN document_clause c ON c.clause_id = k.clause_id
      WHERE k.record_type = $1 AND k.record_id = $2 AND k.record_version = $3 - 1
        AND EXISTS (SELECT 1 FROM record_evidence e WHERE e.record_type = $1 AND e.record_id = $2 AND e.record_version = $3
                     AND e.document_id = c.document_id AND e.document_version = c.document_version)
     ON CONFLICT DO NOTHING`, [type, recordId, version, clock.now()]);
}

/** 기록들의 근거 문서(요약 화면용). */
export async function evidenceOf(tx: Tx, type: string, records: { id: string; version: number }[]) {
  if (records.length === 0) return new Map<string, { documentId: string; version: number; title: string; kind: string; status: string }[]>();
  const rows = (await tx.query(
    `SELECT e.record_id, e.record_version, d.document_id, d.version, d.title, d.kind, d.status FROM record_evidence e
       JOIN source_document d ON d.document_id = e.document_id AND d.version = e.document_version
      WHERE e.record_type = $1 AND (e.record_id, e.record_version) IN (SELECT * FROM unnest($2::text[], $3::int[]))
      ORDER BY d.document_id, d.version`, [type, records.map((r) => r.id), records.map((r) => r.version)])).rows;
  const out = new Map<string, { documentId: string; version: number; title: string; kind: string; status: string }[]>();
  for (const r of rows) {
    const k = `${r.record_id}@${r.record_version}`;
    out.set(k, [...(out.get(k) ?? []), { documentId: r.document_id, version: r.version, title: r.title, kind: r.kind, status: r.status }]);
  }
  return out;
}
