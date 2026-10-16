import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./ffmpeg.ts";
import { embedWatermark, WM } from "./watermark.ts";

/** 조합의 한 파트: 이 스템 파일의 앞에서 (endMs − startMs)만큼을 곡의 startMs 자리에 놓는다. */
export type RenderPart = { bytes: Uint8Array; startMs: number; endMs: number };
export type RenderInput = { parts: RenderPart[]; mode: "preview" | "master"; previewMs?: number; watermarkId?: string };
export type Rendered = { bytes: Buffer; sha256: string; contentType: string; durationMs: number };

const SR = WM.sampleRate;

/**
 * 조합 렌더링(서버 믹스다운). 원본 스템은 이 서비스 밖으로 나가지 않고, 결과물만 돌려준다.
 * - preview: 앞에서 previewMs(기본 5초)만, 끝 0.5초 페이드아웃, MP3 128k. 워터마크 없음.
 * - master: 전체, 리미터(−1dBFS), 워터마크(watermarkId), WAV 48kHz 24비트.
 * 같은 입력이면 같은 바이트가 나온다(렌더 무결성 검증이 다시 렌더해 해시를 비교한다).
 */
export async function render(input: RenderInput): Promise<Rendered> {
  if (input.parts.length === 0) throw new Error("RENDER_EMPTY: no parts");
  const dir = await mkdtemp(join(tmpdir(), "render-"));
  try {
    const files: string[] = [];
    for (const [i, p] of input.parts.entries()) {
      const f = join(dir, `p${i}-${randomBytes(3).toString("hex")}`);
      await writeFile(f, p.bytes);
      files.push(f);
    }
    const chains = input.parts.map((p, i) =>
      `[${i}:a]aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${(p.endMs - p.startMs) / 1000},asetpts=PTS-STARTPTS,adelay=${p.startMs}|${p.startMs}[a${i}]`);
    const mix = `${input.parts.map((_, i) => `[a${i}]`).join("")}amix=inputs=${input.parts.length}:normalize=0:dropout_transition=0[m]`;
    const previewSec = (input.previewMs ?? 5000) / 1000;
    const tail = input.mode === "preview"
      ? `[m]atrim=0:${previewSec},afade=t=out:st=${Math.max(0, previewSec - 0.5)}:d=0.5[o]`
      : "[m]alimiter=limit=0.89:level=false[o]";
    const args = ["-hide_banner", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex", [...chains, mix, tail].join(";"), "-map", "[o]", "-ac", "2", "-ar", String(SR)];
    if (input.mode === "preview") {
      const r = await run("ffmpeg", [...args, "-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", "pipe:1"]);
      if (r.code !== 0) throw new Error(`RENDER_FAILED: ${r.stderr.trim()}`);
      return { bytes: r.stdout, sha256: sha(r.stdout), contentType: "audio/mpeg", durationMs: Math.round(previewSec * 1000) };
    }
    const raw = await run("ffmpeg", [...args, "-f", "f32le", "pipe:1"]);
    if (raw.code !== 0) throw new Error(`RENDER_FAILED: ${raw.stderr.trim()}`);
    const pcm = new Float32Array(raw.stdout.buffer.slice(raw.stdout.byteOffset, raw.stdout.byteOffset + raw.stdout.byteLength - (raw.stdout.byteLength % 4)));
    if (input.watermarkId !== undefined) embedWatermark(pcm, 2, input.watermarkId);
    const wav = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", "pipe:0", "-c:a", "pcm_s24le", "-bitexact", "-f", "wav", "pipe:1"],
      Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    if (wav.code !== 0) throw new Error(`RENDER_FAILED: ${wav.stderr.trim()}`);
    return { bytes: wav.stdout, sha256: sha(wav.stdout), contentType: "audio/wav", durationMs: Math.round((pcm.length / 2 / SR) * 1000) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 렌더 결과에서 워터마크를 읽는다(48kHz 모노로 디코딩). */
export async function decodeForWatermark(bytes: Uint8Array): Promise<Float32Array> {
  const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1"], bytes);
  if (r.code !== 0) throw new Error(`DECODE_ERROR: ${r.stderr.trim()}`);
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength - (r.stdout.byteLength % 4)));
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
