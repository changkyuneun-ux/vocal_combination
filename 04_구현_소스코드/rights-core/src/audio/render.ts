import { createHash } from "node:crypto";
import type { RenderPart } from "audio-service";
import { requireRole, withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Db, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { Jobs } from "../platform/jobs.ts";
import type { AudioDeps, Renderer } from "./deps.ts";
import { assertExposed } from "../exposure/service.ts";

/**
 * 조합 렌더링(다음 작업 10). 렌더 입력은 발행 봉인과 같은 트랜잭션에 동결된 스템 배정(snapshot_stem_assignment)이다.
 * 그래서 렌더 결과가 봉인된 배정과 일치하는지 다시 렌더해 확인할 수 있다. 정산은 렌더 결과를 쓰지 않는다.
 */

type Assigned = { slot_id: string; stem_id: string; start_ms: number; end_ms: number; status: string | null; storage_uri: string | null; file_sha256: string | null };

async function assignments(tx: Tx, snapshotId: string): Promise<Assigned[]> {
  return (await tx.query(
    `SELECT a.slot_id, a.stem_id, a.start_ms, a.end_ms, s.status, s.storage_uri, s.file_sha256
       FROM snapshot_stem_assignment a LEFT JOIN stem_audio s ON s.stem_id = a.stem_id WHERE a.snapshot_id = $1 ORDER BY a.start_ms, a.slot_id`, [snapshotId])).rows;
}

/** 렌더 입력 요약(슬롯·구간·파일 해시). 같은 요약이면 같은 렌더가 나와야 한다. */
function inputSha(rows: Assigned[]): string {
  return createHash("sha256").update(JSON.stringify(rows.map((r) => [r.slot_id, r.start_ms, r.end_ms, r.file_sha256]))).digest("hex");
}

async function partsOf(audio: AudioDeps, rows: Assigned[]): Promise<RenderPart[]> {
  return Promise.all(rows.map(async (r) => ({ bytes: await audio.store.get(r.storage_uri!), startMs: r.start_ms, endMs: r.end_ms })));
}

function rendererOf(audio: AudioDeps | undefined): { audio: AudioDeps; renderer: Renderer } {
  if (audio?.renderer === undefined) throw new DomainError("RENDER_NOT_CONFIGURED", 503, "rendering is not configured");
  return { audio, renderer: audio.renderer };
}

/** 발행 직후(같은 트랜잭션): 마스터 렌더를 예약한다. 워터마크 ID는 발행 봉인마다 하나다. */
export async function queueRender(tx: Tx, clock: Clock, jobs: Jobs, snapshotId: string): Promise<void> {
  await tx.query("INSERT INTO combination_render (snapshot_id, status, watermark_id, created_at) VALUES ($1,'PENDING',$2,$3)", [snapshotId, `wm_${snapshotId}`, clock.now()]);
  await jobs.send(tx, "render-master", { snapshotId });
}

/** 마스터 렌더 작업(워커). 오디오 없는 스템이 섞여 있으면 SKIPPED, 렌더 오류는 FAILED(⑤ 렌더 무결성 큐). */
export async function renderMaster(d: { db: Db; clock: Clock; audio: AudioDeps }, snapshotId: string): Promise<void> {
  const { renderer } = rendererOf(d.audio);
  const row = (await d.db.pool.query("SELECT status, watermark_id FROM combination_render WHERE snapshot_id = $1", [snapshotId])).rows[0];
  if (row === undefined || row.status !== "PENDING") return;
  const rows = await d.db.tx((tx) => assignments(tx, snapshotId));
  const missing = rows.filter((r) => r.storage_uri === null || r.status !== "READY");
  if (missing.length > 0) {
    await d.db.tx((tx) => tx.query("UPDATE combination_render SET status = 'SKIPPED', error = $2 WHERE snapshot_id = $1 AND status = 'PENDING'",
      [snapshotId, `no ready audio for ${missing.map((m) => m.stem_id).join(", ")}`]));
    return;
  }
  try {
    const out = await renderer.render({ parts: await partsOf(d.audio, rows), mode: "master", watermarkId: row.watermark_id as string });
    const stored = await d.audio.store.put(out.bytes);
    await d.db.tx(async (tx) => {
      await tx.query(
        `UPDATE combination_render SET status = 'RENDERED', input_sha256 = $2, render_sha256 = $3, storage_uri = $4, duration_ms = $5, rendered_at = $6
          WHERE snapshot_id = $1 AND status = 'PENDING'`,
        [snapshotId, inputSha(rows), out.sha256, stored.uri, out.durationMs, d.clock.now()]);
      await audit(tx, d.clock, { actor: "system:render", action: "COMBINATION_RENDERED", entityType: "rights_snapshot", entityId: snapshotId, after: { renderSha256: out.sha256, watermarkId: row.watermark_id } });
    });
  } catch (e) {
    await d.db.tx((tx) => tx.query("UPDATE combination_render SET status = 'FAILED', error = $2 WHERE snapshot_id = $1 AND status = 'PENDING'",
      [snapshotId, e instanceof Error ? e.message.slice(0, 500) : String(e)]));
  }
}

/**
 * 렌더 무결성 검증(운영): 봉인된 배정으로 다시 렌더해 해시가 같은지, 저장된 마스터에서 이 조합의 워터마크가 읽히는지 본다.
 * 결과는 MATCH · MISMATCH(입력이나 결과가 다름) · WATERMARK_MISSING.
 */
export async function verifyRender(tx: Tx, clock: Clock, audio: AudioDeps | undefined, actor: Actor, snapshotId: string) {
  requireRole(actor, "SPACE_OPS");
  const { renderer } = rendererOf(audio);
  const row = (await tx.query("SELECT * FROM combination_render WHERE snapshot_id = $1 FOR UPDATE", [snapshotId])).rows[0];
  if (row === undefined) throw notFound("render", snapshotId);
  if (row.status !== "RENDERED") throw conflict("NOT_RENDERED", `render of ${snapshotId} is ${row.status}`);
  const rows = await assignments(tx, snapshotId);
  const sameInput = inputSha(rows) === row.input_sha256;
  const again = sameInput ? await renderer.render({ parts: await partsOf(audio!, rows), mode: "master", watermarkId: row.watermark_id as string }) : null;
  const mark = await renderer.readWatermark(await audio!.store.get(row.storage_uri as string));
  const result = again === null || again.sha256 !== row.render_sha256 ? "MISMATCH" : mark !== renderer.watermarkBits(row.watermark_id as string) ? "WATERMARK_MISSING" : "MATCH";
  await tx.query("UPDATE combination_render SET verified_at = $2, verify_result = $3 WHERE snapshot_id = $1", [snapshotId, clock.now(), result]);
  await audit(tx, clock, { actor: actor.userId, action: "RENDER_VERIFIED", entityType: "rights_snapshot", entityId: snapshotId, after: { result, sameInput } });
  return { snapshotId, result, sameInput, renderSha256: row.render_sha256 as string, watermarkId: row.watermark_id as string };
}

export async function getRender(tx: Tx, snapshotId: string) {
  const r = (await tx.query("SELECT * FROM combination_render WHERE snapshot_id = $1", [snapshotId])).rows[0];
  if (r === undefined) throw notFound("render", snapshotId);
  return {
    snapshotId, status: r.status as string, watermarkId: r.watermark_id as string, renderSha256: r.render_sha256 as string | null, durationMs: r.duration_ms as number | null,
    error: r.error as string | null, renderedAt: r.rendered_at === null ? null : iso(r.rendered_at)!, verifyResult: r.verify_result as string | null,
  };
}

/**
 * 미리듣기(팬 앱, 발행 전): 활성 팩에서 고른 배치를 5초 렌더한다. 모든 스템에 READY 오디오가 있어야 한다.
 * 원본 스템이 아니라 렌더 결과(MP3)만 나간다. 팩 원본 행은 팬에게 보이지 않으므로 system 범위로 읽는다.
 */
export async function renderPreview(tx: Tx, audio: AudioDeps | undefined, input: { packId?: unknown; assignments?: unknown }) {
  const { renderer } = rendererOf(audio);
  if (typeof input.packId !== "string" || !Array.isArray(input.assignments) || input.assignments.length === 0) throw new DomainError("BAD_REQUEST", 400, "packId and assignments are required");
  const picks = input.assignments as { slotId: string; stemId: string }[];
  const rows = await withSystemScope(tx, async () => (await tx.query(
    `SELECT sl.slot_id, st.stem_id, sl.start_ms, sl.end_ms, a.status, a.storage_uri, a.file_sha256
       FROM vocal_pack p JOIN facts_scope f ON f.facts_scope_id = p.facts_scope_id JOIN recording_version r ON r.work_id = f.work_id
       JOIN part_slot sl ON sl.recording_id = r.recording_id JOIN stem st ON st.slot_id = sl.slot_id LEFT JOIN stem_audio a ON a.stem_id = st.stem_id
      WHERE p.pack_id = $1 AND p.status = 'ACTIVE' AND (sl.slot_id, st.stem_id) IN (SELECT * FROM unnest($2::text[], $3::text[]))
      ORDER BY sl.start_ms, sl.slot_id`,
    [input.packId, picks.map((p) => p.slotId), picks.map((p) => p.stemId)])).rows as Assigned[]);
  if (rows.length !== picks.length) throw invalid("INVALID_PREVIEW", "every assignment must be a stem of that slot in an active pack");
  const missing = rows.filter((r) => r.status !== "READY");
  if (missing.length > 0) throw conflict("PREVIEW_UNAVAILABLE", `no ready audio for ${missing.map((m) => m.stem_id).join(", ")}`);
  return renderer.render({ parts: await partsOf(audio!, rows), mode: "preview" });
}

/** 팬이 자기 조합의 마스터 렌더를 받는다(발행자 = 본인, RENDERED). 원본 스템은 주지 않는다. */
export async function fanRenderFile(tx: Tx, audio: AudioDeps | undefined, userId: string, vcId: string): Promise<Uint8Array> {
  if (audio === undefined) throw new DomainError("RENDER_NOT_CONFIGURED", 503, "rendering is not configured");
  const r = await withSystemScope(tx, async () => (await tx.query(
    `SELECT c.status, c.storage_uri FROM rights_snapshot s JOIN combination_render c ON c.snapshot_id = s.snapshot_id WHERE s.vc_id = $1 AND s.issued_by = $2`, [vcId, userId])).rows[0]);
  if (r === undefined) throw notFound("combination", vcId);
  await assertExposed(tx, vcId); // 동의 철회로 노출이 멈춘 조합은 받을 수 없다(410)
  if (r.status !== "RENDERED") throw conflict("NOT_RENDERED", `render of ${vcId} is ${r.status}`);
  return audio.store.get(r.storage_uri as string);
}
