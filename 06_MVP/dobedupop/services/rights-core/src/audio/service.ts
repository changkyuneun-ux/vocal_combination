import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Db, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { Jobs } from "../platform/jobs.ts";
import type { AudioDeps } from "./deps.ts";
import { sourceCheck } from "./source.ts";
import { invalidateStem } from "../decisions/cache.ts";
import { requirePermission } from "../platform/permissions.ts";

export type AudioStatus = "PENDING" | "READY" | "QC_FAILED" | "REVIEW" | "BLOCKED";
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * 스템 오디오 올리기(권리자 포털·운영): 원본을 저장하고 검사 작업(audio-check)을 큐에 넣는다. 결과가 나올 때까지 PENDING이고,
 * PENDING·QC_FAILED·REVIEW·BLOCKED 스템은 발행되지 않는다. 다시 올리면 이전 결과를 지우고 다시 검사한다.
 */
export async function uploadStemAudio(
  tx: Tx, clock: Clock, jobs: Jobs, audio: AudioDeps, actor: Actor, input: { stemId: string; bytes: Uint8Array; contentType: string },
) {
  requirePermission(actor, "rights.edit");
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_BYTES) throw invalid("AUDIO_SIZE", `audio must be 1..${MAX_BYTES} bytes`);
  if ((await tx.query("SELECT 1 FROM stem WHERE stem_id = $1", [input.stemId])).rowCount === 0) throw notFound("stem", input.stemId);
  const { sha256, uri } = await audio.store.put(input.bytes);
  const now = clock.now();
  // IR에 든 스템의 쓰던(READY) 오디오를 바꾸면 새 버전으로 대기한다(0047): 다음 재고정 때 쓰는 오디오가 되고, 이미 발행된 조합(렌더 결과)은 그대로다.
  const sealedInUse = (await tx.query(
    `SELECT 1 FROM stem_audio a JOIN stem st ON st.stem_id = a.stem_id JOIN recording_version r ON r.recording_id = st.recording_id JOIN facts_scope s ON s.work_id = r.work_id
      WHERE a.stem_id = $1 AND a.status = 'READY' AND s.sealed_through IS NOT NULL AND st.created_at <= s.sealed_through`, [input.stemId])).rowCount !== 0;
  if (sealedInUse) {
    await tx.query(
      `INSERT INTO stem_audio_next (stem_id, file_sha256, byte_size, content_type, storage_uri, uploaded_by, uploaded_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')
       ON CONFLICT (stem_id) DO UPDATE SET file_sha256 = EXCLUDED.file_sha256, byte_size = EXCLUDED.byte_size, content_type = EXCLUDED.content_type,
         storage_uri = EXCLUDED.storage_uri, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = EXCLUDED.uploaded_at, status = 'PENDING',
         qc_fail_code = NULL, qc_report = NULL, source_result = NULL, source_report = NULL, fingerprint = NULL, duration_ms = NULL, checked_at = NULL`,
      [input.stemId, sha256, input.bytes.byteLength, input.contentType, uri, actor.userId, now]);
    await audit(tx, clock, { actor: actor.userId, action: "STEM_AUDIO_NEXT_UPLOAD", entityType: "stem", entityId: input.stemId, after: { fileSha256: sha256, byteSize: input.bytes.byteLength } });
    await jobs.send(tx, "audio-check", { stemId: input.stemId, next: "1" });
    return { stemId: input.stemId, status: "PENDING" as const, fileSha256: sha256, next: true };
  }
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
export async function checkStemAudio(d: { db: Db; clock: Clock; audio: AudioDeps }, stemId: string, next = false): Promise<void> {
  const table = next ? "stem_audio_next" : "stem_audio"; // 대기 중인 새 버전(0047)도 같은 검사를 받는다
  const row = (await d.db.pool.query(`SELECT storage_uri, file_sha256, status FROM ${table} WHERE stem_id = $1`, [stemId])).rows[0];
  if (row === undefined || row.status !== "PENDING") return;
  const a = await d.audio.analyzer(await d.audio.store.get(row.storage_uri as string));
  await d.db.tx(async (tx) => {
    const cur = (await tx.query(`SELECT file_sha256, status FROM ${table} WHERE stem_id = $1 FOR UPDATE`, [stemId])).rows[0];
    if (cur === undefined || cur.status !== "PENDING" || cur.file_sha256 !== a.fileSha256) return;
    const qcFail = a.qc.passed ? null : (a.qc.failCode as string);
    const src = qcFail === null ? await sourceCheck(tx, stemId, a) : null;
    const status: AudioStatus = qcFail !== null ? "QC_FAILED" : src!.result === "BLOCK" ? "BLOCKED" : src!.result === "REVIEW" ? "REVIEW" : "READY";
    await tx.query(
      `UPDATE ${table} SET status = $2, qc_fail_code = $3, qc_report = $4, source_result = $5, source_report = $6, fingerprint = $7, duration_ms = $8, checked_at = $9
        WHERE stem_id = $1`,
      [stemId, status, qcFail, JSON.stringify({ probe: a.probe, qc: a.qc }), src?.result ?? null, src === null ? null : JSON.stringify(src), a.fingerprint,
        a.probe?.durationMs ?? null, d.clock.now()],
    );
    if (!next) await invalidateStem(tx, stemId);
    await audit(tx, d.clock, { actor: "system:audio", action: next ? "STEM_AUDIO_NEXT_CHECKED" : "STEM_AUDIO_CHECKED", entityType: "stem", entityId: stemId, after: { status, qcFail, source: src?.result ?? null } });
  });
}

/** REVIEW 스템의 사람 판단(운영 백오피스 ⑤ 소스 무결성 큐): READY 또는 BLOCKED, 사유 필수. */
export async function reviewStemAudio(tx: Tx, clock: Clock, actor: Actor, input: { stemId: string; decision?: string; reason?: string }) {
  requirePermission(actor, "audio.review");
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
  requirePermission(actor, "audio.review");
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

const nextView = (n: any) => (n === undefined || n === null ? null : { status: n.status as AudioStatus, fileSha256: n.file_sha256 as string, uploadedAt: iso(n.uploaded_at)!, qcFailCode: n.qc_fail_code as string | null });

export async function getStemAudio(tx: Tx, stemId: string) {
  const r = (await tx.query("SELECT * FROM stem_audio WHERE stem_id = $1", [stemId])).rows[0];
  if (r === undefined) throw notFound("stem audio", stemId);
  const n = (await tx.query("SELECT * FROM stem_audio_next WHERE stem_id = $1", [stemId])).rows[0];
  return { ...toView(r), next: nextView(n) };
}

/**
 * 대기 중인 오디오 새 버전을 쓰는 오디오로(0047): 분배 규칙을 다시 고정(컴파일·재고정)할 때 그 시각까지 올라와 READY인 것만.
 * 이전 오디오는 stem_audio_history에 남는다. 이미 발행된 조합은 발행 때 만든 렌더 결과를 그대로 쓴다. 바꾼 스템 수를 돌려준다.
 */
export async function promoteStagedAudio(tx: Tx, clock: Clock, scopeId: string, knownAt: string): Promise<number> {
  const rows = (await tx.query(
    `SELECT n.* FROM stem_audio_next n JOIN stem st ON st.stem_id = n.stem_id JOIN recording_version r ON r.recording_id = st.recording_id
       JOIN facts_scope s ON s.work_id = r.work_id WHERE s.facts_scope_id = $1 AND n.status = 'READY' AND n.uploaded_at <= $2 ORDER BY n.stem_id`, [scopeId, knownAt])).rows;
  for (const n of rows) {
    await tx.query(`INSERT INTO stem_audio_history (stem_id, file_sha256, storage_uri, duration_ms, uploaded_at, replaced_at)
                    SELECT stem_id, file_sha256, storage_uri, duration_ms, uploaded_at, $2 FROM stem_audio WHERE stem_id = $1`, [n.stem_id, clock.now()]);
    await tx.query(
      `UPDATE stem_audio SET file_sha256 = $2, byte_size = $3, content_type = $4, storage_uri = $5, uploaded_by = $6, uploaded_at = $7, status = 'READY',
         qc_fail_code = NULL, qc_report = $8, source_result = $9, source_report = $10, fingerprint = $11, duration_ms = $12, checked_at = $13,
         reviewed_by = NULL, reviewed_at = NULL, review_reason = NULL WHERE stem_id = $1`,
      [n.stem_id, n.file_sha256, n.byte_size, n.content_type, n.storage_uri, n.uploaded_by, n.uploaded_at, n.qc_report, n.source_result, n.source_report, n.fingerprint, n.duration_ms, n.checked_at]);
    await tx.query("DELETE FROM stem_audio_next WHERE stem_id = $1", [n.stem_id]);
    await invalidateStem(tx, n.stem_id);
    await audit(tx, clock, { actor: "system:audio", action: "STEM_AUDIO_PROMOTED", entityType: "stem", entityId: n.stem_id, after: { fileSha256: n.file_sha256, knownAt } });
  }
  return rows.length;
}

/** 곡의 스템 오디오 상태를 한 번에(화면이 스템마다 묻지 않게). 오디오가 없는 스템은 목록에 없다. */
export async function listScopeStemAudio(tx: Tx, scopeId: string) {
  const rows = (await tx.query(
    `SELECT a.*, to_jsonb(n) AS next_row FROM stem_audio a JOIN stem st ON st.stem_id = a.stem_id JOIN recording_version r ON r.recording_id = st.recording_id
       JOIN facts_scope s ON s.work_id = r.work_id LEFT JOIN stem_audio_next n ON n.stem_id = a.stem_id WHERE s.facts_scope_id = $1 ORDER BY a.stem_id`, [scopeId])).rows;
  return rows.map((r) => ({ ...toView(r), next: nextView(r.next_row === null ? null : { ...r.next_row, uploaded_at: new Date(r.next_row.uploaded_at) }) }));
}

/** ⑤ 오디오 검수 큐: READY가 아닌 스템(검사 대기·QC 실패·검토·차단). status로 거른다. */
export async function listAudioQueue(tx: Tx, status?: string) {
  return (await tx.query(`SELECT * FROM stem_audio WHERE status <> 'READY' ${status ? "AND status = $1" : ""} ORDER BY uploaded_at, stem_id`, status ? [status] : [])).rows.map(toView);
}
