import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Db, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { Jobs } from "../platform/jobs.ts";
import type { AudioDeps } from "./deps.ts";
import { sourceCheck } from "./source.ts";
import { invalidateStem } from "../decisions/cache.ts";

export type AudioStatus = "PENDING" | "READY" | "QC_FAILED" | "REVIEW" | "BLOCKED";
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * 스템 오디오 올리기(권리자 포털·운영): 원본을 저장하고 검사 작업(audio-check)을 큐에 넣는다. 결과가 나올 때까지 PENDING이고,
 * PENDING·QC_FAILED·REVIEW·BLOCKED 스템은 발행되지 않는다. 다시 올리면 이전 결과를 지우고 다시 검사한다.
 */
export async function uploadStemAudio(
  tx: Tx, clock: Clock, jobs: Jobs, audio: AudioDeps, actor: Actor, input: { stemId: string; bytes: Uint8Array; contentType: string },
) {
  requireRole(actor, "RIGHTS_EDITOR");
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_BYTES) throw invalid("AUDIO_SIZE", `audio must be 1..${MAX_BYTES} bytes`);
  if ((await tx.query("SELECT 1 FROM stem WHERE stem_id = $1", [input.stemId])).rowCount === 0) throw notFound("stem", input.stemId);
  const { sha256, uri } = await audio.store.put(input.bytes);
  const now = clock.now();
  await tx.query(
    `INSERT INTO stem_audio (stem_id, file_sha256, byte_size, content_type, storage_uri, uploaded_by, uploaded_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')
     ON CONFLICT (stem_id) DO UPDATE SET file_sha256 = EXCLUDED.file_sha256, byte_size = EXCLUDED.byte_size, content_type = EXCLUDED.content_type,
       storage_uri = EXCLUDED.storage_uri, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = EXCLUDED.uploaded_at, status = 'PENDING',
       qc_fail_code = NULL, qc_report = NULL, source_result = NULL, source_report = NULL, fingerprint = NULL, duration_ms = NULL, checked_at = NULL,
       reviewed_by = NULL, reviewed_at = NULL, review_reason = NULL`,
    [input.stemId, sha256, input.bytes.byteLength, input.contentType, uri, actor.userId, now],
  );
  await invalidateStem(tx, input.stemId);
  await audit(tx, clock, { actor: actor.userId, action: "STEM_AUDIO_UPLOAD", entityType: "stem", entityId: input.stemId, after: { fileSha256: sha256, byteSize: input.bytes.byteLength } });
  await jobs.send(tx, "audio-check", { stemId: input.stemId });
  return { stemId: input.stemId, status: "PENDING" as const, fileSha256: sha256 };
}

/**
 * 검사 작업(워커, system 범위): 오디오 처리 서비스로 QC·지문을 받고 소스 출처를 판정해 상태를 정한다.
 * QC 실패면 QC_FAILED, 출처가 BLOCK이면 BLOCKED, REVIEW면 REVIEW(운영 판단), 그 밖에는 READY.
 * 분석은 트랜잭션 밖에서 하고(오래 걸린다), 그 사이 다시 올렸으면(해시가 바뀜) 결과를 버린다.
 */
export async function checkStemAudio(d: { db: Db; clock: Clock; audio: AudioDeps }, stemId: string): Promise<void> {
  const row = (await d.db.pool.query("SELECT storage_uri, file_sha256, status FROM stem_audio WHERE stem_id = $1", [stemId])).rows[0];
  if (row === undefined || row.status !== "PENDING") return;
  const a = await d.audio.analyzer(await d.audio.store.get(row.storage_uri as string));
  await d.db.tx(async (tx) => {
    const cur = (await tx.query("SELECT file_sha256, status FROM stem_audio WHERE stem_id = $1 FOR UPDATE", [stemId])).rows[0];
    if (cur === undefined || cur.status !== "PENDING" || cur.file_sha256 !== a.fileSha256) return;
    const qcFail = a.qc.passed ? null : (a.qc.failCode as string);
    const src = qcFail === null ? await sourceCheck(tx, stemId, a) : null;
    const status: AudioStatus = qcFail !== null ? "QC_FAILED" : src!.result === "BLOCK" ? "BLOCKED" : src!.result === "REVIEW" ? "REVIEW" : "READY";
    await tx.query(
      `UPDATE stem_audio SET status = $2, qc_fail_code = $3, qc_report = $4, source_result = $5, source_report = $6, fingerprint = $7, duration_ms = $8, checked_at = $9
        WHERE stem_id = $1`,
      [stemId, status, qcFail, JSON.stringify({ probe: a.probe, qc: a.qc }), src?.result ?? null, src === null ? null : JSON.stringify(src), a.fingerprint,
        a.probe?.durationMs ?? null, d.clock.now()],
    );
    await invalidateStem(tx, stemId);
    await audit(tx, d.clock, { actor: "system:audio", action: "STEM_AUDIO_CHECKED", entityType: "stem", entityId: stemId, after: { status, qcFail, source: src?.result ?? null } });
  });
}

/** REVIEW 스템의 사람 판단(운영 백오피스 ⑤ 소스 무결성 큐): READY 또는 BLOCKED, 사유 필수. */
export async function reviewStemAudio(tx: Tx, clock: Clock, actor: Actor, input: { stemId: string; decision?: string; reason?: string }) {
  requireRole(actor, "SPACE_OPS");
  if (input.decision !== "READY" && input.decision !== "BLOCKED") throw new DomainError("BAD_REQUEST", 400, "decision must be READY or BLOCKED");
  if (typeof input.reason !== "string" || input.reason.trim() === "") throw new DomainError("BAD_REQUEST", 400, "reason is required");
  const cur = (await tx.query("SELECT status FROM stem_audio WHERE stem_id = $1 FOR UPDATE", [input.stemId])).rows[0];
  if (cur === undefined) throw notFound("stem audio", input.stemId);
  if (cur.status !== "REVIEW") throw conflict("NOT_IN_REVIEW", `stem ${input.stemId} audio is ${cur.status}`);
  const now = clock.now();
  await tx.query("UPDATE stem_audio SET status = $2, reviewed_by = $3, reviewed_at = $4, review_reason = $5 WHERE stem_id = $1", [input.stemId, input.decision, actor.userId, now, input.reason.trim()]);
  await invalidateStem(tx, input.stemId);
  await audit(tx, clock, { actor: actor.userId, action: "STEM_AUDIO_REVIEWED", entityType: "stem", entityId: input.stemId, after: { decision: input.decision, reason: input.reason.trim() } });
  return getStemAudio(tx, input.stemId);
}

/** 상용 음원 대조용 참조 음원 등록(플랫폼). 지문만 보관하고 원본은 저장하지 않는다. */
export async function registerReference(
  tx: Tx, clock: Clock, audio: AudioDeps, actor: Actor,
  input: { referenceId: string; title: string; ownerPartyId?: string; recordingId?: string; bytes: Uint8Array },
) {
  requireRole(actor, "SPACE_OPS");
  const a = await audio.analyzer(input.bytes);
  if (a.fingerprint === null) throw invalid("AUDIO_UNDECODABLE", "reference audio could not be decoded");
  await tx.query(
    `INSERT INTO reference_audio (reference_id, title, owner_party_id, recording_id, file_sha256, fingerprint, duration_ms, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.referenceId, input.title, input.ownerPartyId ?? null, input.recordingId ?? null, a.fileSha256, a.fingerprint, a.probe?.durationMs ?? 0, actor.userId, clock.now()],
  );
  await audit(tx, clock, { actor: actor.userId, action: "REFERENCE_AUDIO_ADD", entityType: "reference_audio", entityId: input.referenceId, after: { title: input.title } });
  return { referenceId: input.referenceId, fileSha256: a.fileSha256, frames: a.fingerprintFrames };
}

function toView(r: any) {
  return {
    stemId: r.stem_id as string, status: r.status as AudioStatus, fileSha256: r.file_sha256 as string, byteSize: Number(r.byte_size), contentType: r.content_type as string,
    uploadedBy: r.uploaded_by as string, uploadedAt: iso(r.uploaded_at)!, durationMs: r.duration_ms as number | null,
    qcFailCode: r.qc_fail_code as string | null, qc: r.qc_report as unknown, sourceResult: r.source_result as string | null, source: r.source_report as unknown,
    checkedAt: r.checked_at === null ? null : iso(r.checked_at)!,
    ...(r.reviewed_by !== null && { review: { by: r.reviewed_by as string, at: iso(r.reviewed_at)!, reason: r.review_reason as string } }),
  };
}

export async function getStemAudio(tx: Tx, stemId: string) {
  const r = (await tx.query("SELECT * FROM stem_audio WHERE stem_id = $1", [stemId])).rows[0];
  if (r === undefined) throw notFound("stem audio", stemId);
  return toView(r);
}

/** ⑤ 오디오 검수 큐: READY가 아닌 스템(검사 대기·QC 실패·검토·차단). status로 거른다. */
export async function listAudioQueue(tx: Tx, status?: string) {
  return (await tx.query(`SELECT * FROM stem_audio WHERE status <> 'READY' ${status ? "AND status = $1" : ""} ORDER BY uploaded_at, stem_id`, status ? [status] : [])).rows.map(toView);
}
